import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createTask } from './db.js';
import { logger } from './logger.js';
import { tryExtractMemories } from './memory-extractor.js';
import type { NewMessage } from './types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'test@g.us',
    sender: 'user1',
    sender_name: 'User One',
    content: 'Hello world',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    ...overrides,
  };
}

describe('tryExtractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when fewer than 3 messages', () => {
    const messages = [makeMessage(), makeMessage({ id: 'msg-2' })];
    tryExtractMemories('test-folder', 'Test Group', messages, 'test@g.us');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates a task for 3+ messages', () => {
    const messages = [
      makeMessage({ id: 'msg-1' }),
      makeMessage({ id: 'msg-2' }),
      makeMessage({ id: 'msg-3' }),
    ];
    tryExtractMemories('test-folder', 'Test Group', messages, 'test@g.us');
    expect(createTask).toHaveBeenCalledTimes(1);

    const call = vi.mocked(createTask).mock.calls[0][0];
    expect(call.id).toMatch(/^memex-/);
    expect(call.group_folder).toBe('test-folder');
    expect(call.chat_jid).toBe('test@g.us');
    expect(call.schedule_type).toBe('once');
    expect(call.context_mode).toBe('isolated');
    expect(call.status).toBe('active');
    expect(call.prompt).toContain('User One: Hello world');
    expect(call.prompt).toContain('<conversation>');
  });

  it('truncates long conversations to 3000 chars', () => {
    const longContent = 'x'.repeat(2000);
    const messages = [
      makeMessage({ id: 'msg-1', content: longContent }),
      makeMessage({ id: 'msg-2', content: longContent }),
      makeMessage({ id: 'msg-3', content: longContent }),
    ];
    tryExtractMemories('test-folder', 'Test Group', messages, 'test@g.us');
    expect(createTask).toHaveBeenCalledTimes(1);

    const call = vi.mocked(createTask).mock.calls[0][0];
    // The summary inside the prompt should be truncated
    const conversationMatch = call.prompt.match(
      /<conversation>\n([\s\S]*?)\n<\/conversation>/,
    );
    expect(conversationMatch).toBeTruthy();
    expect(conversationMatch![1].length).toBeLessThanOrEqual(3000);
  });

  it('handles createTask errors gracefully', () => {
    vi.mocked(createTask).mockImplementation(() => {
      throw new Error('DB write failed');
    });
    const messages = [
      makeMessage({ id: 'msg-1' }),
      makeMessage({ id: 'msg-2' }),
      makeMessage({ id: 'msg-3' }),
    ];
    // Should not throw
    expect(() =>
      tryExtractMemories('test-folder', 'Test Group', messages, 'test@g.us'),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('schedules task ~30s in the future', () => {
    const before = Date.now();
    const messages = [
      makeMessage({ id: 'msg-1' }),
      makeMessage({ id: 'msg-2' }),
      makeMessage({ id: 'msg-3' }),
    ];
    tryExtractMemories('test-folder', 'Test Group', messages, 'test@g.us');
    const after = Date.now();

    const call = vi.mocked(createTask).mock.calls[0][0];
    const scheduledTime = new Date(call.next_run!).getTime();
    // Should be ~30s from now (allow 1s tolerance)
    expect(scheduledTime).toBeGreaterThanOrEqual(before + 29_000);
    expect(scheduledTime).toBeLessThanOrEqual(after + 31_000);
  });
});
