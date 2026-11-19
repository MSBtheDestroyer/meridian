/**
 * "Refresh usage" on a profile card: the per-profile gate that keeps repeated
 * clicks from reaching the provider more than once per interval, and which
 * windows a fresh reading shows open again.
 *
 * Leaf module: no imports beyond types.
 */

/** One explicit re-read per profile in this span, whoever clicks. */
export const USAGE_REFRESH_MIN_INTERVAL_MS = 30_000

export class UsageRefreshGate {
  private readonly lastAt = new Map<string, number>()

  constructor(private readonly intervalMs = USAGE_REFRESH_MIN_INTERVAL_MS) {}

  /** Claims the key's slot; refused, says how long until the next one opens. */
  claim(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const last = this.lastAt.get(key)
    if (last !== undefined && now - last < this.intervalMs) return { ok: false, retryAfterMs: last + this.intervalMs - now }
    this.lastAt.set(key, now)
    return { ok: true }
  }

  forget(key: string): void {
    this.lastAt.delete(key)
  }
}

/**
 * The windows a reading shows below their limit. A reset made outside
 * Meridian reopens them while the refusals it remembers still say spent;
 * these are the buckets those refusals may be cleared for.
 */
export function openedWindowTypes(windows: readonly { readonly type: string; readonly utilization: number | null }[]): string[] {
  return windows.filter(w => w.utilization !== null && w.utilization < 1).map(w => w.type)
}
