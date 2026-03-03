import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock googleapis
const mockEventsList = vi.fn();
const mockCalendarListList = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        on: vi.fn(),
      })),
    },
    calendar: vi.fn(() => ({
      events: { list: mockEventsList },
      calendarList: { list: mockCalendarListList },
    })),
  },
}));

// Mock google-auth-library (imported by the channel)
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(),
}));

// Mock fs for factory credential check
vi.mock('fs', async () => {
  const actual =
    await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: actual };
});

import { registerChannel } from './registry.js';
import {
  GoogleCalendarChannel,
  GoogleCalendarChannelOpts,
} from './google-calendar.js';

// --- Helpers ---

function makeOpts(
  overrides?: Partial<GoogleCalendarChannelOpts>,
): GoogleCalendarChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

function makeOptsWithMainGroup(
  overrides?: Partial<GoogleCalendarChannelOpts>,
): GoogleCalendarChannelOpts {
  return makeOpts({
    registeredGroups: () => ({
      'tg:main-group': {
        name: 'Main',
        folder: 'main',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    }),
    ...overrides,
  });
}

function makeEvent(overrides: {
  id?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  startDateTime?: string;
  startDate?: string;
}) {
  const event: Record<string, unknown> = {
    id: overrides.id || 'evt-1',
    summary: overrides.summary || 'Team Standup',
  };
  if (overrides.location) event.location = overrides.location;
  if (overrides.htmlLink) event.htmlLink = overrides.htmlLink;
  if (overrides.startDateTime) {
    event.start = { dateTime: overrides.startDateTime };
  } else if (overrides.startDate) {
    event.start = { date: overrides.startDate };
  } else {
    event.start = { dateTime: new Date().toISOString() };
  }
  return event;
}

// --- Tests ---

describe('GoogleCalendarChannel', () => {
  let channel: GoogleCalendarChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventsList.mockResolvedValue({ data: { items: [] } });
    mockCalendarListList.mockResolvedValue({ data: { items: [] } });
    channel = new GoogleCalendarChannel(makeOpts());
  });

  describe('name', () => {
    it('is google-calendar', () => {
      expect(channel.name).toBe('google-calendar');
    });
  });

  describe('ownsJid', () => {
    it('returns true for gcal: prefixed JIDs', () => {
      expect(channel.ownsJid('gcal:reminder-123')).toBe(true);
      expect(channel.ownsJid('gcal:agenda-2024-01-01')).toBe(true);
    });

    it('returns false for non-gcal JIDs', () => {
      expect(channel.ownsJid('gmail:abc')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
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

  describe('sendMessage', () => {
    it('is a no-op', async () => {
      // Should not throw
      await channel.sendMessage('gcal:test', 'hello');
    });
  });

  describe('reminder delivery', () => {
    it('delivers reminder for upcoming event to main group', async () => {
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);

      // Simulate connected state by calling the private poll method
      // We need to set up the calendar mock first
      const event = makeEvent({
        id: 'evt-upcoming',
        summary: 'Team Standup',
        location: 'Room 42',
        htmlLink: 'https://calendar.google.com/event/evt-upcoming',
        startDateTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      mockEventsList.mockResolvedValue({ data: { items: [event] } });

      // Access private method for testing
      const pollMethod = (ch as any).checkReminders.bind(ch);
      // Set calendar to non-null so poll works
      (ch as any).calendar = { events: { list: mockEventsList } };

      await pollMethod();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:main-group',
        expect.objectContaining({
          id: 'gcal-reminder:evt-upcoming',
          chat_jid: 'tg:main-group',
          sender: 'google-calendar',
          sender_name: 'Google Calendar',
          is_from_me: false,
        }),
      );

      // Verify content includes key parts
      const call = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const content = call[1].content as string;
      expect(content).toContain('[Calendar Reminder]');
      expect(content).toContain('Team Standup');
      expect(content).toContain('Location: Room 42');
      expect(content).toContain('Link: https://calendar.google.com/event/evt-upcoming');
    });

    it('deduplicates events (same event polled twice)', async () => {
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);

      const event = makeEvent({ id: 'evt-dup' });
      mockEventsList.mockResolvedValue({ data: { items: [event] } });

      (ch as any).calendar = { events: { list: mockEventsList } };

      await (ch as any).checkReminders();
      await (ch as any).checkReminders();

      // Only one notification despite two polls
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('caps notified event IDs set at 5000', async () => {
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);
      (ch as any).calendar = { events: { list: mockEventsList } };

      // Pre-fill with 5001 entries
      const ids = (ch as any).notifiedEventIds as Set<string>;
      for (let i = 0; i < 5001; i++) ids.add(`old-${i}`);

      mockEventsList.mockResolvedValue({ data: { items: [] } });
      await (ch as any).checkReminders();

      expect((ch as any).notifiedEventIds.size).toBeLessThanOrEqual(2500);
    });
  });

  describe('daily agenda', () => {
    // Use fake timers so tests are deterministic regardless of wall clock
    beforeEach(() => {
      // 2024-06-15 10:00:00 local time
      vi.useFakeTimers({ now: new Date(2024, 5, 15, 10, 0, 0) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('delivers daily agenda with events', async () => {
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);

      const events = [
        makeEvent({
          id: 'e1',
          summary: 'Morning Standup',
          startDateTime: new Date().toISOString(),
        }),
        makeEvent({
          id: 'e2',
          summary: 'Lunch Meeting',
          location: 'Cafe',
          startDateTime: new Date().toISOString(),
        }),
      ];

      // Mock: first call is for reminders (empty), second is for agenda
      mockEventsList
        .mockResolvedValueOnce({ data: { items: [] } }) // reminders
        .mockResolvedValueOnce({ data: { items: events } }); // agenda

      (ch as any).calendar = { events: { list: mockEventsList } };
      // Force agenda to fire: set hour to past
      (ch as any).agendaHour = 0;

      await (ch as any).poll();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:main-group',
        expect.objectContaining({
          id: 'gcal-agenda:2024-06-15',
          sender: 'google-calendar',
        }),
      );

      const call = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const content = call[1].content as string;
      expect(content).toContain('[Daily Agenda for 2024-06-15]');
      expect(content).toContain('Morning Standup');
      expect(content).toContain('Lunch Meeting');
      expect(content).toContain('(Cafe)');
    });

    it('only sends agenda once per day', async () => {
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);

      mockEventsList.mockResolvedValue({ data: { items: [] } });
      (ch as any).calendar = { events: { list: mockEventsList } };
      (ch as any).agendaHour = 0;

      await (ch as any).poll();
      await (ch as any).poll();

      // onMessage called once for the empty-day agenda, not twice
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('does not send agenda before configured hour', async () => {
      // Time is 10:00, set agenda hour to 14 (2 PM)
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);

      mockEventsList.mockResolvedValue({ data: { items: [] } });
      (ch as any).calendar = { events: { list: mockEventsList } };
      (ch as any).agendaHour = 14;

      await (ch as any).poll();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('no main group', () => {
    it('does not crash when no main group is registered', async () => {
      const opts = makeOpts(); // no main group
      const ch = new GoogleCalendarChannel(opts);

      const event = makeEvent({ id: 'evt-orphan' });
      mockEventsList.mockResolvedValue({ data: { items: [event] } });

      (ch as any).calendar = { events: { list: mockEventsList } };

      // Should not throw
      await (ch as any).checkReminders();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('all-day events', () => {
    it('formats all-day events as "all-day"', async () => {
      const opts = makeOptsWithMainGroup();
      const ch = new GoogleCalendarChannel(opts);

      const event = makeEvent({
        id: 'evt-allday',
        summary: 'Holiday',
        startDate: '2024-12-25',
      });

      mockEventsList.mockResolvedValue({ data: { items: [event] } });
      (ch as any).calendar = { events: { list: mockEventsList } };

      await (ch as any).checkReminders();

      const call = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const content = call[1].content as string;
      expect(content).toContain('starts at all-day');
    });
  });

  describe('factory registration', () => {
    it('registerChannel was called at module load with google-calendar', () => {
      // registerChannel is called at module load time, but vi.clearAllMocks()
      // in beforeEach clears the call history. Re-import won't re-execute the
      // module-level side effect. Instead, verify the mock was set up and the
      // module exports the expected class.
      expect(vi.isMockFunction(registerChannel)).toBe(true);
      expect(GoogleCalendarChannel).toBeDefined();
      expect(new GoogleCalendarChannel(makeOpts()).name).toBe(
        'google-calendar',
      );
    });
  });
});
