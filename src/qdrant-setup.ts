import { execSync } from 'child_process';
import { logger } from './logger.js';

export async function ensureQdrant(url: string, storageDir: string): Promise<boolean> {
  // 1. Check if Qdrant is already reachable
  try {
    const res = await fetch(url + '/healthz');
    if (res.ok) {
      logger.info('Qdrant is already running');
      return true;
    }
  } catch {
    // Not reachable, try to start it
  }

  logger.info('Qdrant not reachable, attempting auto-start via Docker...');

  // 2. Check if Docker is available
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    logger.warn('Docker is not available, cannot auto-start Qdrant');
    return false;
  }

  // 3. Check if qdrant container exists but is stopped
  try {
    const status = execSync('docker ps -a --filter name=^qdrant$ --format {{.Status}}', {
      encoding: 'utf-8',
    }).trim();

    if (status) {
      // Container exists
      if (!status.startsWith('Up')) {
        logger.info('Found stopped Qdrant container, restarting...');
        execSync('docker start qdrant', { stdio: 'ignore' });
      }
    } else {
      // No container exists, create one
      logger.info('Starting new Qdrant container...');
      execSync(
        `docker run -d --name qdrant -p 6333:6333 -v "${storageDir}":/qdrant/storage qdrant/qdrant`,
        { stdio: 'ignore' },
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to start Qdrant container');
    return false;
  }

  // 4. Wait for healthy (poll every 2s, up to 60s)
  const maxWait = 60_000;
  const interval = 2_000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    elapsed += interval;
    try {
      const res = await fetch(url + '/healthz');
      if (res.ok) {
        logger.info('Qdrant is now healthy');
        return true;
      }
    } catch {
      // Still not ready
    }
  }

  logger.warn('Qdrant did not become healthy within 60s');
  return false;
}
