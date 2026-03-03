import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Transcribe an audio buffer using OpenAI's Whisper API.
 * Returns the transcript string on success, null if OPENAI_API_KEY is not set.
 * Throws on API errors so callers can handle failures explicitly.
 */
export async function transcribeAudio(buffer: Buffer): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.debug('OPENAI_API_KEY not set, skipping transcription');
    return null;
  }

  const { default: OpenAI, toFile } = await import('openai');
  const openai = new OpenAI({ apiKey });

  const file = await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' });
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'text',
  });

  // When response_format is 'text', the API returns a plain string
  return (transcription as unknown as string).trim();
}
