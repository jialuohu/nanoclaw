import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

interface AccountConfig {
  name: string;
  credDir: string;
}

export interface DigestEntry {
  account: string;
  sender: string;
  senderName: string;
  subject: string;
  snippet: string;
  timestamp: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  CATEGORY_PRIMARY: 'Primary',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_FORUMS: 'Forums',
};

// --- Utility functions (exported for testing) ---

export function hasCredentials(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'gcp-oauth.keys.json')) &&
    fs.existsSync(path.join(dir, 'credentials.json'))
  );
}

export function discoverAccounts(): AccountConfig[] {
  const baseDir = path.join(os.homedir(), '.gmail-mcp');
  const results: AccountConfig[] = [];

  // Default account — the existing flat structure
  if (hasCredentials(baseDir)) {
    results.push({ name: 'default', credDir: baseDir });
  }

  // Additional accounts in accounts/ subdirectories
  const accountsDir = path.join(baseDir, 'accounts');
  if (fs.existsSync(accountsDir)) {
    const entries = fs.readdirSync(accountsDir).sort();
    for (const entry of entries) {
      const fullPath = path.join(accountsDir, entry);
      if (fs.statSync(fullPath).isDirectory() && hasCredentials(fullPath)) {
        results.push({ name: entry, credDir: fullPath });
      }
    }
  }

  return results;
}

export function parseGmailJid(jid: string): {
  accountName: string;
  threadId: string;
} {
  const stripped = jid.replace(/^gmail:/, '');
  const colonIdx = stripped.indexOf(':');
  if (colonIdx === -1) {
    // Legacy format: gmail:{threadId} — treat as default account
    return { accountName: 'default', threadId: stripped };
  }
  const candidate = stripped.slice(0, colonIdx);
  const rest = stripped.slice(colonIdx + 1);
  if (rest.length > 0) {
    return { accountName: candidate, threadId: rest };
  }
  return { accountName: 'default', threadId: stripped };
}

export function getCategoryHint(labelIds: string[]): string | null {
  for (const id of labelIds) {
    if (id in CATEGORY_LABELS) {
      return CATEGORY_LABELS[id];
    }
  }
  return null;
}

export function appendToDigestQueue(
  filePath: string,
  entry: DigestEntry,
): void {
  let queue: DigestEntry[] = [];
  try {
    if (fs.existsSync(filePath)) {
      queue = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    logger.warn({ filePath, err }, 'Corrupt digest queue file, resetting');
    queue = [];
  }
  queue.push(entry);
  if (queue.length > 200) {
    const dropped = queue.length - 200;
    logger.warn(
      { filePath, dropped },
      'Digest queue overflow, dropping oldest entries',
    );
    queue = queue.slice(queue.length - 200);
  }
  fs.writeFileSync(filePath, JSON.stringify(queue, null, 2));
}

export function extractTextBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return '';

  // Direct text/plain body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Multipart: search parts recursively
  if (payload.parts) {
    // Prefer text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const text = extractTextBody(part);
      if (text) return text;
    }
  }

  return '';
}

// --- Per-account poller ---

class GmailAccount {
  readonly accountName: string;
  private credDir: string;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  userEmail = '';

  private multiAccount: boolean;

  constructor(
    config: AccountConfig,
    opts: GmailChannelOpts,
    pollIntervalMs: number,
    multiAccount: boolean,
  ) {
    this.accountName = config.name;
    this.credDir = config.credDir;
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
    this.multiAccount = multiAccount;
  }

  async connect(): Promise<void> {
    const keysPath = path.join(this.credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(this.credDir, 'credentials.json');

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug(
          { account: this.accountName },
          'Gmail OAuth tokens refreshed',
        );
      } catch (err) {
        logger.warn(
          { account: this.accountName, err },
          'Failed to persist refreshed Gmail tokens',
        );
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    // Verify connection
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info(
      { account: this.accountName, email: this.userEmail },
      'Gmail account connected',
    );

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) =>
            logger.error(
              { account: this.accountName, err },
              'Gmail poll error',
            ),
          )
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  getThreadMeta(threadId: string): ThreadMeta | undefined {
    return this.threadMeta.get(threadId);
  }

  async sendReply(threadId: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn({ account: this.accountName }, 'Gmail not initialized');
      return;
    }

