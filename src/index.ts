import fs from 'fs';
import path from 'path';

import {
  AGENT_SELF_EVAL,
  ASSISTANT_NAME,
  AUTO_MEMORY_EXTRACTION,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  QDRANT_URL,
  QDRANT_STORAGE_DIR,
  SEMANTIC_SEARCH_ENABLED,
  SESSION_RESET_HOUR,
  TELEGRAM_BOT_POOL,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeConfigSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  clearAllSessions,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { initBotPool } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { tryExtractMemories } from './memory-extractor.js';
import { tryEvaluateConversation } from './self-eval.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { embed } from './embeddings.js';
import { VectorStore } from './vector-store.js';
import { EmbeddingWorker } from './embedding-worker.js';
import { ensureQdrant } from './qdrant-setup.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let vectorStore: VectorStore | undefined;
let sessionResetTimer: ReturnType<typeof setTimeout> | undefined;

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Retrieve semantically related past messages for context
  let contextPrefix = '';
  if (vectorStore && missedMessages.length > 0) {
    try {
      const queryText = missedMessages
        .map((m) => m.content)
        .join(' ')
        .slice(0, 500);
      const queryVector = await embed(queryText);
      const results = await vectorStore.search(queryVector, chatJid, 5);
      const cutoff = Date.now() - 5 * 60 * 1000;
      const relevant = results.filter(
        (r) => r.score >= 0.35 && new Date(r.timestamp).getTime() < cutoff,
      );
      if (relevant.length > 0) {
        const lines = relevant.map(
          (r) => `[${r.sender}] (${r.timestamp}): ${r.content.slice(0, 300)}`,
        );
        contextPrefix = `<context type="related_history" note="Past messages semantically related to the current conversation. Use as background — do not repeat or reference these unless relevant.">\n${lines.join('\n')}\n</context>\n\n`;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to retrieve semantic context');
    }
  }
  const fullPrompt = contextPrefix + prompt;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, fullPrompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
      setStarOfficeState('idle', 'Ready');
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  if (AUTO_MEMORY_EXTRACTION) {
    tryExtractMemories(group.folder, group.name, missedMessages, chatJid);
  }

  if (AGENT_SELF_EVAL) {
    tryEvaluateConversation(group.folder, group.name, missedMessages, chatJid);
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update config snapshot (main group only — gives agent access to .env values)
  if (isMain) {
    writeConfigSnapshot(group.folder);
  }

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Update Star-Office-UI status (best-effort)
  setStarOfficeState('writing', `Processing message for ${group.name}`);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      setStarOfficeState('error', output.error || 'Agent error');
      return 'error';
    }

    setStarOfficeState('idle', 'Ready');
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    setStarOfficeState(
      'error',
      err instanceof Error ? err.message : 'Agent error',
    );
    return 'error';
  }
}

/**
 * Update Star-Office-UI agent state (best-effort, non-blocking).
 */
function setStarOfficeState(state: string, detail: string): void {
  fetch('http://127.0.0.1:18791/set_state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, detail }),
  }).catch(() => {
    // Best-effort — Star-Office-UI may not be running
  });
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            setStarOfficeState(
              'writing',
              `Processing message for ${group.name}`,
            );
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/** Return an ISO string for the next occurrence of HH:MM local time. */
function nextOccurrence(hour: number, minute: number): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** Schedule daily session reset to compact agent context. */
function scheduleSessionReset(): void {
  const nextRun = nextOccurrence(SESSION_RESET_HOUR, 0);
  const delay = new Date(nextRun).getTime() - Date.now();
  logger.info({ nextRun }, 'Session reset scheduled');
  sessionResetTimer = setTimeout(() => {
    clearAllSessions();
    sessions = {};
    logger.info('Daily session reset: all agent sessions cleared');
    scheduleSessionReset();
  }, delay);
}

const AUTO_UPDATE_TASK_ID = 'task-auto-update-nanoclaw';
const AUTO_UPDATE_PROMPT = `You are running an automated NanoClaw update check. Follow these steps exactly:

1. cd /workspace/project
2. Run: git fetch upstream --prune
3. Check for new commits: git log HEAD..upstream/main --oneline
4. If no new commits, exit silently (do NOT send any message).
5. If there ARE new commits, attempt to merge:
   a. First do a dry-run: git merge --no-commit --no-ff upstream/main
   b. Check git status for conflicts.

   IF NO CONFLICTS:
   - git merge --abort (undo the dry-run)
   - git merge upstream/main --no-edit (real merge)
   - npm run build
   - npm test
   - If build AND tests pass: use send_message to report "✅ NanoClaw auto-updated. Commits merged: <list>. Restarting..." then use restart_service.
   - If build OR tests fail: git reset --hard HEAD~1, then use send_message to report "❌ NanoClaw auto-update failed (build/test error). Rolled back. Please run /update-nanoclaw manually." Include the error output.

   IF CONFLICTS:
   - Count conflicting files from git status.
   - If 3 or fewer files: attempt to resolve conflict markers (preserve local customizations, incorporate upstream fixes). Then git add, git commit --no-edit, npm run build, npm test.
     - If everything passes: send_message success + restart_service.
     - If fails: git merge --abort, send_message failure notification.
   - If more than 3 files conflict: git merge --abort, use send_message to report "⚠️ NanoClaw upstream has updates with <N> conflicting files. Please run /update-nanoclaw manually." List the conflicting files.

IMPORTANT: Always use the send_message MCP tool to communicate results. Do NOT just print output.
IMPORTANT: If there are no upstream changes, do NOT send any message — exit quietly.`;

