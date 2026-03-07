import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./embeddings.js', () => ({
  embed: vi.fn(),
  embedBatch: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getUnembeddedMessages: vi.fn(),
  markMessagesEmbedded: vi.fn(),
}));

vi.mock('./vector-store.js', () => ({
  VectorStore: vi.fn(),
}));

import { EmbeddingWorker } from './embedding-worker.js';
import { embedBatch } from './embeddings.js';
import { getUnembeddedMessages, markMessagesEmbedded } from './db.js';

const mockEmbedBatch = vi.mocked(embedBatch);
const mockGetUnembedded = vi.mocked(getUnembeddedMessages);
const mockMarkEmbedded = vi.mocked(markMessagesEmbedded);

function makeMockVectorStore(healthy = true) {
  return {
    isHealthy: vi.fn().mockResolvedValue(healthy),
    upsert: vi.fn().mockResolvedValue(undefined),
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe('EmbeddingWorker', () => {
  it('does not start if Qdrant is not healthy', async () => {
    const store = makeMockVectorStore(false);
    const worker = new EmbeddingWorker(store as any);

    await worker.start();

    expect(store.isHealthy).toHaveBeenCalled();
    // No processing should happen
    mockGetUnembedded.mockReturnValue([]);
    vi.advanceTimersByTime(15_000);
    expect(mockGetUnembedded).not.toHaveBeenCalled();

    worker.stop();
  });

  it('processes unembedded messages in batches', async () => {
    const store = makeMockVectorStore(true);
    const worker = new EmbeddingWorker(store as any);

    const messages = [
      {
        id: 'msg1',
        chat_jid: 'group@g.us',
        sender: 'user1@s.whatsapp.net',
        sender_name: 'User One',
        content: 'hello world',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ];

    mockGetUnembedded.mockReturnValue(messages);
    mockEmbedBatch.mockResolvedValue([new Array(384).fill(0.1)]);

    await worker.start();

    // Advance past the poll interval
    await vi.advanceTimersByTimeAsync(11_000);

    expect(mockGetUnembedded).toHaveBeenCalledWith(50);
    expect(mockEmbedBatch).toHaveBeenCalledWith(['User One: hello world']);
    expect(store.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'msg1',
        chatJid: 'group@g.us',
      }),
    ]);
    expect(mockMarkEmbedded).toHaveBeenCalledWith([
      { id: 'msg1', chat_jid: 'group@g.us' },
    ]);

    worker.stop();
  });

  it('skips when no unembedded messages', async () => {
    const store = makeMockVectorStore(true);
    const worker = new EmbeddingWorker(store as any);

    mockGetUnembedded.mockReturnValue([]);

    await worker.start();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(mockGetUnembedded).toHaveBeenCalled();
    expect(mockEmbedBatch).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();

    worker.stop();
  });

  it('continues processing after an error', async () => {
    const store = makeMockVectorStore(true);
    const worker = new EmbeddingWorker(store as any);

    const messages = [
      {
        id: 'msg1',
        chat_jid: 'group@g.us',
        sender: 'user1@s.whatsapp.net',
        sender_name: 'User One',
        content: 'hello world',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ];

    // First call: embedBatch throws
    mockGetUnembedded.mockReturnValue(messages);
    mockEmbedBatch.mockRejectedValueOnce(new Error('model error'));

    await worker.start();
    await vi.advanceTimersByTimeAsync(11_000);

    // embedBatch was called but threw
    expect(mockEmbedBatch).toHaveBeenCalledTimes(1);
    expect(store.upsert).not.toHaveBeenCalled();

    // Second tick: should retry (worker continues despite error)
    mockEmbedBatch.mockResolvedValueOnce([new Array(384).fill(0.1)]);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(mockEmbedBatch).toHaveBeenCalledTimes(2);
    expect(store.upsert).toHaveBeenCalled();

    worker.stop();
  });

  it('stops cleanly and does not process after stop', async () => {
    const store = makeMockVectorStore(true);
    const worker = new EmbeddingWorker(store as any);

    mockGetUnembedded.mockReturnValue([]);

    await worker.start();
    worker.stop();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(mockGetUnembedded).not.toHaveBeenCalled();
  });
});
