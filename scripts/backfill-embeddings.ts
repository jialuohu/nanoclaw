import { initDatabase, getUnembeddedMessages, markMessagesEmbedded } from '../src/db.js';
import { embedBatch } from '../src/embeddings.js';
import { VectorStore, MessagePoint } from '../src/vector-store.js';
import { logger } from '../src/logger.js';

const BATCH_SIZE = 100;
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

async function main() {
  initDatabase();
  const vectorStore = new VectorStore(QDRANT_URL);

  const healthy = await vectorStore.isHealthy();
  if (!healthy) {
    logger.error('Qdrant is not reachable at ' + QDRANT_URL);
    process.exit(1);
  }

  let total = 0;

  while (true) {
    const messages = getUnembeddedMessages(BATCH_SIZE);
    if (messages.length === 0) break;

    const texts = messages.map((m) => `${m.sender_name}: ${m.content}`);
    const vectors = await embedBatch(texts);

    const points: MessagePoint[] = messages.map((m, i) => ({
      id: m.id,
      chatJid: m.chat_jid,
      vector: vectors[i],
      payload: {
        content: m.content,
        sender: m.sender,
        sender_name: m.sender_name,
        timestamp: m.timestamp,
        chat_jid: m.chat_jid,
      },
    }));

    await vectorStore.upsert(points);
    markMessagesEmbedded(
      messages.map((m) => ({ id: m.id, chat_jid: m.chat_jid })),
    );

    total += messages.length;
    logger.info({ batch: messages.length, total }, 'Backfill progress');
  }

  logger.info({ total }, 'Backfill complete');
}

main().catch((err) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