function seedAutoUpdateTask(groups: Record<string, RegisteredGroup>): void {
  if (getTaskById(AUTO_UPDATE_TASK_ID)) return; // already exists

  // Find the main group's chat JID for sending notifications
  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
  if (!mainEntry) {
    logger.warn('No main group registered yet, skipping auto-update task seed');
    return;
  }
  const [mainJid, mainGroup] = mainEntry;

  createTask({
    id: AUTO_UPDATE_TASK_ID,
    group_folder: mainGroup.folder,
    chat_jid: mainJid,
    prompt: AUTO_UPDATE_PROMPT,
    schedule_type: 'cron',
    schedule_value: '0 3 * * *', // daily at 3 AM
    context_mode: 'isolated',
    next_run: nextOccurrence(3, 0),
    status: 'active',
    created_at: new Date().toISOString(),
    model: 'claude-opus-4-6',
    max_thinking_tokens: 10000,
  });
  logger.info('Seeded auto-update scheduled task (daily 3 AM)');
}

const BACKUP_TASK_ID = 'task-daily-backup-gdrive';
const BACKUP_PROMPT = `You are running an automated daily backup of the NanoClaw project directory. Follow these steps exactly:

1. cd /workspace/project
2. Create a timestamped backup archive:
   DATE=$(date +%Y-%m-%d)
   tar czf /tmp/nanoclaw-backup-$DATE.tar.gz --exclude=node_modules --exclude=dist .
3. Get the file size for reporting:
   BACKUP_SIZE=$(du -h /tmp/nanoclaw-backup-$DATE.tar.gz | cut -f1)
4. Upload the backup to Google Drive folder "nanoclaw/":
   a. Use the google_workspace MCP tools to find or create a folder named "nanoclaw" on Google Drive.
   b. Upload /tmp/nanoclaw-backup-$DATE.tar.gz into that folder.
5. After a successful upload:
   - Use send_message to report: "Backup complete: nanoclaw-backup-$DATE.tar.gz ($BACKUP_SIZE) uploaded to Google Drive nanoclaw/"
6. If any step fails:
   - Use send_message to report the error with details.
7. Clean up the local temp file:
   rm -f /tmp/nanoclaw-backup-*.tar.gz

IMPORTANT: Always use the send_message MCP tool to communicate results. Do NOT just print output.
IMPORTANT: Always clean up /tmp after upload, whether it succeeded or failed.`;

function seedBackupTask(groups: Record<string, RegisteredGroup>): void {
  if (getTaskById(BACKUP_TASK_ID)) return;

  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
  if (!mainEntry) {
    logger.warn('No main group registered yet, skipping backup task seed');
    return;
  }
  const [mainJid, mainGroup] = mainEntry;

  createTask({
    id: BACKUP_TASK_ID,
    group_folder: mainGroup.folder,
    chat_jid: mainJid,
    prompt: BACKUP_PROMPT,
    schedule_type: 'cron',
    schedule_value: '0 2 * * *',
    context_mode: 'isolated',
    next_run: nextOccurrence(2, 0),
    status: 'active',
    created_at: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    max_thinking_tokens: 10000,
  });
  logger.info('Seeded backup scheduled task (daily 2 AM)');
}

const RETROSPECTIVE_TASK_ID = 'task-weekly-retrospective';
const RETROSPECTIVE_PROMPT = `You are running a weekly self-retrospective. Steps:

1. Read /workspace/group/reflections.md (per-conversation evaluations).
2. List /workspace/group/conversations/ — find files from the last 7 days (YYYY-MM-DD prefixed).
3. Read the 5 most recent conversation archives (first 100 lines each if large).
4. Read /workspace/group/memory.md for user context.

Analyze patterns:
- What mistakes recurred across conversations?
- What topics come up frequently?
- What context sources did you fail to use?
- What communication style adjustments would help?

Write to /workspace/group/reflections.md:

### Weekly Retrospective [YYYY-MM-DD]
- Pattern 1: [description + concrete adjustment]
- Pattern 2: ...

Keep to 3-5 actionable items. Focus on patterns, not one-offs.

If you identify rules for CLAUDE.md, note under "### Proposed CLAUDE.md Updates" — do NOT modify CLAUDE.md directly.

<internal>Automated weekly retrospective — do not send messages to the user.</internal>`;

