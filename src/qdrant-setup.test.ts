import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { ensureQdrant } from './qdrant-setup.js';
import { logger } from './logger.js';

const QDRANT_URL = 'http://localhost:6333';
const STORAGE_DIR = '/tmp/qdrant_storage';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ensureQdrant', () => {
  it('returns true without Docker calls when Qdrant is already healthy', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const result = await ensureQdrant(QDRANT_URL, STORAGE_DIR);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${QDRANT_URL}/healthz`);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Qdrant is already running');
  });

  it('returns false when Docker is not available', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not found');
    });

    const result = await ensureQdrant(QDRANT_URL, STORAGE_DIR);

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Docker is not available, cannot auto-start Qdrant',
    );
  });

  it('starts a new container and returns true when it becomes healthy', async () => {
    vi.useFakeTimers();

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockReturnValueOnce(''); // docker info
    mockExecSync.mockReturnValueOnce(''); // docker ps -a (no container)
    mockExecSync.mockReturnValueOnce('abc123'); // docker run

    // First poll fails, second succeeds
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    fetchMock.mockResolvedValueOnce({ ok: true });

    const promise = ensureQdrant(QDRANT_URL, STORAGE_DIR);

    // Advance through two poll intervals
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('docker info', {
      stdio: 'ignore',
    });
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('docker run -d --name qdrant'),
      { stdio: 'ignore' },
    );
    expect(logger.info).toHaveBeenCalledWith('Qdrant is now healthy');
  });

  it('restarts an existing stopped container', async () => {
    vi.useFakeTimers();

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockReturnValueOnce(''); // docker info
    mockExecSync.mockReturnValueOnce('Exited (0) 2 hours ago'); // docker ps -a
    mockExecSync.mockReturnValueOnce(''); // docker start

    fetchMock.mockResolvedValueOnce({ ok: true }); // poll succeeds

    const promise = ensureQdrant(QDRANT_URL, STORAGE_DIR);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('docker start qdrant', {
      stdio: 'ignore',
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Found stopped Qdrant container, restarting...',
    );
  });

  it('returns false when Qdrant never becomes healthy after Docker start', async () => {
    vi.useFakeTimers();

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockReturnValueOnce(''); // docker info
    mockExecSync.mockReturnValueOnce(''); // docker ps -a
    mockExecSync.mockReturnValueOnce('abc123'); // docker run

    // All polls fail
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const promise = ensureQdrant(QDRANT_URL, STORAGE_DIR);

    // Advance past all 30 polls (60s total)
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    const result = await promise;

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Qdrant did not become healthy within 60s',
    );
  });

  it('returns false when Docker container start fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockReturnValueOnce(''); // docker info
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker ps failed');
    });

    const result = await ensureQdrant(QDRANT_URL, STORAGE_DIR);

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to start Qdrant container',
    );
  });

  it('does not restart a container that is already Up', async () => {
    vi.useFakeTimers();

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockReturnValueOnce(''); // docker info
    mockExecSync.mockReturnValueOnce('Up 3 hours'); // docker ps -a

    fetchMock.mockResolvedValueOnce({ ok: true }); // poll succeeds

    const promise = ensureQdrant(QDRANT_URL, STORAGE_DIR);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result).toBe(true);
    // Should NOT have called docker start or docker run
    expect(mockExecSync).not.toHaveBeenCalledWith(
      'docker start qdrant',
      expect.anything(),
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('docker run'),
      expect.anything(),
    );
  });

  it('quotes storageDir in docker run command', async () => {
    vi.useFakeTimers();
    const dirWithSpaces = '/path with spaces/qdrant_storage';

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockExecSync.mockReturnValueOnce(''); // docker info
    mockExecSync.mockReturnValueOnce(''); // docker ps -a
    mockExecSync.mockReturnValueOnce('abc123'); // docker run

    fetchMock.mockResolvedValueOnce({ ok: true }); // poll

    const promise = ensureQdrant(QDRANT_URL, dirWithSpaces);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockExecSync).toHaveBeenCalledWith(
      `docker run -d --name qdrant -p 6333:6333 -v "${dirWithSpaces}":/qdrant/storage qdrant/qdrant`,
      { stdio: 'ignore' },
    );
  });
});
