import type { OAuthUsageSnapshot, OAuthUsageWindow } from "./oauthUsage"
import { claudeModelFamily } from "./models"
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

const CLAUDE_WIRE_ID = /^claude-(?:opus|fable|mythos|sonnet|haiku)-\d+(?:-\d+)*$/
const FABLE_ALLOWANCE = ["seven_day_fable", "seven_day_overage_included"] as const

export function isExactClaudeWireModel(model: string): boolean {
  return model === CLAUDE_WIRE_ID.exec(model)?.[0]
}

export function claudeReturnUsage(model: string, snapshot: OAuthUsageSnapshot, sdk: readonly RateLimitEntry[]): Usage | undefined {
  const family = claudeModelFamily(model)
  const modelSlug = model.slice("claude-".length).replaceAll("-", "_")
  const exactScope = `seven_day_${modelSlug}`
  const tierScope = `seven_day_${modelSlug.replace(/^mythos_/, "fable_")}`
  const scoped = new Set([`seven_day_${family}`, exactScope, tierScope])
  if (family === "fable") {
    for (const bucket of FABLE_ALLOWANCE) scoped.add(bucket)
    if (modelSlug.startsWith("mythos_")) scoped.add("seven_day_mythos")
  }
  const governing = (type: string) => type === "five_hour" || type === "seven_day" || scoped.has(type)
  if (snapshot.stale || snapshot.unreadableWindowTypes?.some(governing) || !snapshot.windows.some(window => window.type === "five_hour") ||
    !snapshot.windows.some(window => window.type === "seven_day")) return undefined
  if (family === "fable" && !snapshot.windows.some(({ type }) => type === tierScope || FABLE_ALLOWANCE.some(bucket => bucket === type))) return undefined
  if (sdk.some(event => event.observedAt >= snapshot.fetchedAt &&
    (!event.rateLimitType || governing(event.rateLimitType)) &&
    (event.status === "rejected" || event.utilization === undefined || event.resetsAt === undefined))) return undefined
  const windows = newestClaudeWindows(snapshot, sdk).filter(window => governing(window.type))
  return { fetchedAt: snapshot.fetchedAt, windows }
}
