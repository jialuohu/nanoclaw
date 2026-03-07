import http from 'http';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../wecom-crypto.js', () => ({
  deriveAESKey: vi.fn(() => Buffer.alloc(32)),
  computeSignature: vi.fn(() => 'valid-sig'),
  verifySignature: vi.fn(() => true),
  decrypt: vi.fn(() => ({
    message:
      '<xml><ToUserName><![CDATA[botid]]></ToUserName>' +
      '<FromUserName><![CDATA[zhangsan]]></FromUserName>' +
      '<CreateTime>1609459200</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[hello]]></Content>' +
      '<MsgId>123</MsgId>' +
      '<AgentID>1000002</AgentID></xml>',
    receiveid: 'corpid',
  })),
  encrypt: vi.fn(() => 'encrypted-echostr'),
  parseWeComXml: vi.fn((xml: string) => {
    const result: Record<string, string> = {};
    const cdataRe = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
    const plainRe = /<(\w+)>([^<]+)<\/\1>/g;
    let m;
    while ((m = cdataRe.exec(xml)) !== null) result[m[1]] = m[2];
    while ((m = plainRe.exec(xml)) !== null) if (!result[m[1]]) result[m[1]] = m[2];
    return result;
  }),
}));

import { WeComChannel } from './wecom.js';
import { verifySignature, decrypt } from '../wecom-crypto.js';
import type { ChannelOpts } from './registry.js';

// --- Helpers ---