function seedRetrospectiveTask(groups: Record<string, RegisteredGroup>): void {
  if (getTaskById(RETROSPECTIVE_TASK_ID)) return;

  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
  if (!mainEntry) return;
  const [mainJid, mainGroup] = mainEntry;

  createTask({
    id: RETROSPECTIVE_TASK_ID,
    group_folder: mainGroup.folder,
    chat_jid: mainJid,
    prompt: RETROSPECTIVE_PROMPT,
    schedule_type: 'cron',
    schedule_value: '0 4 * * 0',
    context_mode: 'isolated',
    next_run: nextOccurrence(4, 0),
    status: 'active',
    created_at: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    max_thinking_tokens: 10000,
  });
  logger.info('Seeded retrospective task (weekly Sunday 4 AM)');
}

const EMAIL_DIGEST_TASK_ID = 'task-daily-email-digest';
const EMAIL_DIGEST_PROMPT = `You are running an automated daily email digest. Follow these steps:

1. Atomically grab the digest queue to avoid losing emails that arrive during processing:
   mv /workspace/group/email-digest-queue.json /workspace/group/email-digest-queue.processing.json 2>/dev/null
   - If the mv fails (file missing), exit silently — no digest to send.
2. Read /workspace/group/email-digest-queue.processing.json
   - If it contains an empty array [] or is empty, remove the file and exit silently.
3. Parse the JSON array of email entries. Each entry has: account, sender, senderName, subject, snippet, timestamp.
4. Summarize ALL entries into one concise paragraph (2-4 sentences). Group by topic or theme when possible. Mention sender names and subjects for the most notable items.
5. Send the summary using send_message with format:
   "Daily Email Digest:\\n\\n<your summary paragraph>\\n\\nTotal: <count> emails from <unique sender count> senders."
6. Clean up:
   rm -f /workspace/group/email-digest-queue.processing.json

IMPORTANT: Always use the send_message MCP tool to communicate. Do NOT just print output.
IMPORTANT: If the queue is empty or missing, do nothing — no message, no error.`;

function seedEmailDigestTask(groups: Record<string, RegisteredGroup>): void {
  if (getTaskById(EMAIL_DIGEST_TASK_ID)) return;

  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
  if (!mainEntry) {
    logger.warn(
      'No main group registered yet, skipping email digest task seed',
    );
    return;
  }
  const [mainJid, mainGroup] = mainEntry;

  createTask({
    id: EMAIL_DIGEST_TASK_ID,
    group_folder: mainGroup.folder,
    chat_jid: mainJid,
    prompt: EMAIL_DIGEST_PROMPT,
    schedule_type: 'cron',
    schedule_value: '0 21 * * *',
    context_mode: 'isolated',
    next_run: nextOccurrence(21, 0),
    status: 'active',
    created_at: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    max_thinking_tokens: 10000,
  });
  logger.info('Seeded email digest scheduled task (daily 9 PM)');
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  scheduleSessionReset();

  // Semantic search: embedding worker + vector store
  let embeddingWorker: EmbeddingWorker | undefined;

  if (SEMANTIC_SEARCH_ENABLED) {
    const qdrantReady = await ensureQdrant(QDRANT_URL, QDRANT_STORAGE_DIR);
    if (qdrantReady) {
      vectorStore = new VectorStore(QDRANT_URL);
      embeddingWorker = new EmbeddingWorker(vectorStore);
      embeddingWorker
        .start()
        .catch((err) =>
          logger.warn({ err }, 'Embedding worker failed to start'),
        );
    } else {
      logger.warn(
        'Qdrant not available, semantic search disabled for this session',
      );
    }
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (sessionResetTimer) clearTimeout(sessionResetTimer);
    embeddingWorker?.stop();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onDirectSend: (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot direct-send');
        return;
      }
      channel
        .sendMessage(jid, text)
        .catch((err) => logger.error({ err, jid }, 'Direct-send failed'));
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  const pendingChannels: Array<{ name: string; channel: Channel }> = [];
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    pendingChannels.push({ name: channelName, channel });
  }

  const results = await Promise.allSettled(
    pendingChannels.map(({ name, channel }) =>
      channel.connect().then(() => ({ name, channel })),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      channels.push(result.value.channel);
    } else {
      logger.error(
        { channel: pendingChannels[i].name, err: result.reason },
        'Channel failed to connect — skipping',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent swarm
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  seedAutoUpdateTask(registeredGroups);
  seedBackupTask(registeredGroups);
  seedEmailDigestTask(registeredGroups);
  if (AGENT_SELF_EVAL) {
    seedRetrospectiveTask(registeredGroups);
  }
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    semanticSearch: vectorStore
      ? async (chatJid, query, topK) => {
          const queryVector = await embed(query);
          return vectorStore!.search(queryVector, chatJid, topK);
        }
      : undefined,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
