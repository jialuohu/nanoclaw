import { embedBatch } from './embeddings.js';
import { logger } from './logger.js';
import { getUnembeddedMessages, markMessagesEmbedded } from './db.js';
import { VectorStore, MessagePoint } from './vector-store.js';

const POLL_INTERVAL = 10_000;
const BATCH_SIZE = 50;

export class EmbeddingWorker {
  private vectorStore: VectorStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(vectorStore: VectorStore) {
    this.vectorStore = vectorStore;
  }

  async start(): Promise<void> {
    const healthy = await this.vectorStore.isHealthy();
    if (!healthy) {
      logger.warn('Qdrant not reachable, embedding worker not started');
      return;
    }

    this.running = true;
    logger.info('Embedding worker started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Embedding worker stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.processLoop(), POLL_INTERVAL);
  }

  private async processLoop(): Promise<void> {
    if (!this.running) return;

    try {
      const messages = getUnembeddedMessages(BATCH_SIZE);
      if (messages.length === 0) {
        this.scheduleNext();
        return;
      }

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

      await this.vectorStore.upsert(points);
      markMessagesEmbedded(
        messages.map((m) => ({ id: m.id, chat_jid: m.chat_jid })),
      );

      logger.debug({ count: messages.length }, 'Embedded and indexed messages');
    } catch (err) {
      logger.error({ err }, 'Embedding worker error');
    }

    this.scheduleNext();
  }
}