    const meta = this.threadMeta.get(threadId);
    if (!meta) {
      logger.warn(
        { account: this.accountName, threadId },
        'No thread metadata for reply, cannot send',
      );
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info(
        { account: this.accountName, to: meta.sender, threadId },
        'Gmail reply sent',
      );
    } catch (err) {
      logger.error(
        { account: this.accountName, threadId, err },
        'Failed to send Gmail reply',
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info({ account: this.accountName }, 'Gmail account stopped');
  }

  // --- Private ---

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      await this.pollQuery('is:unread');
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        {
          account: this.accountName,
          err,
          consecutiveErrors: this.consecutiveErrors,
        },
        'Gmail poll failed, backing off',
      );
    }
  }

  private async pollQuery(query: string): Promise<void> {
    if (!this.gmail) return;

    const res = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10,
    });

    const messages = res.data.messages || [];

    for (const stub of messages) {
      if (!stub.id || this.processedIds.has(stub.id)) continue;

      try {
        await this.processMessage(stub.id);
        this.processedIds.add(stub.id);
      } catch (err) {
        // Don't add to processedIds so the message is retried next cycle
        logger.error(
          { account: this.accountName, messageId: stub.id, err },
          'Failed to process Gmail message, will retry',
        );
      }
    }

    // Cap processed ID set to prevent unbounded growth
    if (this.processedIds.size > 5000) {
      const ids = [...this.processedIds];
      this.processedIds = new Set(ids.slice(ids.length - 2500));
    }

    // Cap thread metadata to prevent unbounded memory growth
    if (this.threadMeta.size > 2000) {
      const entries = [...this.threadMeta.entries()];
      this.threadMeta = new Map(entries.slice(entries.length - 1000));
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const labelIds = msg.data.labelIds || [];
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    // Extract sender name and email
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self (our own replies)
    if (senderEmail === this.userEmail) return;

    // Extract body text; fall back to Gmail snippet for HTML-only emails
    const body = extractTextBody(msg.data.payload) || msg.data.snippet || '';

    // Mark as read
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn(
        { account: this.accountName, messageId, err },
        'Failed to mark email as read',
      );
    }

    // Deliver to agent for triage
    const chatJid = `gmail:${this.accountName}:${threadId}`;

    // Cache thread metadata for replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    // Find the main group to deliver the email notification
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug(
        { chatJid, subject },
        'No main group registered, skipping email',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const accountLabel = this.multiAccount ? ` (${this.userEmail})` : '';
    const categoryHint = getCategoryHint(labelIds);
    const categoryTag = categoryHint ? ` | Gmail: ${categoryHint}` : '';
    const content = `[Email${accountLabel} from ${senderName} <${senderEmail}>${categoryTag}]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { account: this.accountName, mainJid, from: senderName, subject },
      'Gmail email delivered to main group',
    );
  }
}

// --- Multi-account channel coordinator ---

export class GmailChannel implements Channel {
  name = 'gmail';

  private accounts: GmailAccount[] = [];
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const configs = discoverAccounts();
    if (configs.length === 0) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    const multiAccount = configs.length > 1;

    for (const config of configs) {
      const account = new GmailAccount(
        config,
        this.opts,
        this.pollIntervalMs,
        multiAccount,
      );
      try {
        await account.connect();
        this.accounts.push(account);
      } catch (err) {
        logger.error(
          { account: config.name, credDir: config.credDir, err },
          'Failed to connect Gmail account, skipping',
        );
      }
    }

    if (this.accounts.length === 0) {
      logger.warn('No Gmail accounts connected successfully');
    } else {
      logger.info(
        {
          count: this.accounts.length,
          emails: this.accounts.map((a) => a.userEmail),
        },
        'Gmail channel connected',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { accountName, threadId } = parseGmailJid(jid);
    const account = this.accounts.find((a) => a.accountName === accountName);

    if (!account) {
      logger.warn(
        { jid, accountName },
        'No Gmail account found for JID, cannot send',
      );
      return;
    }

    await account.sendReply(threadId, text);
  }

  isConnected(): boolean {
    return this.accounts.some((a) => a.isConnected());
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.accounts.map((a) => a.disconnect()));
    this.accounts = [];
    logger.info('Gmail channel stopped');
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const accounts = discoverAccounts();
  if (accounts.length === 0) {
    logger.warn('Gmail: no account credentials found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
