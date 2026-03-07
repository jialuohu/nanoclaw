import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GoogleCalendarChannelOpts {
  onMessage: OnInboundMessage;
  onDirectSend?: (jid: string, text: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const NOTIFIED_IDS_CAP = 5000;
const NOTIFIED_IDS_KEEP = 2500;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export function hasCredentials(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'gcp-oauth.keys.json')) &&
    fs.existsSync(path.join(dir, 'credentials.json'))
  );
}

export function formatEventTime(
  start: calendar_v3.Schema$EventDateTime | undefined,
): string {
  if (!start) return 'unknown';
  if (start.dateTime) {
    const d = new Date(start.dateTime);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return 'all-day';
}

export class GoogleCalendarChannel implements Channel {
  name = 'google-calendar';

  private oauth2Client: OAuth2Client | null = null;
  private calendar: calendar_v3.Calendar | null = null;
  private opts: GoogleCalendarChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private notifiedEventIds = new Set<string>();
  private consecutiveErrors = 0;
  private reminderMinutes: number;

  constructor(opts: GoogleCalendarChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;

    const env = readEnvFile(['GCAL_REMINDER_MINUTES']);
    this.reminderMinutes = parseInt(env.GCAL_REMINDER_MINUTES || '15', 10);
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.google-calendar');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!hasCredentials(credDir)) {
      logger.warn(
        'Google Calendar credentials not found in ~/.google-calendar/. Skipping.',
      );
      return;
    }

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
        logger.debug('Google Calendar OAuth tokens refreshed');
      } catch (err) {
        logger.warn(
          { err },
          'Failed to persist refreshed Google Calendar tokens',
        );
      }
    });

    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    // Verify connection
    await this.calendar.calendarList.list({ maxResults: 1 });
    logger.info('Google Calendar channel connected');

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              MAX_BACKOFF_MS,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.checkReminders()
          .catch((err) => logger.error({ err }, 'Google Calendar poll error'))
          .finally(() => {
            if (this.calendar) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.checkReminders();
    schedulePoll();
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // No-op
  }

  isConnected(): boolean {
    return this.calendar !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gcal:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.calendar = null;
    this.oauth2Client = null;
    logger.info('Google Calendar channel stopped');
  }

  // --- Private ---

  private async checkReminders(): Promise<void> {
    if (!this.calendar) return;

    try {
      const now = new Date();
      const soon = new Date(now.getTime() + this.reminderMinutes * 60 * 1000);

      const res = await this.calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: soon.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = res.data.items || [];

      for (const event of events) {
        if (!event.id || this.notifiedEventIds.has(event.id)) continue;
        this.notifiedEventIds.add(event.id);

        const title = event.summary || '(No title)';
        const startTime = formatEventTime(event.start);
        const lines = [`[Calendar Reminder] "${title}" starts at ${startTime}`];
        if (event.location) lines.push(`Location: ${event.location}`);
        if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);

        this.deliverToMainGroup(lines.join('\n'), `gcal-reminder:${event.id}`);
      }

      // Cap notified IDs set
      if (this.notifiedEventIds.size > NOTIFIED_IDS_CAP) {
        const ids = [...this.notifiedEventIds];
        this.notifiedEventIds = new Set(ids.slice(ids.length - NOTIFIED_IDS_KEEP));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors },
        'Google Calendar poll failed, backing off',
      );
    }
  }

  private deliverToMainGroup(content: string, eventId: string): void {
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug('No main group registered, skipping calendar notification');
      return;
    }

    const mainJid = mainEntry[0];

    // Send directly to the user's channel (bypasses agent judgment)
    if (this.opts.onDirectSend) {
      this.opts.onDirectSend(mainJid, content);
    }

    // Also store via onMessage so the reminder is in the DB for agent context
    this.opts.onMessage(mainJid, {
      id: eventId,
      chat_jid: mainJid,
      sender: 'google-calendar',
      sender_name: 'Google Calendar',
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });
  }
}

registerChannel('google-calendar', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.google-calendar');
  if (!hasCredentials(credDir)) {
    logger.warn(
      'Google Calendar: credentials not found in ~/.google-calendar/',
    );
    return null;
  }
  return new GoogleCalendarChannel(opts);
});
