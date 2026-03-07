import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCollection = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();
const mockUpsert = vi.fn();
const mockSearch = vi.fn();
const mockGetCollections = vi.fn();

vi.mock('@qdrant/js-client-rest', () => {
  const MockClient = vi.fn(function (this: Record<string, unknown>) {
    this.getCollection = mockGetCollection;
    this.createCollection = mockCreateCollection;
    this.createPayloadIndex = mockCreatePayloadIndex;
    this.upsert = mockUpsert;
    this.search = mockSearch;
    this.getCollections = mockGetCollections;
  });
  return { QdrantClient: MockClient };
});

import { VectorStore, MessagePoint } from './vector-store.js';

let store: VectorStore;

beforeEach(() => {
  vi.clearAllMocks();
  store = new VectorStore('http://localhost:6333');
});

describe('ensureCollection', () => {
  it('creates collection if it does not exist', async () => {
    mockGetCollection.mockRejectedValueOnce(new Error('not found'));
    mockCreateCollection.mockResolvedValueOnce(undefined);
    mockCreatePayloadIndex.mockResolvedValueOnce(undefined);

    await store.ensureCollection();

    expect(mockCreateCollection).toHaveBeenCalledWith('messages', {
      vectors: { size: 384, distance: 'Cosine' },
    });
    expect(mockCreatePayloadIndex).toHaveBeenCalledWith('messages', {
      field_name: 'chat_jid',
      field_schema: 'keyword',
    });
  });

  it('skips creation if collection already exists', async () => {
    mockGetCollection.mockResolvedValueOnce({});

    await store.ensureCollection();

    expect(mockCreateCollection).not.toHaveBeenCalled();
  });

  it('only checks once (caches ready state)', async () => {
    mockGetCollection.mockResolvedValueOnce({});

    await store.ensureCollection();
    await store.ensureCollection();

    expect(mockGetCollection).toHaveBeenCalledTimes(1);
  });
});

describe('upsert', () => {
  it('transforms MessagePoints to Qdrant format', async () => {
    mockGetCollection.mockResolvedValueOnce({});
    mockUpsert.mockResolvedValueOnce(undefined);

    const points: MessagePoint[] = [
      {
        id: 'msg1',
        chatJid: 'group@g.us',
        vector: new Array(384).fill(0.1),
        payload: {
          content: 'hello',
          sender: 'user1',
          sender_name: 'User One',
          timestamp: '2024-01-01T00:00:00.000Z',
          chat_jid: 'group@g.us',
        },
      },
    ];

    await store.upsert(points);

    expect(mockUpsert).toHaveBeenCalledWith('messages', {
      points: [
        expect.objectContaining({
          vector: points[0].vector,
          payload: points[0].payload,
        }),
      ],
    });
  });
});

describe('search', () => {
  it('applies chat_jid filter when provided', async () => {
    mockGetCollection.mockResolvedValueOnce({});
    mockSearch.mockResolvedValueOnce([
      {
        score: 0.95,
        payload: {
          content: 'hello',
          sender: 'user1',
          timestamp: '2024-01-01T00:00:00.000Z',
          chat_jid: 'group@g.us',
        },
      },
    ]);

    const results = await store.search(new Array(384).fill(0.1), 'group@g.us', 5);

    expect(mockSearch).toHaveBeenCalledWith('messages', {
      vector: expect.any(Array),
      limit: 5,
      filter: {
        must: [{ key: 'chat_jid', match: { value: 'group@g.us' } }],
      },
      with_payload: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.95);
    expect(results[0].content).toBe('hello');
  });

  it('searches without filter when chatJid is null', async () => {
    mockGetCollection.mockResolvedValueOnce({});
    mockSearch.mockResolvedValueOnce([]);

    await store.search(new Array(384).fill(0.1), null, 5);

    expect(mockSearch).toHaveBeenCalledWith('messages', {
      vector: expect.any(Array),
      limit: 5,
      filter: undefined,
      with_payload: true,
    });
  });
});

describe('isHealthy', () => {
  it('returns true when Qdrant is reachable', async () => {
    mockGetCollections.mockResolvedValueOnce({ collections: [] });

    expect(await store.isHealthy()).toBe(true);
  });

  it('returns false on connection error', async () => {
    mockGetCollections.mockRejectedValueOnce(new Error('connection refused'));

    expect(await store.isHealthy()).toBe(false);
  });
});
