import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { logger } from './logger.js';

const COLLECTION_NAME = 'messages';
const VECTOR_SIZE = 384;

export interface MessagePoint {
  id: string;
  chatJid: string;
  vector: number[];
  payload: {
    content: string;
    sender: string;
    sender_name: string;
    timestamp: string;
    chat_jid: string;
  };
}

export interface SearchResult {
  score: number;
  content: string;
  sender: string;
  timestamp: string;
  chatJid: string;
}

function pointId(id: string, chatJid: string): string {
  return crypto
    .createHash('md5')
    .update(id + ':' + chatJid)
    .digest('hex');
}

export class VectorStore {
  private client: QdrantClient;
  private collectionReady = false;

  constructor(url: string) {
    this.client = new QdrantClient({ url });
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;

    try {
      await this.client.getCollection(COLLECTION_NAME);
    } catch {
      await this.client.createCollection(COLLECTION_NAME, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      });
      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'chat_jid',
        field_schema: 'keyword',
      });
      logger.info('Created Qdrant collection: messages');
    }

    this.collectionReady = true;
  }

  async upsert(points: MessagePoint[]): Promise<void> {
    await this.ensureCollection();

    await this.client.upsert(COLLECTION_NAME, {
      points: points.map((p) => ({
        id: pointId(p.id, p.chatJid),
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(
    queryVector: number[],
    chatJid: string | null,
    topK: number,
  ): Promise<SearchResult[]> {
    await this.ensureCollection();

    const filter = chatJid
      ? {
          must: [
            {
              key: 'chat_jid',
              match: { value: chatJid },
            },
          ],
        }
      : undefined;

    const results = await this.client.search(COLLECTION_NAME, {
      vector: queryVector,
      limit: topK,
      filter,
      with_payload: true,
    });

    return results.map((r) => ({
      score: r.score,
      content: (r.payload?.content as string) || '',
      sender: (r.payload?.sender as string) || '',
      timestamp: (r.payload?.timestamp as string) || '',
      chatJid: (r.payload?.chat_jid as string) || '',
    }));
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }
}
