/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'get_current_time',
  'Get the current local time and timezone. Use this before scheduling tasks to ensure correct timing.',
  {},
  async () => {
    const tz = process.env.TZ || 'UTC';
    const now = new Date();
    return {
      content: [{
        type: 'text' as const,
        text: `Current time: ${now.toLocaleString('en-US', { timeZone: tz })} (${tz})\nISO (UTC): ${now.toISOString()}`,
      }],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

MODEL SELECTION - Optionally specify which Claude model runs the task:
• Omit to use the system default (CLAUDE_MODEL from config)
• Use a full model ID like "claude-sonnet-4-20250514" or "claude-opus-4-20250514"

SCHEDULE VALUE FORMAT (system timezone: ${process.env.TZ || 'UTC'}):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Timestamp (e.g., "2026-02-01T15:30:00" for local time, or "2026-02-01T23:30:00Z" for UTC)`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: timestamp like "2026-02-01T15:30:00" (local) or "2026-02-01T23:30:00Z" (UTC)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    model: z.string().optional().describe('Claude model to use (e.g., "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"). Omit to use system default.'),
    max_thinking_tokens: z.number().optional().describe('Extended thinking token budget. Higher values allow deeper reasoning. Omit to use default.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use format like "2026-02-01T15:30:00" or "2026-02-01T15:30:00Z".` }],
          isError: true,
        };
      }
      // Normalize to explicit UTC for unambiguous IPC
      args = { ...args, schedule_value: date.toISOString() };
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, string | number | undefined> = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
      model: args.model || undefined,
      max_thinking_tokens: args.max_thinking_tokens || undefined,
    };

    writeIpcFile(TASKS_DIR, data);

    const fireInfo = args.schedule_type === 'once'
      ? ` (fires at ${new Date(args.schedule_value).toLocaleString('en-US', { timeZone: process.env.TZ || 'UTC' })} ${process.env.TZ || 'UTC'})`
      : '';
    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}${fireInfo}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string; model?: string | null }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}${t.model ? `, model: ${t.model}` : ''}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    model: z.string().optional().describe('New model for the task. Set to empty string "" to clear and use system default.'),
    max_thinking_tokens: z.number().optional().describe('New thinking token budget. Set to 0 to clear.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.model !== undefined) data.model = args.model;
    if (args.max_thinking_tokens !== undefined) data.max_thinking_tokens = String(args.max_thinking_tokens);

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'get_config',
  'Read the current NanoClaw configuration (.env values). Secret keys (API tokens, bot tokens) are redacted. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can read config.' }],
        isError: true,
      };
    }

    const snapshotFile = path.join(IPC_DIR, 'config_snapshot.json');
    try {
      const config = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
      const lines = Object.entries(config)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      return {
        content: [{ type: 'text' as const, text: lines || 'No config values found.' }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: 'No config snapshot available.' }],
        isError: true,
      };
    }
  },
);

server.tool(
  'set_config',
  'Update a .env configuration value. Requires restart_service to take effect. Main group only.',
  {
    key: z.string().describe('The config key (e.g., CLAUDE_MODEL, TELEGRAM_ALLOWED_USERS)'),
    value: z.string().describe('The new value to set'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can set config.' }],
        isError: true,
      };
    }

    const data = {
      type: 'set_config',
      key: args.key,
      value: args.value,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Config update requested: ${args.key}=${args.value}. Use restart_service to apply.` }],
    };
  },
);

server.tool(
  'restart_service',
  'Restart the NanoClaw service to apply config changes. Main group only. The current agent session will end.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can restart the service.' }],
        isError: true,
      };
    }

    const data = {
      type: 'restart_service',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Service restart requested. The service will restart momentarily.' }],
    };
  },
);

server.tool(
  'search_history',
  `Search past conversation history using semantic similarity. Finds messages related to your query even without exact word matches. Use to recall previous discussions or find what was said about a topic.`,
  {
    query: z.string().describe('What to search for (natural language)'),
    chat_jid: z.string().optional().describe('Limit to specific chat. Omit to search current chat.'),
    top_k: z.number().optional().default(5).describe('Number of results (default 5, max 20)'),
  },
  async (args) => {
    const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const topK = Math.min(args.top_k ?? 5, 20);

    writeIpcFile(TASKS_DIR, {
      type: 'semantic_search',
      requestId,
      query: args.query,
      chatJid: args.chat_jid || chatJid,
      topK,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
    const POLL_MS = 200;
    const TIMEOUT_MS = 30000;
    const start = Date.now();

    while (Date.now() - start < TIMEOUT_MS) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);

          if (response.error) {
            return { content: [{ type: 'text' as const, text: `Search error: ${response.error}` }], isError: true };
          }
          if (!response.results || response.results.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No relevant messages found.' }] };
          }

          const formatted = response.results
            .map((r: { sender: string; timestamp: string; content: string; score: number }, i: number) =>
              `${i + 1}. [${r.sender}] (${r.timestamp}, score: ${r.score.toFixed(2)})\n   ${r.content.slice(0, 300)}${r.content.length > 300 ? '...' : ''}`
            )
            .join('\n\n');

          return { content: [{ type: 'text' as const, text: `Found ${response.results.length} relevant messages:\n\n${formatted}` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to read search response: ${err}` }], isError: true };
        }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }

    return { content: [{ type: 'text' as const, text: 'Search timed out. The search service may be unavailable.' }], isError: true };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
