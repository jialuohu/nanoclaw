import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_ALLOWLIST_PATH = '/tmp/test-mount-allowlist.json';

// Mock pino (mount-security creates its own logger)
vi.mock('pino', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { default: vi.fn(() => mockLogger) };
});

// Mock config
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/tmp/test-mount-allowlist.json',
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      realpathSync: vi.fn((p: string) => p),
    },
  };
});

// Helper to build a valid allowlist JSON
function makeAllowlist(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    allowedRoots: [
      {
        path: '/home/user/projects',
        allowReadWrite: true,
        description: 'Dev projects',
      },
    ],
    blockedPatterns: [],
    nonMainReadOnly: true,
    ...overrides,
  });
}

async function freshImport() {
  vi.resetModules();
  // Re-apply mocks after resetModules
  vi.doMock('pino', () => {
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    return { default: vi.fn(() => mockLogger) };
  });
  vi.doMock('./config.js', () => ({
    MOUNT_ALLOWLIST_PATH: TEST_ALLOWLIST_PATH,
  }));
  const mod = await import('./mount-security.js');
  return mod;
}

// Get the mocked fs for setting up per-test behavior
import fs from 'fs';
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockRealpathSync = vi.mocked(fs.realpathSync);

describe('mount-security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks mount when containerPath contains ..', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      { hostPath: '/home/user/projects/repo', containerPath: '../escape' },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('blocks mount when containerPath is absolute', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      { hostPath: '/home/user/projects/repo', containerPath: '/etc/shadow' },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('blocks mount when containerPath is whitespace-only', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      { hostPath: '/home/user/projects/repo', containerPath: '   ' },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it("blocks mount when hostPath doesn't exist", async () => {
    const { validateMount } = await freshImport();
    // allowlist file exists
    mockExistsSync.mockImplementation((p) => {
      if (String(p) === TEST_ALLOWLIST_PATH) return true;
      return false; // hostPath does not exist
    });
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = validateMount(
      { hostPath: '/nonexistent/path', containerPath: 'data' },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('blocks mount when resolved path matches blocked pattern (.ssh)', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      { hostPath: '/home/user/.ssh', containerPath: 'keys' },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
    expect(result.reason).toContain('.ssh');
  });

  it('blocks mount when path is not under any allowed root', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      { hostPath: '/opt/unauthorized', containerPath: 'data' },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows valid mount under an allowed root', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      {
        hostPath: '/home/user/projects/my-repo',
        containerPath: 'my-repo',
        readonly: false,
      },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/home/user/projects/my-repo');
    expect(result.resolvedContainerPath).toBe('my-repo');
  });

  it('enforces read-only for non-main groups when nonMainReadOnly is true', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist({ nonMainReadOnly: true }));
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      {
        hostPath: '/home/user/projects/my-repo',
        containerPath: 'my-repo',
        readonly: false,
      },
      false, // not main
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write for main groups even with nonMainReadOnly', async () => {
    const { validateMount } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist({ nonMainReadOnly: true }));
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateMount(
      {
        hostPath: '/home/user/projects/my-repo',
        containerPath: 'my-repo',
        readonly: false,
      },
      true, // main group
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('returns only allowed mounts from validateAdditionalMounts', async () => {
    const { validateAdditionalMounts } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const mounts = [
      {
        hostPath: '/home/user/projects/good-repo',
        containerPath: 'good-repo',
      },
      { hostPath: '/home/user/.ssh', containerPath: 'ssh-keys' }, // blocked
      {
        hostPath: '/home/user/projects/another',
        containerPath: 'another',
      },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);

    expect(result).toHaveLength(2);
    expect(result[0].hostPath).toBe('/home/user/projects/good-repo');
    expect(result[1].hostPath).toBe('/home/user/projects/another');
  });

  it('prefixes container path with /workspace/extra/', async () => {
    const { validateAdditionalMounts } = await freshImport();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeAllowlist());
    mockRealpathSync.mockImplementation((p) => String(p));

    const result = validateAdditionalMounts(
      [
        {
          hostPath: '/home/user/projects/my-repo',
          containerPath: 'my-repo',
        },
      ],
      'test-group',
      true,
    );

    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/my-repo');
  });

  it('returns empty when allowlist file does not exist', async () => {
    const { validateAdditionalMounts } = await freshImport();
    mockExistsSync.mockReturnValue(false);

    const result = validateAdditionalMounts(
      [{ hostPath: '/home/user/projects/repo', containerPath: 'repo' }],
      'test-group',
      false,
    );

    expect(result).toHaveLength(0);
  });
});
