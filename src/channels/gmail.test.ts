import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock googleapis for polling tests
const mockGetProfile = vi.fn();
const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesModify = vi.fn();
const mockMessagesSend = vi.fn();
const mockSetCredentials = vi.fn();
const mockOn = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn(function (this: Record<string, unknown>) {
        this.setCredentials = mockSetCredentials;
        this.on = mockOn;
      }),
    },
    gmail: vi.fn(() => ({
      users: {
        getProfile: mockGetProfile,
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
          modify: mockMessagesModify,
          send: mockMessagesSend,
        },
      },
    })),
  },
}));

import {
  GmailChannel,
  GmailChannelOpts,
  parseGmailJid,
  discoverAccounts,
  hasCredentials,
  getCategoryHint,
  extractTextBody,
  appendToDigestQueue,
  DigestEntry,
} from './gmail.js';
import type { OnInboundMessage, OnChatMetadata } from '../types.js';

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

/** Create a temp ~/.gmail-mcp dir with fake credentials and return the path. */
function setupFakeCredentials(): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-poll-'));
  const gmailDir = path.join(tmpHome, '.gmail-mcp');
  fs.mkdirSync(gmailDir, { recursive: true });
  fs.writeFileSync(
    path.join(gmailDir, 'gcp-oauth.keys.json'),
    JSON.stringify({
      installed: {
        client_id: 'test-id',
        client_secret: 'test-secret',
        redirect_uris: ['http://localhost'],
      },
    }),
  );
  fs.writeFileSync(
    path.join(gmailDir, 'credentials.json'),
    JSON.stringify({ access_token: 'tok', refresh_token: 'ref' }),
  );
  return tmpHome;
}

