import type { CodexUsageEntry } from "../codex/types"
import type { CodexPoolResult } from "../codex/pool"
import { createHash } from "node:crypto"
import { NO_ROUTABLE_ACCOUNT_CODE } from "../profileHealth"
import { capacityObservationIsFresh, type ManagedExclusionEvidence } from "../managedExclusionEvidence"
import { retryAfterHeaders, retryAfterSeconds } from "../retryAfter"
import type { UsageReserveState } from "../usageReserve"
import type { CodexAccountUsage } from "../codex/usage"
import type { ChatGptCreditsPolicy } from "./features"

export const CHATGPT_MANAGED_PROTECTION_REASONS: ReadonlySet<string> = new Set([
  "spent", "usage-reserve", "weekly-reserve", "loaner-gate",
])

export type ChatGptRouteRefusalReason = "quota_exhausted" | "reserve_held"

export function chatGptRefusalPoolKey(result: CodexPoolResult | undefined): string | undefined {
  if (!result?.pool || result.error) return
  return createHash("sha256").update(JSON.stringify(result.pool.accounts)).digest("hex")
}

export function chatGptRefusalBinding(headers: Headers, body: Record<string, unknown>) {
  const requestId = headers.get("x-request-id")
  const { model, reasoning } = body
  if (headers.get("x-meridian-route-refusal") !== "1" || headers.has("x-meridian-profile") ||
      headers.has("x-meridian-require") || headers.has("x-meridian-internal-hop") ||
      !requestId || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestId) ||
      typeof model !== "string" || !model || typeof reasoning !== "object" || reasoning === null ||
      !("effort" in reasoning) || typeof reasoning.effort !== "string" || !reasoning.effort) return
  return { requestId, model, variant: reasoning.effort }
}

function chatGptPlanExhaustedUntil(entry: CodexUsageEntry, now: number): number | null {
  const resets = entry.windows.flatMap(window => window.utilization === 1 && window.resetsAt !== null &&
    window.resetsAt > now && (window.limitWindowSeconds ?? 0) > 0 ? [window.resetsAt] : [])
  return resets.length > 0 ? Math.min(...resets) : null
}

export interface ChatGptRefusalInput {
  readonly binding: NonNullable<ReturnType<typeof chatGptRefusalBinding>>
  readonly poolKey: string
  readonly excluded: ReadonlySet<string>
  readonly listed: ReadonlySet<string>
  readonly reserveHeld: ReadonlyMap<string, UsageReserveState>
  readonly uncertainty: ReadonlySet<string>
  readonly newerSeatEvidence: (seat: string, observedAt: number) => boolean
}

export function proveChatGptRouteRefusal(input: ChatGptRefusalInput, fleet: {
  readonly seats: readonly string[]
  readonly entries: readonly CodexUsageEntry[]
  readonly usageEvidence: ReadonlyMap<string, CodexAccountUsage>
  readonly managed?: ManagedExclusionEvidence
  readonly now: number
  readonly currentExclusions: ReadonlySet<string>
  readonly profile: (seat: string) => string | undefined
  readonly blocked: (seat: string) => boolean
  readonly currentReserve: (seat: string) => UsageReserveState | null
  readonly creditsPolicy: (seat: string) => ChatGptCreditsPolicy
  readonly routeOffered: (plan: string) => boolean
}): { readonly reason: ChatGptRouteRefusalReason; readonly resetAt: number | null } | undefined {
  const { now, managed, seats } = fleet
  if (seats.length === 0 || input.uncertainty.size > 0 || input.excluded.size !== fleet.currentExclusions.size ||
      [...input.excluded].some(seat => !fleet.currentExclusions.has(seat))) return
  const allManaged = input.excluded.size > 0
  if (allManaged && (!managed || !capacityObservationIsFresh(managed.observedAt, now) ||
      seats.some(seat => !input.excluded.has(seat)))) return
  const entries = new Map(fleet.entries.map(entry => [entry.id, entry]))
  let reason: ChatGptRouteRefusalReason | undefined
  let fleetProtection: string | undefined
  const resets: number[] = []
  for (const seat of seats) {
    if (!input.listed.has(seat)) return
    const entry = entries.get(seat)
    const evidence = fleet.usageEvidence.get(seat)
    if (!entry?.plan || entry.fetchedAt === null || entry.stale || entry.error !== null || entry.failure !== null ||
        evidence?.identityConfirmed !== true || evidence.planType === null || evidence.fetchedAt !== entry.fetchedAt ||
        !capacityObservationIsFresh(entry.fetchedAt, now) || fleet.blocked(seat) ||
        input.newerSeatEvidence(seat, entry.fetchedAt) ||
        !fleet.routeOffered(entry.plan.slug)) return

    const profile = fleet.profile(seat)
    const managedReason = allManaged && profile ? managed?.reasons.get(profile) : undefined
    if (allManaged && !managedReason) return
    if (fleetProtection !== undefined && fleetProtection !== managedReason) return
    fleetProtection = managedReason
    const reserve = fleet.currentReserve(seat)
    const localReserve = input.reserveHeld.has(seat)
    if (localReserve && !reserve) return
    const protectedCapacity = managedReason ? managedReason !== "spent" : localReserve
    const nextReason = protectedCapacity ? "reserve_held" : "quota_exhausted"
    if (reason !== undefined && reason !== nextReason) return
    reason = nextReason

    const reset = chatGptPlanExhaustedUntil(entry, now)
    if (protectedCapacity) {
      if (reset !== null || entry.windows.length === 0 || entry.windows.some(window => window.utilization === null ||
          (window.limitWindowSeconds ?? 0) <= 0 || window.resetsAt === null || window.resetsAt <= now)) return
      if (localReserve && reserve?.opensAt != null && reserve.opensAt > now) resets.push(reserve.opensAt)
      continue
    }
    if (fleet.creditsPolicy(seat) !== "never" && !evidence.creditsProvenEmpty) return
    if (reset === null) return
    resets.push(reset)
  }
  return reason ? { reason, resetAt: resets.length > 0 ? Math.min(...resets) : null } : undefined
}

export function chatGptRouteRefusalResponse(
  binding: NonNullable<ReturnType<typeof chatGptRefusalBinding>>,
  proof: { readonly reason: ChatGptRouteRefusalReason; readonly resetAt: number | null },
  now: number,
): Response {
  return Response.json({ error: {
    type: "rate_limit_error", code: NO_ROUTABLE_ACCOUNT_CODE, request_id: binding.requestId,
    message: "No routable ChatGPT account can serve this request before dispatch.",
    route_refusal: { version: 1, phase: "before_inference", sent: false, provider: "chatgpt",
      model: binding.model, variant: binding.variant, reason: proof.reason },
  } }, { status: 429, headers: {
    "cache-control": "no-store", "x-meridian-route-refusal": "1",
    ...retryAfterHeaders(retryAfterSeconds({ status: 429, resetAtMs: proof.resetAt, now })),
  } })
}
