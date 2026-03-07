import { createTask } from './db.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

const MIN_MESSAGES = 3;

export function tryExtractMemories(
  groupFolder: string,
  groupName: string,
  messages: NewMessage[],
  chatJid: string,
): void {
  if (messages.length < MIN_MESSAGES) return;

  const summary = messages
    .map(m => `${m.sender_name}: ${m.content}`)
    .join('\n')
    .slice(0, 3000);

  const prompt = `Review this conversation and extract important NEW facts worth remembering long-term. Write them to /workspace/group/memory.md following the existing format. Read memory.md first to avoid duplicates. If nothing new, do nothing.

<conversation>
${summary}
</conversation>

<internal>Automated memory extraction — do not send messages to the user.</internal>`;

  const runAt = new Date(Date.now() + 30_000).toISOString();
  try {
    createTask({
      id: `memex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt,
      schedule_type: 'once',
      schedule_value: runAt,
      context_mode: 'isolated',
      next_run: runAt,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.debug({ group: groupName }, 'Scheduled memory extraction');
  } catch (err) {
    logger.warn({ err, group: groupName }, 'Failed to schedule memory extraction');
  }
}
