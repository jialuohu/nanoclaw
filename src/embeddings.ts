import path from 'path';
import { logger } from './logger.js';

let pipelineInstance: unknown = null;

async function getPipeline(): Promise<unknown> {
  if (pipelineInstance) return pipelineInstance;

  const { pipeline, env } = await import('@huggingface/transformers');

  // Cache models locally
  const cacheDir = path.resolve(process.cwd(), 'models');
  env.cacheDir = cacheDir;

  logger.info('Loading embedding model (first call may download ~80MB)...');
  pipelineInstance = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    {
      dtype: 'fp32',
    },
  );
  logger.info('Embedding model loaded');

  return pipelineInstance;
}

export async function embed(text: string): Promise<number[]> {
  const extractor = (await getPipeline()) as (
    text: string,
    options: { pooling: string; normalize: boolean },
  ) => Promise<{ tolist: () => number[][] }>;
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.tolist()[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const CHUNK_SIZE = 32;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const embeddings = await Promise.all(chunk.map((t) => embed(t)));
    results.push(...embeddings);
  }

  return results;
}
