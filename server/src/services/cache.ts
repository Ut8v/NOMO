interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Small in-memory TTL cache. Its job is to keep repeated chart and quote
 * requests from burning through Polygon's free tier request budget.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 200) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Reclaim expired entries before sacrificing a live one; short and
      // long TTL entries share this cache, so insertion order alone would
      // evict valid daily bars while stale intraday bars sit around.
      this.sweepExpired();
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }
}
