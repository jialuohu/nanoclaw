import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock readEnvFile
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock googleapis for polling tests
const mockEventsList = vi.fn();
const mockCalendarListList = vi.fn();
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
    calendar: vi.fn(() => ({
      calendarList: { list: mockCalendarListList },
      events: { list: mockEventsList },
    })),
  },
}));

import {
  GoogleCalendarChannel,
  GoogleCalendarChannelOpts,
  hasCredentials,
  formatEventTime,
} from './google-calendar.js';
import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import type { OnInboundMessage } from '../types.js';

function makeOpts(
  overrides?: Partial<GoogleCalendarChannelOpts>,
): GoogleCalendarChannelOpts {
  return {
    onMessage: vi.fn(),
    onDirectSend: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

/** Set the internal calendar property so checkReminders doesn't bail on null. */
function enableCalendar(ch: GoogleCalendarChannel): void {
  (ch as any).calendar = {
    events: { list: mockEventsList },
    calendarList: { list: mockCalendarListList },
  };
}

function makeEvent(
  opts: {
    id?: string;
    summary?: string;
    location?: string;
    htmlLink?: string;
    startDateTime?: string;
    startDate?: string;
  } = {},
) {
  const {
    id = 'evt-1',
    summary = 'Team Standup',
    location,
    htmlLink,
    startDateTime = '2026-03-07T10:00:00-05:00',
    startDate,
  } = opts;
  return {
    id,
    summary,
    location,
    htmlLink,
    start: startDate ? { date: startDate } : { dateTime: startDateTime },
  };
}

const mainGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Bot',
  added_at: '2026-01-01T00:00:00Z',
  isMain: true,
};

// Factory registration must be checked before any clearAllMocks runs
describe('Factory registration', () => {
  it('registerChannel was called at module load', () => {
    expect(registerChannel).toHaveBeenCalledWith(
      'google-calendar',
      expect.any(Function),
    );
  });
});

describe('GoogleCalendarChannel', () => {
  let channel: GoogleCalendarChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new GoogleCalendarChannel(makeOpts());
  });

  describe('basic interface', () => {
    it('name is google-calendar', () => {
      expect(channel.name).toBe('google-calendar');
    });

    it('isConnected returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('sendMessage is a no-op', async () => {
      await expect(
        channel.sendMessage('gcal:123', 'text'),
      ).resolves.toBeUndefined();
    });

    it('accepts custom poll interval', () => {
      const ch = new GoogleCalendarChannel(makeOpts(), 30000);
      expect(ch.name).toBe('google-calendar');
    });
  });

  describe('ownsJid', () => {
    it('returns true for gcal: prefixed JIDs', () => {
      expect(channel.ownsJid('gcal:reminder:evt1')).toBe(true);
      expect(channel.ownsJid('gcal:anything')).toBe(true);
    });

    it('returns false for non-gcal JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
    });
  });
});

describe('hasCredentials', () => {
  it('is a function', () => {
    expect(typeof hasCredentials).toBe('function');
  });
});

describe('formatEventTime', () => {
  it('returns locale time for dateTime events', () => {
    const result = formatEventTime({ dateTime: '2026-03-07T10:00:00-05:00' });
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns all-day for date-only events', () => {
    expect(formatEventTime({ date: '2026-03-07' })).toBe('all-day');
  });

  it('returns unknown for undefined', () => {
    expect(formatEventTime(undefined)).toBe('unknown');
  });
});

