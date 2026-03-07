import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(() => ''),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  writeConfigSnapshot,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  ContainerOutput,
  CLEANUP_INTERVAL_MS,
  _resetCleanupTimer,
} from './container-runner.js';
import { execSync } from 'child_process';
import fs from 'fs';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

// --- writeConfigSnapshot tests ---

describe('writeConfigSnapshot', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockClear().mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockClear().mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockClear();
  });

  it('writes redacted config for secret keys', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'TELEGRAM_BOT_TOKEN=secret123\nSOME_KEY=visible\n',
    );

    writeConfigSnapshot('test-group');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    // Find the call that writes config_snapshot.json
    const snapshotCall = writeCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('config_snapshot.json'),
    );
    expect(snapshotCall).toBeDefined();
    const written = JSON.parse(snapshotCall![1] as string);
    expect(written.TELEGRAM_BOT_TOKEN).toBe('***REDACTED***');
    expect(written.SOME_KEY).toBe('visible');
  });

  it('skips when no .env file exists', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    writeConfigSnapshot('test-group');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const snapshotCall = writeCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('config_snapshot.json'),
    );
    expect(snapshotCall).toBeUndefined();
  });

  it('strips quotes from .env values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'MY_KEY="quoted value"\nOTHER=\'single quoted\'\n',
    );

    writeConfigSnapshot('test-group');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const snapshotCall = writeCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('config_snapshot.json'),
    );
    expect(snapshotCall).toBeDefined();
    const written = JSON.parse(snapshotCall![1] as string);
    expect(written.MY_KEY).toBe('quoted value');
    expect(written.OTHER).toBe('single quoted');
  });

  it('redacts OPENAI_API_KEY', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'OPENAI_API_KEY=sk-test-1234\nSOME_KEY=visible\n',
    );

    writeConfigSnapshot('test-group');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const snapshotCall = writeCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('config_snapshot.json'),
    );
    expect(snapshotCall).toBeDefined();
    const written = JSON.parse(snapshotCall![1] as string);
    expect(written.OPENAI_API_KEY).toBe('***REDACTED***');
    expect(written.SOME_KEY).toBe('visible');
  });
});

// --- writeTasksSnapshot tests ---

describe('writeTasksSnapshot', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockClear().mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockClear().mockReturnValue(undefined);
  });

  const allTasks = [
    {
      id: 'task-1',
      groupFolder: 'group-a',
      prompt: 'do A',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      status: 'active',
      next_run: '2025-06-01T00:00:00.000Z',
    },
    {
      id: 'task-2',
      groupFolder: 'group-b',
      prompt: 'do B',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      status: 'active',
      next_run: '2025-06-02T09:00:00.000Z',
    },
  ];

  it('filters tasks for non-main group', () => {
    writeTasksSnapshot('group-a', false, allTasks);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tasksCall = writeCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('current_tasks.json'),
    );
    expect(tasksCall).toBeDefined();
    const written = JSON.parse(tasksCall![1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('task-1');
    expect(written[0].groupFolder).toBe('group-a');
  });

  it('shows all tasks for main group', () => {
    writeTasksSnapshot('group-a', true, allTasks);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tasksCall = writeCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('current_tasks.json'),
    );
    expect(tasksCall).toBeDefined();
    const written = JSON.parse(tasksCall![1] as string);
    expect(written).toHaveLength(2);
  });
});

// --- writeGroupsSnapshot tests ---

describe('writeGroupsSnapshot', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockClear().mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockClear().mockReturnValue(undefined);
  });

  const availableGroups = [
    {
      jid: 'g1@g.us',
      name: 'Group 1',
      lastActivity: '2025-01-01T00:00:00.000Z',
      isRegistered: true,
    },
    {
      jid: 'g2@g.us',
      name: 'Group 2',
      lastActivity: '2025-01-02T00:00:00.000Z',
      isRegistered: false,
    },
  ];

  it('shows all groups for main, empty for non-main', () => {
    // Main sees all
    writeGroupsSnapshot(
      'main-group',
      true,
      availableGroups,
      new Set(['g1@g.us']),
    );

    const writeCallsMain = vi.mocked(fs.writeFileSync).mock.calls;
    const mainCall = writeCallsMain.find(
      (c) => typeof c[0] === 'string' && c[0].includes('available_groups.json'),
    );
    expect(mainCall).toBeDefined();
    const mainWritten = JSON.parse(mainCall![1] as string);
    expect(mainWritten.groups).toHaveLength(2);
    expect(mainWritten.lastSync).toBeDefined();

    vi.mocked(fs.writeFileSync).mockClear();

    // Non-main sees empty
    writeGroupsSnapshot(
      'other-group',
      false,
      availableGroups,
      new Set(['g1@g.us']),
    );

    const writeCallsOther = vi.mocked(fs.writeFileSync).mock.calls;
    const otherCall = writeCallsOther.find(
      (c) => typeof c[0] === 'string' && c[0].includes('available_groups.json'),
    );
    expect(otherCall).toBeDefined();
    const otherWritten = JSON.parse(otherCall![1] as string);
    expect(otherWritten.groups).toHaveLength(0);
  });
});

// --- Cleanup throttle tests ---

describe('cleanup throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCleanupTimer();
    fakeProc = createFakeProcess();
    vi.mocked(execSync).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs cleanup on first call', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Emit output and close immediately
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'ok' })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // execSync should have been called for cleanup (2 status checks: 'created' and 'dead')
    expect(vi.mocked(execSync).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips cleanup on second call within interval', async () => {
    // First call
    let resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'ok' })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const callsAfterFirst = vi.mocked(execSync).mock.calls.length;

    // Second call within interval
    fakeProc = createFakeProcess();
    resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'ok' })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // No additional execSync calls for cleanup
    expect(vi.mocked(execSync).mock.calls.length).toBe(callsAfterFirst);
  });

  it('runs cleanup again after interval expires', async () => {
    // First call
    let resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'ok' })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const callsAfterFirst = vi.mocked(execSync).mock.calls.length;

    // Advance past the cleanup interval
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS + 1);

    // Third call — should run cleanup again
    fakeProc = createFakeProcess();
    resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'ok' })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(vi.mocked(execSync).mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
  });
});
