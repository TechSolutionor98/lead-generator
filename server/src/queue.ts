import PQueue from 'p-queue';
import { env } from './env.js';

/**
 * Per-source rate limiting + exponential backoff.
 *
 * Each source gets its own PQueue capped at REQ_PER_SEC requests/second so we
 * stay polite and within documented limits. withBackoff() retries transient
 * failures (429 / 5xx / network) up to maxRetries with exponential delay +
 * jitter, then gives up (caller logs and skips).
 */

const queues = new Map<string, PQueue>();

/**
 * Enqueue a task on a source's queue and get its typed result. PQueue.add()
 * widens the return type to `T | void` (for the aborted case); we never clear
 * these queues, so this helper narrows it back to T.
 */
export function enqueue<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  return queueFor(sourceId).add(fn) as Promise<T>;
}

export function queueFor(sourceId: string): PQueue {
  let q = queues.get(sourceId);
  if (!q) {
    q = new PQueue({
      // intervalCap requests per `interval` ms → REQ_PER_SEC per second.
      interval: 1000,
      intervalCap: Math.max(1, Math.round(env.REQ_PER_SEC)),
      concurrency: Math.max(1, Math.round(env.REQ_PER_SEC)),
    });
    queues.set(sourceId, q);
  }
  return q;
}

export class RetryableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RetryableError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BackoffOptions {
  maxRetries?: number;
  baseMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}

/**
 * Runs `fn`, retrying on RetryableError with exponential backoff + jitter.
 * Non-retryable errors propagate immediately.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {},
): Promise<T> {
  const { maxRetries = 5, baseMs = 250, log, signal } = opts;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= maxRetries) throw err;
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 200);
      attempt += 1;
      log?.(
        `retry ${attempt}/${maxRetries} after ${delay}ms` +
          (err.status ? ` (status ${err.status})` : '') +
          `: ${err.message}`,
      );
      await sleep(delay);
    }
  }
}

/** True if an HTTP status should trigger a backoff retry. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