describe('Reminder delivery', () => {
  let onMessage: ReturnType<typeof vi.fn<OnInboundMessage>>;
  let onDirectSend: ReturnType<
    typeof vi.fn<(jid: string, text: string) => void>
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn<OnInboundMessage>();
    onDirectSend = vi.fn<(jid: string, text: string) => void>();
  });

  function makeChannelWithMainGroup(groups?: Record<string, typeof mainGroup>) {
    const g = groups ?? { 'tg:main': mainGroup };
    const ch = new GoogleCalendarChannel({
      onMessage,
      onDirectSend,
      registeredGroups: () => g,
    });
    enableCalendar(ch);
    return ch;
  }

  it('delivers reminder with correct format to main group', async () => {
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          makeEvent({
            id: 'evt-1',
            summary: 'Team Standup',
            location: 'Room 42',
            htmlLink: 'https://calendar.google.com/event/evt-1',
          }),
        ],
      },
    });

    const ch = makeChannelWithMainGroup();
    await (ch as any).checkReminders();

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe('tg:main');
    expect(msg.id).toBe('gcal-reminder:evt-1');
    expect(msg.sender).toBe('google-calendar');
    expect(msg.sender_name).toBe('Google Calendar');
    expect(msg.content).toContain('[Calendar Reminder] "Team Standup"');
    expect(msg.content).toContain('Location: Room 42');
    expect(msg.content).toContain(
      'Link: https://calendar.google.com/event/evt-1',
    );
    expect(msg.is_from_me).toBe(false);
  });

  it('deduplicates events — same event polled twice yields one notification', async () => {
    const event = makeEvent({ id: 'evt-dup' });
    mockEventsList.mockResolvedValue({ data: { items: [event] } });

    const ch = makeChannelWithMainGroup();
    await (ch as any).checkReminders();
    await (ch as any).checkReminders();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('prunes notified IDs set when exceeding cap', async () => {
    const ch = makeChannelWithMainGroup();

    // Fill with 5001 IDs
    const idSet: Set<string> = (ch as any).notifiedEventIds;
    for (let i = 0; i < 5001; i++) {
      idSet.add(`evt-${i}`);
    }

    mockEventsList.mockResolvedValue({ data: { items: [] } });
    await (ch as any).checkReminders();

    expect((ch as any).notifiedEventIds.size).toBe(2500);
  });

  it('omits location and link when missing', async () => {
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          makeEvent({
            id: 'evt-min',
            location: undefined,
            htmlLink: undefined,
          }),
        ],
      },
    });

    const ch = makeChannelWithMainGroup();
    await (ch as any).checkReminders();

    expect(onMessage).toHaveBeenCalledTimes(1);
    const content = onMessage.mock.calls[0][1].content;
    expect(content).toContain('[Calendar Reminder]');
    expect(content).not.toContain('Location:');
    expect(content).not.toContain('Link:');
  });

  it('uses (No title) for events without summary', async () => {
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt-notitle',
            start: { dateTime: '2026-03-07T10:00:00-05:00' },
          },
        ],
      },
    });

    const ch = makeChannelWithMainGroup();
    await (ch as any).checkReminders();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][1].content).toContain('(No title)');
  });

  it('calls onDirectSend with the main JID and reminder text', async () => {
    mockEventsList.mockResolvedValue({
      data: {
        items: [makeEvent({ id: 'evt-direct', summary: 'Lunch' })],
      },
    });

    const ch = makeChannelWithMainGroup();
    await (ch as any).checkReminders();

    expect(onDirectSend).toHaveBeenCalledTimes(1);
    expect(onDirectSend).toHaveBeenCalledWith(
      'tg:main',
      expect.stringContaining('[Calendar Reminder] "Lunch"'),
    );
  });

  it('calls onDirectSend before onMessage for each reminder', async () => {
    const callOrder: string[] = [];
    onDirectSend.mockImplementation(() => callOrder.push('directSend'));
    onMessage.mockImplementation(() => callOrder.push('onMessage'));

    mockEventsList.mockResolvedValue({
      data: { items: [makeEvent({ id: 'evt-order' })] },
    });

    const ch = makeChannelWithMainGroup();
    await (ch as any).checkReminders();

    expect(callOrder).toEqual(['directSend', 'onMessage']);
  });

  it('still calls onMessage when onDirectSend is not provided', async () => {
    mockEventsList.mockResolvedValue({
      data: { items: [makeEvent({ id: 'evt-no-direct' })] },
    });

    const ch = new GoogleCalendarChannel({
      onMessage,
      registeredGroups: () => ({ 'tg:main': mainGroup }),
    });
    enableCalendar(ch);
    await (ch as any).checkReminders();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe('No main group', () => {
  it('does not crash and does not call onMessage or onDirectSend', async () => {
    const onMessage = vi.fn();
    const onDirectSend = vi.fn();
    mockEventsList.mockResolvedValue({
      data: { items: [makeEvent()] },
    });

    const ch = new GoogleCalendarChannel({
      onMessage,
      onDirectSend,
      registeredGroups: () => ({}),
    });
    enableCalendar(ch);
    await (ch as any).checkReminders();

    expect(onMessage).not.toHaveBeenCalled();
    expect(onDirectSend).not.toHaveBeenCalled();
  });
});

describe('Error backoff', () => {
  it('increments consecutiveErrors on failure and resets on success', async () => {
    const ch = new GoogleCalendarChannel({
      onMessage: vi.fn(),
      registeredGroups: () => ({}),
    });
    enableCalendar(ch);

    // Simulate API failure
    mockEventsList.mockRejectedValueOnce(new Error('API error'));
    await (ch as any).checkReminders();
    expect((ch as any).consecutiveErrors).toBe(1);

    // Another failure
    mockEventsList.mockRejectedValueOnce(new Error('API error'));
    await (ch as any).checkReminders();
    expect((ch as any).consecutiveErrors).toBe(2);

    // Success resets
    mockEventsList.mockResolvedValueOnce({ data: { items: [] } });
    await (ch as any).checkReminders();
    expect((ch as any).consecutiveErrors).toBe(0);
  });
});

describe('GCAL_REMINDER_MINUTES config', () => {
  it('uses configured reminder minutes in events.list timeMax', async () => {
    mockEventsList.mockClear();
    vi.mocked(readEnvFile).mockReturnValue({ GCAL_REMINDER_MINUTES: '30' });

    const onMessage = vi.fn();
    const ch = new GoogleCalendarChannel({
      onMessage,
      registeredGroups: () => ({ 'tg:main': mainGroup }),
    });
    enableCalendar(ch);

    mockEventsList.mockResolvedValue({ data: { items: [] } });
    await (ch as any).checkReminders();

    expect(mockEventsList).toHaveBeenCalledTimes(1);
    const callArgs = mockEventsList.mock.calls[0][0];
    const timeMin = new Date(callArgs.timeMin).getTime();
    const timeMax = new Date(callArgs.timeMax).getTime();
    const diffMinutes = (timeMax - timeMin) / (60 * 1000);
    expect(diffMinutes).toBeCloseTo(30, 0);
  });
});