const TEST_CONFIG = {
  corpid: 'test-corpid',
  corpsecret: 'test-corpsecret',
  agentid: 1000002,
  token: 'test-token',
  encodingAESKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  port: 0, // bind to random port
};

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'wecom:zhangsan': {
        name: 'Zhang San',
        folder: 'zhangsan',
        trigger: '@ErBao',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function getServerPort(channel: WeComChannel): number {
  // Access the server via the class to get the actual bound port
  const server = (channel as any).server as http.Server;
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) return addr.port;
  return 0;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Tests ---

describe('WeComChannel', () => {
  let channel: WeComChannel;
  let opts: ChannelOpts;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = createTestOpts();
    channel = new WeComChannel(TEST_CONFIG, opts);
    await channel.connect();
    port = getServerPort(channel);
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connect starts server and isConnected returns true', () => {
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnect stops server and isConnected returns false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected returns false before connect', () => {
      const ch = new WeComChannel(TEST_CONFIG, opts);
      expect(ch.isConnected()).toBe(false);
    });
  });

  // --- URL verification (GET) ---

  describe('URL verification', () => {
    it('valid signature returns 200 with decrypted echostr', async () => {
      const res = await request(
        port,
        'GET',
        '/wecom/callback?msg_signature=valid-sig&timestamp=123&nonce=abc&echostr=encrypted',
      );

      expect(res.status).toBe(200);
      // decrypt mock returns XML, but for verification the "message" from decrypt is returned
      expect(res.body).toContain('<xml>');
    });

    it('invalid signature returns 403', async () => {
      vi.mocked(verifySignature).mockReturnValueOnce(false);

      const res = await request(
        port,
        'GET',
        '/wecom/callback?msg_signature=bad-sig&timestamp=123&nonce=abc&echostr=encrypted',
      );

      expect(res.status).toBe(403);
    });
  });

  // --- Incoming messages (POST) ---

  describe('incoming messages', () => {
    const postXml =
      '<xml><ToUserName><![CDATA[corpid]]></ToUserName>' +
      '<Encrypt><![CDATA[encrypted-payload]]></Encrypt>' +
      '<AgentID>1000002</AgentID></xml>';

    it('delivers text message for registered group', async () => {
      const res = await request(
        port,
        'POST',
        '/wecom/callback?msg_signature=valid-sig&timestamp=123&nonce=abc',
        postXml,
      );

      expect(res.status).toBe(200);
      expect(res.body).toBe('success');

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'wecom:zhangsan',
        '2021-01-01T00:00:00.000Z',
        'zhangsan',
        'wecom',
        false,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'wecom:zhangsan',
        expect.objectContaining({
          id: '123',
          chat_jid: 'wecom:zhangsan',
          sender: 'zhangsan',
          sender_name: 'zhangsan',
          content: 'hello',
          is_from_me: false,
        }),
      );
    });

    it('emits metadata but not message for unregistered chat', async () => {
      const unregOpts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      await channel.disconnect();
      channel = new WeComChannel(TEST_CONFIG, unregOpts);
      await channel.connect();
      port = getServerPort(channel);

      await request(
        port,
        'POST',
        '/wecom/callback?msg_signature=valid-sig&timestamp=123&nonce=abc',
        postXml,
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(unregOpts.onChatMetadata).toHaveBeenCalled();
      expect(unregOpts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text messages', async () => {
      vi.mocked(decrypt).mockReturnValueOnce({
        message:
          '<xml><FromUserName><![CDATA[zhangsan]]></FromUserName>' +
          '<CreateTime>1609459200</CreateTime>' +
          '<MsgType><![CDATA[image]]></MsgType>' +
          '<MsgId>456</MsgId></xml>',
        receiveid: 'corpid',
      });

      await request(
        port,
        'POST',
        '/wecom/callback?msg_signature=valid-sig&timestamp=123&nonce=abc',
        postXml,
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects message with invalid signature', async () => {
      vi.mocked(verifySignature)
        .mockReturnValueOnce(true) // parseWeComXml call (for outer XML — no sig check there)
        .mockReturnValueOnce(false); // actual sig verification

      // Need to reset: verifySignature is called once per POST
      vi.mocked(verifySignature).mockReset();
      vi.mocked(verifySignature).mockReturnValue(false);

      await request(
        port,
        'POST',
        '/wecom/callback?msg_signature=bad-sig&timestamp=123&nonce=abc',
        postXml,
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();

      // Restore for other tests
      vi.mocked(verifySignature).mockReturnValue(true);
    });

    it('deduplicates messages by MsgId', async () => {
      await request(
        port,
        'POST',
        '/wecom/callback?msg_signature=valid-sig&timestamp=123&nonce=abc',
        postXml,
      );
      await new Promise((r) => setTimeout(r, 50));

      // Send same message again
      await request(
        port,
        'POST',
        '/wecom/callback?msg_signature=valid-sig&timestamp=123&nonce=abc',
        postXml,
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ errcode: 0, errmsg: 'ok' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      // Pre-set access token so we don't need to mock token fetch separately
      (channel as any).accessToken = 'test-access-token';
      (channel as any).accessTokenExpiry = Date.now() + 3600_000;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('sends message with correct API call', async () => {
      await channel.sendMessage('wecom:zhangsan', 'Hello!');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('qyapi.weixin.qq.com/cgi-bin/message/send'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"touser":"zhangsan"'),
        }),
      );
    });

    it('extracts userid from wecom: jid', async () => {
      await channel.sendMessage('wecom:lisi', 'Hi there');

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);
      expect(body.touser).toBe('lisi');
      expect(body.msgtype).toBe('text');
      expect(body.agentid).toBe(1000002);
      expect(body.text.content).toBe('Hi there');
    });

    it('refreshes access token when expired', async () => {
      (channel as any).accessToken = '';
      (channel as any).accessTokenExpiry = 0;

      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'new-token',
              expires_in: 7200,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ errcode: 0, errmsg: 'ok' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

      await channel.sendMessage('wecom:zhangsan', 'test');

      // First call should be token fetch, second is message send
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const tokenCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(tokenCall[0]).toContain('gettoken');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns wecom: JIDs', () => {
      expect(channel.ownsJid('wecom:zhangsan')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own other JID formats', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Channel name ---

  describe('channel properties', () => {
    it('has name "wecom"', () => {
      expect(channel.name).toBe('wecom');
    });
  });

  // --- 404 for unknown paths ---

  describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await request(port, 'GET', '/unknown');
      expect(res.status).toBe(404);
    });
  });
});
