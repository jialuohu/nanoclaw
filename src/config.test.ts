import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Default mock for env.js — individual tests override via resetModules + dynamic import
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clean relevant env vars before each test
    delete process.env.ASSISTANT_NAME;
    delete process.env.TELEGRAM_BOT_POOL;
  });

  async function importConfig() {
    return import('./config.js');
  }

  it('ASSISTANT_NAME defaults to Andy when env vars not set', async () => {
    const config = await importConfig();

    expect(config.ASSISTANT_NAME).toBe('Andy');
  });

  it('ASSISTANT_NAME reads from process.env.ASSISTANT_NAME', async () => {
    process.env.ASSISTANT_NAME = 'Jarvis';

    const config = await importConfig();

    expect(config.ASSISTANT_NAME).toBe('Jarvis');
  });

  it('TRIGGER_PATTERN matches @AssistantName at start of string', async () => {
    const config = await importConfig();

    expect(config.TRIGGER_PATTERN.test('@Andy hello')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@andy hello')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@ANDY hello')).toBe(true);
  });

  it('TRIGGER_PATTERN does not match @AssistantName in middle of string', async () => {
    const config = await importConfig();

    expect(config.TRIGGER_PATTERN.test('hello @Andy')).toBe(false);
    expect(config.TRIGGER_PATTERN.test('say @Andy please')).toBe(false);
  });

  it('TRIGGER_PATTERN handles special regex characters in name', async () => {
    process.env.ASSISTANT_NAME = 'Mr.Bot';

    const config = await importConfig();

    expect(config.TRIGGER_PATTERN.test('@Mr.Bot hello')).toBe(true);
    // Dot should be escaped, not treated as regex wildcard
    expect(config.TRIGGER_PATTERN.test('@MrXBot hello')).toBe(false);
  });

  it('TELEGRAM_BOT_POOL parses comma-separated tokens', async () => {
    process.env.TELEGRAM_BOT_POOL = 'token1,token2, token3 ';

    const config = await importConfig();

    expect(config.TELEGRAM_BOT_POOL).toEqual(['token1', 'token2', 'token3']);
  });
});
