import type { CodexUsageEntry, CodexUsageWindow } from "../codex/types"

const MAX_USAGE_AGE_MS = 30_000

interface RouteQuery {
  readonly provider: string
  readonly model: string
  readonly variant: string
}

type Usage = Readonly<Pick<CodexUsageEntry, "fetchedAt" | "stale" | "error" | "failure">> & {
  readonly windows: readonly CodexUsageWindow[]
}

export function chatGptRouteAvailability(route: RouteQuery, eligible: readonly Usage[], now: number) {
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
