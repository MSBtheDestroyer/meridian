import type { OAuthUsageSnapshot } from "./oauthUsage"
import type { RateLimitEntry } from "./rateLimitStore"
import type { ClaudeExtraUsagePolicy } from "./routing"

const MAX_AGE_MS = 120_000
const ACCOUNT_WINDOWS = ["five_hour", "seven_day"] as const

export function freshPlanExhaustion(input: {
  readonly now: number
  readonly policy: ClaudeExtraUsagePolicy
  readonly oauth?: OAuthUsageSnapshot
  readonly sdk: readonly RateLimitEntry[]
}): number | null {
  const { now, policy, oauth, sdk } = input
  const fresh = (at: number) => Number.isFinite(at) && at <= now && now - at <= MAX_AGE_MS
  if (policy !== "never" && (!oauth || oauth.stale || !fresh(oauth.fetchedAt) || oauth.extraUsage?.isEnabled !== false ||
    sdk.some(event => event.observedAt >= oauth.fetchedAt && event.isUsingOverage === true))) return null
  const resetTimes = ACCOUNT_WINDOWS.flatMap(type => {
    const observed = sdk.find(event => event.rateLimitType === type)
    const sampled = oauth?.windows.find(window => window.type === type)
    const window = observed && (!sampled || !oauth || observed.observedAt > oauth.fetchedAt)
      ? { at: observed.observedAt, utilization: observed.utilization, resetsAt: observed.resetsAt }
      : sampled && oauth && !oauth.stale
        ? { at: oauth.fetchedAt, utilization: sampled.utilization, resetsAt: sampled.resetsAt }
        : undefined
    return window && fresh(window.at) && window.utilization === 1 && typeof window.resetsAt === "number" &&
      Number.isFinite(window.resetsAt) && window.resetsAt > now ? [window.resetsAt] : []
  })
  return resetTimes.length === 0 ? null : Math.max(...resetTimes)
}
