import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  _getTestDb,
  _initTestDatabase,
  createTask,
  getDueTasks,
  getTaskById,
} from './db.js';
import { runContainerAgent } from './container-runner.js';
import { logger } from './logger.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
  SchedulerDependencies,
} from './task-scheduler.js';
import { ScheduledTask, TaskRunLog } from './types.js';

function makeDeps(
  overrides: Partial<SchedulerDependencies> = {},
): SchedulerDependencies {
  const enqueueTask = vi.fn(
    (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
      void fn();
    },
  );
  return {
    registeredGroups: () => ({}),
    getSessions: () => ({}),
    queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function getTaskRunLogs(taskId: string): TaskRunLog[] {
  const db = _getTestDb();
  return db
    .prepare('SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at')
    .all(taskId) as TaskRunLog[];
}

/** Create a task that is already due (next_run in the past). */
function createDueTask(
  overrides: Partial<Omit<ScheduledTask, 'last_run' | 'last_result'>> = {},
) {
  const defaults: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
    id: 'task-1',
    group_folder: 'test-group',
    chat_jid: 'chat@g.us',
    prompt: 'do something',
    schedule_type: 'once',
    schedule_value: '2026-02-22T00:00:00.000Z',
    context_mode: 'isolated',
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'active',
    created_at: '2026-02-22T00:00:00.000Z',
  };
  createTask({ ...defaults, ...overrides });
}

/** Deps where the group matches the task's group_folder. */
function depsWithGroup(
  folder = 'test-group',
  overrides: Partial<SchedulerDependencies> = {},
): SchedulerDependencies {
  return makeDeps({
    registeredGroups: () => ({
      someJid: {
        name: 'Test Group',
        folder,
        trigger: '@bot',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    }),
    ...overrides,
  });
}

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.mocked(runContainerAgent).mockReset();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createDueTask({ id: 'task-invalid-folder', group_folder: '../../outside' });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('startSchedulerLoop guard prevents double-start', async () => {
    createDueTask({ id: 'task-guard' });

    const deps = depsWithGroup();
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'sid-1',
    });

    startSchedulerLoop(deps);
    startSchedulerLoop(deps); // second call should be no-op

    await vi.advanceTimersByTimeAsync(10);

    // getDueTasks was only called once (from a single loop), not doubled
    const enqueueTask = vi.mocked(deps.queue.enqueueTask);
    expect(enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('runTask computes next_run for cron tasks', async () => {
    // Set "now" to a known time: 2026-03-05T10:00:00Z
    vi.setSystemTime(new Date('2026-03-05T10:00:00Z'));

    createDueTask({
      id: 'task-cron',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *', // daily at 9 AM
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'cron done',
      newSessionId: 'sid-1',
    });

    const deps = depsWithGroup();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-cron');
    expect(task).toBeDefined();
    expect(task!.next_run).toBeTruthy();

    // The next 9 AM occurrence should be tomorrow (2026-03-06 09:00 in the configured timezone)
    const nextRun = new Date(task!.next_run!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    // Should include hour 9 in UTC (or offset depending on TIMEZONE, but the cron parser uses the configured tz)
    expect(task!.status).toBe('active'); // cron tasks stay active
  });

  it('runTask computes next_run for interval tasks', async () => {
    vi.setSystemTime(new Date('2026-03-05T10:00:00Z'));
    const now = Date.now();

    createDueTask({
      id: 'task-interval',
      schedule_type: 'interval',
      schedule_value: '60000', // 60 seconds
      next_run: new Date(now - 60_000).toISOString(),
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'interval done',
      newSessionId: 'sid-1',
    });

    const deps = depsWithGroup();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-interval');
    expect(task).toBeDefined();
    expect(task!.next_run).toBeTruthy();

    const nextRun = new Date(task!.next_run!).getTime();
    // next_run should be approximately now + 60000ms
    expect(nextRun).toBeGreaterThanOrEqual(now + 60000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(now + 60000 + 1000);
    expect(task!.status).toBe('active'); // interval tasks stay active
  });

  it('runTask marks once tasks as completed', async () => {
    createDueTask({
      id: 'task-once',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'once done',
      newSessionId: 'sid-1',
    });

    const deps = depsWithGroup();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-once');
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
    expect(task!.next_run).toBeNull();
  });

  it('runTask logs error when group not found', async () => {
    createDueTask({
      id: 'task-no-group',
      group_folder: 'nonexistent-group',
    });

    // registeredGroups returns empty, so no group matches
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-no-group',
        groupFolder: 'nonexistent-group',
      }),
      'Group not found for task',
    );

    const logs = getTaskRunLogs('task-no-group');
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('error');
    expect(logs[0].error).toContain('Group not found');
  });

  it('runTask sends result via sendMessage', async () => {
    createDueTask({ id: 'task-send', chat_jid: 'dest@g.us' });

    const sendMessage = vi.fn().mockResolvedValue(undefined);

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: 'hello from task' });
        }
        return {
          status: 'success' as const,
          result: 'hello from task',
          newSessionId: 'sid-1',
        };
      },
    );

    const deps = depsWithGroup('test-group', { sendMessage });
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledWith('dest@g.us', 'hello from task');
  });

  it('runTask records duration in task run log', async () => {
    vi.setSystemTime(new Date('2026-03-05T10:00:00Z'));

    createDueTask({ id: 'task-duration' });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'done',
      newSessionId: 'sid-1',
    });

    const deps = depsWithGroup();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    const logs = getTaskRunLogs('task-duration');
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('success');
    expect(typeof logs[0].duration_ms).toBe('number');
    expect(logs[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('runTask passes model and maxThinkingTokens to runContainerAgent', async () => {
    createDueTask({
      id: 'task-model-pass',
      model: 'claude-sonnet-4-20250514',
      max_thinking_tokens: 5000,
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'model done',
      newSessionId: 'sid-1',
    });

    const deps = depsWithGroup();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    const input = vi.mocked(runContainerAgent).mock.calls[0][1];
    expect(input.model).toBe('claude-sonnet-4-20250514');
    expect(input.maxThinkingTokens).toBe(5000);
  });

  it('handles container agent errors gracefully', async () => {
    createDueTask({ id: 'task-error' });

    vi.mocked(runContainerAgent).mockRejectedValue(
      new Error('container crashed'),
    );

    const deps = depsWithGroup();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    const logs = getTaskRunLogs('task-error');
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('error');
    expect(logs[0].error).toBe('container crashed');

    // Task should still exist and not be stuck
    const task = getTaskById('task-error');
    expect(task).toBeDefined();
  });
});
