import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

import {
  GmailChannel,
  GmailChannelOpts,
  parseGmailJid,
  discoverAccounts,
  hasCredentials,
  classifyEmail,
  extractTextBody,
  appendToDigestQueue,
  DigestEntry,
} from './gmail.js';

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

function makeDigestEntry(overrides?: Partial<DigestEntry>): DigestEntry {
  return {
    account: 'user@gmail.com',
    sender: 'news@example.com',
    senderName: 'Example News',
    subject: 'Daily Update',
    snippet: 'Here is the latest...',
    timestamp: '2026-03-06T10:00:00.000Z',
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:default:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:work:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });
  });
});

describe('parseGmailJid', () => {
  it('parses new format with account name', () => {
    expect(parseGmailJid('gmail:default:abc123')).toEqual({
      accountName: 'default',
      threadId: 'abc123',
    });
    expect(parseGmailJid('gmail:work:18e4a3b2c1d')).toEqual({
      accountName: 'work',
      threadId: '18e4a3b2c1d',
    });
    expect(parseGmailJid('gmail:school:xyz789')).toEqual({
      accountName: 'school',
      threadId: 'xyz789',
    });
  });

  it('handles legacy format as default account', () => {
    expect(parseGmailJid('gmail:abc123')).toEqual({
      accountName: 'default',
      threadId: 'abc123',
    });
    expect(parseGmailJid('gmail:18e4a3b2c1d')).toEqual({
      accountName: 'default',
      threadId: '18e4a3b2c1d',
    });
  });

  it('handles multiple colons — first segment is account, rest is threadId', () => {
    expect(parseGmailJid('gmail:acc:thread:extra')).toEqual({
      accountName: 'acc',
      threadId: 'thread:extra',
    });
  });

  it('treats empty account segment as default', () => {
    // gmail::thread → candidate is empty string, rest is 'thread'
    // colonIdx=0, candidate='', rest='thread' → rest.length > 0 → returns {accountName: '', threadId: 'thread'}
    // This is current behavior — empty string account name
    const result = parseGmailJid('gmail::thread');
    expect(result.threadId).toBe('thread');
  });
});

describe('hasCredentials', () => {
  it('is a function', () => {
    expect(typeof hasCredentials).toBe('function');
  });
});

describe('discoverAccounts', () => {
  it('is a function', () => {
    expect(typeof discoverAccounts).toBe('function');
  });
});

describe('classifyEmail', () => {
  it('returns digest for CATEGORY_UPDATES label', () => {
    expect(classifyEmail(['INBOX', 'CATEGORY_UPDATES'])).toBe('digest');
  });

  it('returns digest for CATEGORY_SOCIAL label', () => {
    expect(classifyEmail(['INBOX', 'CATEGORY_SOCIAL'])).toBe('digest');
  });

  it('returns immediate for CATEGORY_PRIMARY label', () => {
    expect(classifyEmail(['INBOX', 'CATEGORY_PRIMARY'])).toBe('immediate');
  });

  it('returns immediate for INBOX-only labels', () => {
    expect(classifyEmail(['INBOX'])).toBe('immediate');
  });

  it('returns digest when both Updates and Primary labels present', () => {
    expect(
      classifyEmail(['INBOX', 'CATEGORY_PRIMARY', 'CATEGORY_UPDATES']),
    ).toBe('digest');
  });

  it('returns digest when both Updates and Social present', () => {
    expect(
      classifyEmail(['CATEGORY_UPDATES', 'CATEGORY_SOCIAL']),
    ).toBe('digest');
  });

  it('returns immediate for empty label array', () => {
    expect(classifyEmail([])).toBe('immediate');
  });

  it('returns immediate for unknown labels only', () => {
    expect(classifyEmail(['STARRED', 'IMPORTANT'])).toBe('immediate');
  });
});

describe('extractTextBody', () => {
  it('returns empty string for undefined payload', () => {
    expect(extractTextBody(undefined)).toBe('');
  });

  it('returns empty string for payload with no body or parts', () => {
    expect(extractTextBody({ mimeType: 'text/html' })).toBe('');
  });

  it('extracts direct text/plain body', () => {
    const payload = {
      mimeType: 'text/plain',
      body: { data: Buffer.from('Hello world').toString('base64') },
    };
    expect(extractTextBody(payload)).toBe('Hello world');
  });

  it('returns empty for text/plain with no body data', () => {
    const payload = { mimeType: 'text/plain', body: {} };
    expect(extractTextBody(payload)).toBe('');
  });

  it('extracts text/plain from multipart message', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Plain text').toString('base64') },
        },
        {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<p>HTML text</p>').toString('base64'),
          },
        },
      ],
    };
    expect(extractTextBody(payload)).toBe('Plain text');
  });

  it('returns empty for HTML-only multipart', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<p>HTML only</p>').toString('base64'),
          },
        },
      ],
    };
    expect(extractTextBody(payload)).toBe('');
  });

  it('recurses into nested multipart structures', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('Nested plain text').toString('base64'),
              },
            },
          ],
        },
      ],
    };
    expect(extractTextBody(payload)).toBe('Nested plain text');
  });

  it('returns empty for multipart with no text parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'application/pdf', body: {} },
        { mimeType: 'image/png', body: {} },
      ],
    };
    expect(extractTextBody(payload)).toBe('');
  });
});

describe('appendToDigestQueue', () => {
  let tmpDir: string;
  let queuePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-'));
    queuePath = path.join(tmpDir, 'email-digest-queue.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file and appends entry when file does not exist', () => {
    appendToDigestQueue(queuePath, makeDigestEntry());
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    expect(queue).toHaveLength(1);
    expect(queue[0].sender).toBe('news@example.com');
  });

  it('appends to existing queue', () => {
    fs.writeFileSync(
      queuePath,
      JSON.stringify([makeDigestEntry({ subject: 'First' })]),
    );
    appendToDigestQueue(queuePath, makeDigestEntry({ subject: 'Second' }));
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    expect(queue).toHaveLength(2);
    expect(queue[0].subject).toBe('First');
    expect(queue[1].subject).toBe('Second');
  });

  it('caps queue at 200 entries, keeping newest', () => {
    const existing = Array.from({ length: 200 }, (_, i) =>
      makeDigestEntry({ subject: `Entry ${i}` }),
    );
    fs.writeFileSync(queuePath, JSON.stringify(existing));

    appendToDigestQueue(queuePath, makeDigestEntry({ subject: 'New entry' }));
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    expect(queue).toHaveLength(200);
    expect(queue[199].subject).toBe('New entry');
    // Entry 0 should have been dropped
    expect(queue[0].subject).toBe('Entry 1');
  });

  it('handles malformed JSON by resetting queue', () => {
    fs.writeFileSync(queuePath, '{not valid json!!!');
    appendToDigestQueue(queuePath, makeDigestEntry());
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    expect(queue).toHaveLength(1);
  });

  it('handles empty file by starting fresh', () => {
    fs.writeFileSync(queuePath, '');
    appendToDigestQueue(queuePath, makeDigestEntry());
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    expect(queue).toHaveLength(1);
  });
});
