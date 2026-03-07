import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPipeline = vi.fn();
vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
  env: { cacheDir: '' },
}));

// Reset module state between tests so lazy-loading works fresh each time
beforeEach(async () => {
  vi.resetModules();
  mockPipeline.mockReset();
});

describe('embed', () => {
  it('returns a vector of the correct dimension', async () => {
    const fakeVector = Array.from({ length: 384 }, (_, i) => i * 0.001);
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [fakeVector],
    });
    mockPipeline.mockResolvedValue(extractor);

    const { embed } = await import('./embeddings.js');
    const result = await embed('hello world');

    expect(result).toHaveLength(384);
    expect(result).toEqual(fakeVector);
    expect(extractor).toHaveBeenCalledWith('hello world', {
      pooling: 'mean',
      normalize: true,
    });
  });
});

describe('embedBatch', () => {
  it('processes texts in chunks and returns all embeddings', async () => {
    const makeVector = (seed: number) =>
      Array.from({ length: 384 }, (_, i) => seed + i * 0.001);

    const extractor = vi.fn().mockImplementation((text: string) =>
      Promise.resolve({
        tolist: () => [makeVector(text.length)],
      }),
    );
    mockPipeline.mockResolvedValue(extractor);

    const { embedBatch } = await import('./embeddings.js');
    const texts = ['a', 'bb', 'ccc'];
    const result = await embedBatch(texts);

    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(384);
    expect(result[1]).toHaveLength(384);
    expect(result[2]).toHaveLength(384);
  });

  it('returns empty array for empty input', async () => {
    const extractor = vi.fn();
    mockPipeline.mockResolvedValue(extractor);

    const { embedBatch } = await import('./embeddings.js');
    const result = await embedBatch([]);

    expect(result).toHaveLength(0);
    expect(extractor).not.toHaveBeenCalled();
  });
});
