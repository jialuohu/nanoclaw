import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, readFileSync: vi.fn() } };
});
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readEnvFile } from './env.js';

const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readEnvFile', () => {
  it('returns requested keys from .env file', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux\n');

    const result = readEnvFile(['FOO', 'BAZ']);

    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores keys not in the requested list', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\nSECRET=hidden\n');

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({ FOO: 'bar' });
    expect(result).not.toHaveProperty('SECRET');
  });

  it('strips double quotes from values', () => {
    mockReadFileSync.mockReturnValue('FOO="hello world"\n');

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('strips single quotes from values', () => {
    mockReadFileSync.mockReturnValue("FOO='hello world'\n");

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('skips comment lines', () => {
    mockReadFileSync.mockReturnValue(
      '# This is a comment\nFOO=bar\n# Another comment\n',
    );

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips blank lines', () => {
    mockReadFileSync.mockReturnValue('\n\nFOO=bar\n\n');

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({ FOO: 'bar' });
  });

  it('returns empty object when .env file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({});
  });

  it('returns empty object for keys with empty values', () => {
    mockReadFileSync.mockReturnValue('FOO=\nBAR=value\n');

    const result = readEnvFile(['FOO', 'BAR']);

    expect(result).toEqual({ BAR: 'value' });
    expect(result).not.toHaveProperty('FOO');
  });
});
