import type { Response } from './Handler.js';
import type { HttpRequest } from './HttpRequest.js';

/** A double-click happens within 200-500ms; five seconds covers it comfortably. */
export const DEFAULT_DEDUP_WINDOW_MS = 5_000;

export interface DuplicateGuardOptions {
  defaultWindowMs?: number;
  /** Safety net, not a tuning knob: bounds memory if a burst of distinct requests arrives. */
  maxEntries?: number;
  now?: () => number;
}

interface Remembered {
  response: Response;
  at: number;
}

export class DuplicateGuard {
  readonly defaultWindowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Insertion-ordered: the oldest fingerprint is always first. */
  private readonly seen = new Map<string, Remembered>();

  constructor(options: DuplicateGuardOptions = {}) {
    this.defaultWindowMs = options.defaultWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? (() => Date.now());
  }

  findRecent(req: HttpRequest, windowMs?: number): Response | undefined {
    const window = windowMs ?? this.defaultWindowMs;
    const key = fingerprint(req);
    const hit = this.seen.get(key);
    if (hit === undefined) return undefined;

    if (this.now() - hit.at >= window) {
      this.seen.delete(key);
      return undefined;
    }
    return hit.response;
  }

  remember(req: HttpRequest, response: Response): void {
    const key = fingerprint(req);
    this.seen.delete(key);
    this.seen.set(key, { response, at: this.now() });
    this.evictOldest();
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }

  private evictOldest(): void {
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done === true) return;
      this.seen.delete(oldest.value);
    }
  }
}

/** Method, path, query string, and a signature of the whole body. Exported for tests only. */
export function fingerprint(req: HttpRequest): string {
  const body = stableStringify(req.body);
  return [
    req.method.toUpperCase(),
    req.url,
    body.length,
    signature(body),
  ].join('\n');
}

/** 128-bit signature: a collision here would silently drop a legitimate write. */
function signature(text: string): string {
  return [
    mix32(text, 0x9747b28c),
    mix32(text, 0x85ebca6b),
    mix32(text, 0xc2b2ae35),
    mix32(text, 0x27d4eb2f),
  ]
    .map((h) => h.toString(16).padStart(8, '0'))
    .join('');
}

/** MurmurHash3-style 32-bit mixing, seeded, over UTF-16 code units two at a time. */
function mix32(text: string, seed: number): number {
  const C1 = 0xcc9e2d51;
  const C2 = 0x1b873593;
  let h = seed >>> 0;

  const pairs = text.length >> 1;
  for (let i = 0; i < pairs; i += 1) {
    let k = (text.charCodeAt(i * 2) | (text.charCodeAt(i * 2 + 1) << 16)) >>> 0;
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  if ((text.length & 1) === 1) {
    let k = text.charCodeAt(text.length - 1) >>> 0;
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
  }

  h ^= text.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Keys sorted so two objects built in a different order still stringify identically. */
function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}