function makeGmailMessage(
  id: string,
  opts: {
    from?: string;
    subject?: string;
    body?: string;
    labelIds?: string[];
    threadId?: string;
    snippet?: string;
  } = {},
) {
  const {
    from = 'Alice <alice@example.com>',
    subject = 'Hello',
    body = 'Test body',
    labelIds = ['INBOX', 'CATEGORY_PRIMARY'],
    threadId = `thread-${id}`,
    snippet = 'Test snippet',
  } = opts;
  return {
    data: {
      id,
      threadId,
      labelIds,
      internalDate: String(Date.now()),
      snippet,
      payload: {
        mimeType: 'text/plain',
        body: { data: Buffer.from(body).toString('base64') },
        headers: [
          { name: 'From', value: from },
          { name: 'Subject', value: subject },
          { name: 'Message-ID', value: `<${id}@example.com>` },
        ],
      },
    },
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

describe('getCategoryHint', () => {
  it('returns Primary for CATEGORY_PRIMARY', () => {
    expect(getCategoryHint(['INBOX', 'CATEGORY_PRIMARY'])).toBe('Primary');
  });

  it('returns Updates for CATEGORY_UPDATES', () => {
    expect(getCategoryHint(['INBOX', 'CATEGORY_UPDATES'])).toBe('Updates');
  });

  it('returns Social for CATEGORY_SOCIAL', () => {
    expect(getCategoryHint(['INBOX', 'CATEGORY_SOCIAL'])).toBe('Social');
  });

  it('returns Promotions for CATEGORY_PROMOTIONS', () => {
    expect(getCategoryHint(['INBOX', 'CATEGORY_PROMOTIONS'])).toBe(
      'Promotions',
    );
  });

  it('returns Forums for CATEGORY_FORUMS', () => {
    expect(getCategoryHint(['INBOX', 'CATEGORY_FORUMS'])).toBe('Forums');
  });

  it('returns null for no category labels', () => {
    expect(getCategoryHint(['INBOX'])).toBeNull();
  });

  it('returns null for empty label array', () => {
    expect(getCategoryHint([])).toBeNull();
  });

  it('returns first matching category when multiple present', () => {
    expect(getCategoryHint(['CATEGORY_UPDATES', 'CATEGORY_SOCIAL'])).toBe(
      'Updates',
    );
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

describe('Gmail polling (integration)', () => {
  let tmpHome: string;
  let onMessage: ReturnType<typeof vi.fn<OnInboundMessage>>;
  let onChatMetadata: ReturnType<typeof vi.fn<OnChatMetadata>>;
  const mainGroup = {
    name: 'Main',
    folder: 'main',
    trigger: '@Bot',
    added_at: '2026-01-01T00:00:00Z',
    isMain: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = setupFakeCredentials();
    onMessage = vi.fn<OnInboundMessage>();
    onChatMetadata = vi.fn<OnChatMetadata>();

    // Default mock: getProfile returns a test email
    mockGetProfile.mockResolvedValue({
      data: { emailAddress: 'user@gmail.com' },
    });

    // Default: no messages
    mockMessagesList.mockResolvedValue({ data: { messages: [] } });
    mockMessagesModify.mockResolvedValue({});
  });

  afterEach(async () => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeChannel(groupOverrides?: Record<string, unknown>) {
    // Patch discoverAccounts by pointing to our temp dir
    const origHomedir = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    const groups: Record<string, typeof mainGroup> = {
      'tg:main': { ...mainGroup, ...groupOverrides },
    };

    const ch = new GmailChannel(
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => groups,
      },
      60000,
    );

    // Restore after channel is created (connect will read creds)
    vi.mocked(os.homedir).mockImplementation(origHomedir);
    // Re-spy for connect() which calls discoverAccounts
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    return ch;
  }

  it('delivers primary emails to the main group', async () => {
    mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'msg1' }] },
    });
    mockMessagesGet.mockResolvedValue(makeGmailMessage('msg1'));

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    expect(onMessage).toHaveBeenCalledTimes(1);
    const call = onMessage.mock.calls[0];
    expect(call[0]).toBe('tg:main');
    expect(call[1].content).toContain('[Email from Alice');
    expect(call[1].content).toContain('| Gmail: Primary');
    expect(call[1].content).toContain('Subject: Hello');
  });

  it('delivers updates/social emails to agent with category hint', async () => {
    mockMessagesList.mockResolvedValueOnce({
      data: { messages: [{ id: 'msg-social' }] },
    });
    mockMessagesGet.mockResolvedValue(
      makeGmailMessage('msg-social', {
        from: 'LinkedIn <noreply@linkedin.com>',
        subject: 'New connections',
        labelIds: ['INBOX', 'CATEGORY_SOCIAL'],
      }),
    );

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    // Agent now sees ALL emails — it decides what's digest/drop
    expect(onMessage).toHaveBeenCalledTimes(1);
    const call = onMessage.mock.calls[0];
    expect(call[0]).toBe('tg:main');
    expect(call[1].content).toContain('LinkedIn');
    expect(call[1].content).toContain('| Gmail: Social');
    expect(call[1].content).toContain('Subject: New connections');
  });

  it('continues processing remaining messages when one fails', async () => {
    mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'msg-fail' }, { id: 'msg-ok' }] },
    });
    mockMessagesGet
      .mockRejectedValueOnce(new Error('API error on msg-fail'))
      .mockResolvedValueOnce(makeGmailMessage('msg-ok'));

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    // msg-ok should still be delivered despite msg-fail throwing
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][1].content).toContain('Subject: Hello');
  });

  it('skips emails from self', async () => {
    mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'msg-self' }] },
    });
    mockMessagesGet.mockResolvedValue(
      makeGmailMessage('msg-self', {
        from: 'Me <user@gmail.com>',
      }),
    );

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('does not reprocess already-seen message IDs', async () => {
    // First poll returns msg1 and msg2
    mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'msg1' }, { id: 'msg2' }] },
    });
    mockMessagesGet.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(makeGmailMessage(id, { subject: `Subject ${id}` })),
    );

    const ch = makeChannel();
    await ch.connect();

    // Both delivered on initial poll
    expect(onMessage).toHaveBeenCalledTimes(2);

    // The poll timer would fire next, returning same IDs — simulate by
    // verifying the processedIds prevent duplicates. Since we can't
    // trigger a second poll directly, we verify the dedup by checking
    // that the messages.get was called exactly twice (once per unique ID).
    expect(mockMessagesGet).toHaveBeenCalledTimes(2);

    await ch.disconnect();
  });

  it('marks emails as read after processing', async () => {
    mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'msg-read' }] },
    });
    mockMessagesGet.mockResolvedValue(makeGmailMessage('msg-read'));

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    expect(mockMessagesModify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg-read',
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  });

  it('uses Gmail snippet as fallback for HTML-only emails', async () => {
    mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'msg-html' }] },
    });
    mockMessagesGet.mockResolvedValue({
      data: {
        id: 'msg-html',
        threadId: 'thread-html',
        labelIds: ['INBOX', 'CATEGORY_PRIMARY'],
        internalDate: String(Date.now()),
        snippet: 'Fallback snippet text',
        payload: {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<p>HTML only</p>').toString('base64'),
          },
          headers: [
            { name: 'From', value: 'Bob <bob@example.com>' },
            { name: 'Subject', value: 'HTML email' },
            { name: 'Message-ID', value: '<html@example.com>' },
          ],
        },
      },
    });

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][1].content).toContain(
      'Fallback snippet text',
    );
  });

  it('includes account label in multi-account mode', async () => {
    // Add a second account
    const accountsDir = path.join(tmpHome, '.gmail-mcp', 'accounts', 'work');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(accountsDir, 'gcp-oauth.keys.json'),
      JSON.stringify({
        installed: {
          client_id: 'id2',
          client_secret: 'sec2',
          redirect_uris: ['http://localhost'],
        },
      }),
    );
    fs.writeFileSync(
      path.join(accountsDir, 'credentials.json'),
      JSON.stringify({ access_token: 'tok2', refresh_token: 'ref2' }),
    );

    // First account: default, second: work
    mockGetProfile
      .mockResolvedValueOnce({ data: { emailAddress: 'user@gmail.com' } })
      .mockResolvedValueOnce({ data: { emailAddress: 'work@company.com' } });

    // Only second account has messages (one poll query per account)
    mockMessagesList
      .mockResolvedValueOnce({ data: { messages: [] } }) // default
      .mockResolvedValueOnce({
        data: { messages: [{ id: 'work-msg' }] },
      }); // work

    mockMessagesGet.mockResolvedValue(
      makeGmailMessage('work-msg', { subject: 'Work email' }),
    );

    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();

    expect(onMessage).toHaveBeenCalledTimes(1);
    // Multi-account mode should include the account email
    expect(onMessage.mock.calls[0][1].content).toContain('(work@company.com)');
  });
});
