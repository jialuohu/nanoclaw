import http from 'http';
import { URL } from 'url';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  deriveAESKey,
  verifySignature,
  decrypt,
  encrypt,
  parseWeComXml,
  computeSignature,
} from '../wecom-crypto.js';
import { registerChannel } from './registry.js';
import type { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';

interface WeComConfig {
  corpid: string;
  corpsecret: string;
  agentid: number;
  token: string;
  encodingAESKey: string;
  port: number;
}

export class WeComChannel implements Channel {
  name = 'wecom';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private config: WeComConfig;
  private aesKey: Buffer;
  private accessToken = '';
  private accessTokenExpiry = 0;
  private processedMsgIds = new Set<string>();

  constructor(config: WeComConfig, opts: ChannelOpts) {
    this.config = config;
    this.opts = opts;
    this.aesKey = deriveAESKey(config.encodingAESKey);
  }

  async connect(): Promise<void> {
    this.aesKey = deriveAESKey(this.config.encodingAESKey);

    this.server = http.createServer((req, res) =>
      this.requestHandler(req, res),
    );

    return new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, '127.0.0.1', () => {
        const port = this.config.port;
        logger.info({ port }, 'WeCom callback server listening');
        resolve();
      });
    });
  }

  private requestHandler(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '/', `http://localhost:${this.config.port}`);

    if (url.pathname !== '/wecom/callback') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    if (req.method === 'GET') {
      this.handleVerification(url.searchParams, res);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        this.handleMessage(body, url.searchParams, res);
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private handleVerification(
    query: URLSearchParams,
    res: http.ServerResponse,
  ): void {
    const msgSignature = query.get('msg_signature') || '';
    const timestamp = query.get('timestamp') || '';
    const nonce = query.get('nonce') || '';
    const echostr = query.get('echostr') || '';

    if (
      !verifySignature(
        this.config.token,
        timestamp,
        nonce,
        echostr,
        msgSignature,
      )
    ) {
      res.writeHead(403);
      res.end('Invalid signature');
      return;
    }

    const { message } = decrypt(this.aesKey, echostr);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(message);
  }

  private handleMessage(
    body: string,
    query: URLSearchParams,
    res: http.ServerResponse,
  ): void {
    // Respond immediately
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('success');

    // Parse outer XML to get Encrypt field
    const outerFields = parseWeComXml(body);
    const encryptedMsg = outerFields.Encrypt || '';
    if (!encryptedMsg) {
      logger.warn('WeCom message missing Encrypt field');
      return;
    }

    // Verify signature
    const msgSignature = query.get('msg_signature') || '';
    const timestamp = query.get('timestamp') || '';
    const nonce = query.get('nonce') || '';

    if (
      !verifySignature(
        this.config.token,
        timestamp,
        nonce,
        encryptedMsg,
        msgSignature,
      )
    ) {
      logger.warn('WeCom message signature verification failed');
      return;
    }

    // Decrypt
    const { message: innerXml } = decrypt(this.aesKey, encryptedMsg);
    const fields = parseWeComXml(innerXml);

    // Dedup by MsgId
    const msgId = fields.MsgId || '';
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return;
      this.processedMsgIds.add(msgId);
      if (this.processedMsgIds.size > 5000) {
        const entries = [...this.processedMsgIds];
        this.processedMsgIds = new Set(entries.slice(entries.length - 2500));
      }
    }

    // Only handle text messages
    const msgType = fields.MsgType || '';
    if (msgType !== 'text') {
      logger.debug({ msgType }, 'WeCom: skipping non-text message');
      return;
    }

    const fromUser = fields.FromUserName || '';
    const chatJid = `wecom:${fromUser}`;
    const createTime = fields.CreateTime || '';
    const ts = createTime
      ? new Date(parseInt(createTime, 10) * 1000).toISOString()
      : new Date().toISOString();

    // Emit chat metadata
    this.opts.onChatMetadata(chatJid, ts, fromUser, 'wecom', false);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered WeCom user');
      return;
    }

    const msg: NewMessage = {
      id: msgId,
      chat_jid: chatJid,
      sender: fromUser,
      sender_name: fromUser,
      content: fields.Content || '',
      timestamp: ts,
      is_from_me: false,
    };

    this.opts.onMessage(chatJid, msg);
    logger.info({ chatJid, sender: fromUser }, 'WeCom message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const userid = jid.replace(/^wecom:/, '');

    try {
      const token = await this.ensureAccessToken();

      // Split at 2048 bytes if needed
      const MAX_BYTES = 2048;
      const chunks: string[] = [];
      const buf = Buffer.from(text, 'utf-8');
      if (buf.length <= MAX_BYTES) {
        chunks.push(text);
      } else {
        let offset = 0;
        while (offset < buf.length) {
          let end = offset + MAX_BYTES;
          // Don't split in the middle of a multi-byte character
          if (end < buf.length) {
            while (end > offset && (buf[end] & 0xc0) === 0x80) end--;
          } else {
            end = buf.length;
          }
          chunks.push(buf.subarray(offset, end).toString('utf-8'));
          offset = end;
        }
      }

      for (const chunk of chunks) {
        const resp = await fetch(
          `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              touser: userid,
              msgtype: 'text',
              agentid: this.config.agentid,
              text: { content: chunk },
            }),
          },
        );
        const data = (await resp.json()) as {
          errcode?: number;
          errmsg?: string;
        };
        if (data.errcode && data.errcode !== 0) {
          logger.error(
            { jid, errcode: data.errcode, errmsg: data.errmsg },
            'WeCom send failed',
          );
        }
      }

      logger.info({ jid, length: text.length }, 'WeCom message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send WeCom message');
    }
  }

  async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiry) {
      return this.accessToken;
    }

    const resp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.config.corpid}&corpsecret=${this.config.corpsecret}`,
    );
    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };

    if (!data.access_token) {
      throw new Error(
        `Failed to get WeCom access token: ${data.errmsg || 'unknown error'}`,
      );
    }

    this.accessToken = data.access_token;
    // Buffer 300 seconds before actual expiry
    this.accessTokenExpiry =
      Date.now() + ((data.expires_in || 7200) - 300) * 1000;
    return this.accessToken;
  }

  isConnected(): boolean {
    return this.server?.listening === true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wecom:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('WeCom callback server stopped');
          resolve();
        });
      });
    }
  }
}

registerChannel('wecom', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'WECOM_CORPID',
    'WECOM_CORPSECRET',
    'WECOM_AGENTID',
    'WECOM_TOKEN',
    'WECOM_ENCODING_AES_KEY',
    'WECOM_PORT',
  ]);
  const corpid = process.env.WECOM_CORPID || env.WECOM_CORPID || '';
  const corpsecret = process.env.WECOM_CORPSECRET || env.WECOM_CORPSECRET || '';
  const agentid = parseInt(
    process.env.WECOM_AGENTID || env.WECOM_AGENTID || '0',
    10,
  );
  const token = process.env.WECOM_TOKEN || env.WECOM_TOKEN || '';
  const encodingAESKey =
    process.env.WECOM_ENCODING_AES_KEY || env.WECOM_ENCODING_AES_KEY || '';
  const port = parseInt(process.env.WECOM_PORT || env.WECOM_PORT || '9800', 10);

  if (!corpid || !corpsecret || !agentid || !token || !encodingAESKey) {
    return null;
  }

  return new WeComChannel(
    { corpid, corpsecret, agentid, token, encodingAESKey, port },
    opts,
  );
});
