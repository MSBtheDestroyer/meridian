import type { OAuthUsageSnapshot, OAuthUsageWindow } from "./oauthUsage"
import type { RateLimitEntry } from "./rateLimitStore"
import { newestClaudeWindows } from "./usageReserve"

const MAX_USAGE_AGE_MS = 30_000

interface RouteQuery {
  readonly provider: string
  readonly model: string
  readonly variant: string
}

type Usage = {
  readonly fetchedAt: number | null
  readonly stale?: boolean
  readonly error?: unknown
  readonly failure?: unknown
  readonly windows: readonly OAuthUsageWindow[]
}

export function routeAvailability(route: RouteQuery, eligible: readonly Usage[], now: number) {
  let allotment = 0
  let observedAt: number | null = null
  for (const usage of eligible) {
    const at = usage.fetchedAt
    if (usage.stale || usage.error || usage.failure || at === null || !Number.isFinite(at) || now < at || now - at > MAX_USAGE_AGE_MS) continue
    if (usage.windows.length === 0) continue
    let remaining = 1
    for (const { utilization, resetsAt } of usage.windows) {
      if (utilization === null || !Number.isFinite(utilization) || utilization < 0 || utilization >= 1 ||
        resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) {
        remaining = 0
        break
      }
      remaining = Math.min(remaining, 1 - utilization)
    }
    if (remaining > allotment) {
      observedAt = at
      allotment = remaining
    }
  }
  return { ...route, version: 1, available: allotment > 0, routable_allotment: allotment, observed_at: observedAt }
}

export function claudeOpusReturnUsage(snapshot: OAuthUsageSnapshot, sdk: readonly RateLimitEntry[]): Usage | undefined {
  const governing = new Set(["five_hour", "seven_day", "seven_day_opus"])
  if (snapshot.stale || !snapshot.windows.some(window => window.type === "five_hour") ||
    !snapshot.windows.some(window => window.type === "seven_day")) return undefined
  if (sdk.some(event => event.observedAt >= snapshot.fetchedAt && event.rateLimitType &&
    governing.has(event.rateLimitType) && event.status === "rejected")) return undefined
  const windows = newestClaudeWindows(snapshot, sdk).filter(window => governing.has(window.type))
  return { fetchedAt: snapshot.fetchedAt, windows }
}
