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
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GoogleCalendarChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
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
  private lastAgendaDate = '';
  private reminderMinutes: number;
  private agendaHour: number;

  constructor(opts: GoogleCalendarChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;

    const env = readEnvFile(['GCAL_REMINDER_MINUTES', 'GCAL_AGENDA_HOUR']);
    this.reminderMinutes = parseInt(env.GCAL_REMINDER_MINUTES || '15', 10);
    this.agendaHour = parseInt(env.GCAL_AGENDA_HOUR || '8', 10);
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.google-calendar');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Google Calendar credentials not found in ~/.google-calendar/. Skipping. Run npx tsx scripts/gcal-auth.ts to set up.',
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
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.poll()
          .catch((err) => logger.error({ err }, 'Google Calendar poll error'))
          .finally(() => {
            if (this.calendar) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.poll();
    schedulePoll();
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // No-op: agents use container-side API for calendar writes
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

  private async poll(): Promise<void> {
    if (!this.calendar) return;

    try {
      await this.checkReminders();
      await this.checkDailyAgenda();
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Google Calendar poll failed',
      );
    }
  }

  private async checkReminders(): Promise<void> {
    if (!this.calendar) return;

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
      const startTime = this.formatEventTime(event.start);
      const lines = [`[Calendar Reminder] "${title}" starts at ${startTime}`];
      if (event.location) lines.push(`Location: ${event.location}`);
      if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);

      const content = lines.join('\n');
      this.deliverToMainGroup(content, `gcal-reminder:${event.id}`);
    }

    // Cap notified IDs set to prevent unbounded growth
    if (this.notifiedEventIds.size > 5000) {
      const ids = [...this.notifiedEventIds];
      this.notifiedEventIds = new Set(ids.slice(ids.length - 2500));
    }
  }

  private async checkDailyAgenda(): Promise<void> {
    if (!this.calendar) return;

    const now = new Date();
    // Use local date components (not UTC) so the date matches getHours()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Only send once per day, after the configured hour
    if (this.lastAgendaDate === todayStr) return;
    if (now.getHours() < this.agendaHour) return;

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const res = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];

    if (events.length === 0) {
      this.deliverToMainGroup(
        `[Daily Agenda for ${todayStr}]\nNo events scheduled today.`,
        `gcal-agenda:${todayStr}`,
      );
    } else {
      const lines = [`[Daily Agenda for ${todayStr}]`];
      events.forEach((event, i) => {
        const time = this.formatEventTime(event.start);
        const title = event.summary || '(No title)';
        const location = event.location ? ` (${event.location})` : '';
        lines.push(`${i + 1}. ${time} - ${title}${location}`);
      });

      this.deliverToMainGroup(lines.join('\n'), `gcal-agenda:${todayStr}`);
    }

    // Mark as sent only after successful delivery (so transient API
    // errors don't skip the agenda for the entire day)
    this.lastAgendaDate = todayStr;
  }

  private formatEventTime(
    start: calendar_v3.Schema$EventDateTime | undefined,
  ): string {
    if (!start) return 'unknown';
    if (start.dateTime) {
      const d = new Date(start.dateTime);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    // All-day event
    return 'all-day';
  }

  private deliverToMainGroup(content: string, eventId: string): void {
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug('No main group registered, skipping calendar notification');
      return;
    }

    const mainJid = mainEntry[0];
    const timestamp = new Date().toISOString();

    this.opts.onMessage(mainJid, {
      id: eventId,
      chat_jid: mainJid,
      sender: 'google-calendar',
      sender_name: 'Google Calendar',
      content,
      timestamp,
      is_from_me: false,
    });
  }
}

registerChannel('google-calendar', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.google-calendar');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn(
      'Google Calendar: credentials not found in ~/.google-calendar/',
    );
    return null;
  }
  return new GoogleCalendarChannel(opts);
});
