import { createTask } from './db.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

const MIN_MESSAGES = 3;

export function tryEvaluateConversation(
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

  const prompt = `Review this conversation and evaluate your own performance. Read /workspace/group/reflections.md first (if it exists) to avoid duplicates.

Evaluate:
- Was the response helpful, accurate, and on-topic?
- Did you miss available context? (Check memory.md, conversations/)
- Did the user correct or redirect you?
- Were there communication style issues?

If you identify concrete improvements, append to /workspace/group/reflections.md:

### [Category]
- [YYYY-MM-DD] Observation

Categories: Accuracy, Context Usage, Communication Style, Knowledge Gaps, Recurring Issues

If the conversation went well, do nothing — don't write generic praise.

<conversation>
${summary}
</conversation>

<internal>Automated self-evaluation — do not send messages to the user.</internal>`;

  const runAt = new Date(Date.now() + 45_000).toISOString();
  try {
    createTask({
      id: `selfeval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt,
      schedule_type: 'once',
      schedule_value: runAt,
      context_mode: 'isolated',
      next_run: runAt,
      status: 'active',
      created_at: new Date().toISOString(),
      model: 'claude-sonnet-4-6',
    });
    logger.debug({ group: groupName }, 'Scheduled self-evaluation');
  } catch (err) {
    logger.warn({ err, group: groupName }, 'Failed to schedule self-evaluation');
  }
}
