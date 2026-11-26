/**
 * A ChatGPT seat's banked rate-limit resets: listed on /v1/usage/quota/all in
 * the shape a Claude profile's `bankedResets` has, and redeemed through the
 * same `POST /v1/usage/quota/reset` (chatgpt-backend SPEC, "Banked resets").
 *
 * NOTE: agent-specific. The credits come from undocumented chatgpt.com
 * endpoints: `GET /wham/rate-limit-reset-credits`, read with the seat's usage
 * (codex/usage.ts), and `POST /wham/rate-limit-reset-credits/consume`, which
 * only this module calls. A credit is finite and spending it is irreversible,
 * so nothing here redeems on its own: only an explicit request naming one.
 *
 * The vendor's credit ids (`RateLimitResetCredit_1` in oc-codex-multi-auth's
 * fixtures) do not fit the route's grant-id format, so each credit is listed
 * under a stable alias of its id. A redemption reads the list again and finds
 * the credit by that alias, which also proves it is still available, on this
 * seat, before anything is spent.
 */
import { createHash } from "node:crypto"
import { codexRequestHeaders, fetchCodexAccountUsage } from "../codex/usage"
import type { CodexResetCredits, CodexUsageError } from "../codex/types"
import { QuotaResetLedger, type QuotaResetAttempt, type QuotaResetOutcome, type QuotaResetRequest, type QuotaResetResult } from "../quotaReset"
import { FIVE_HOUR_WINDOW, SEVEN_DAY_WINDOW, profileWindowType } from "./profiles"
import type { ChatGptCredentialSource } from "./source"

const CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
const CONSUME_TIMEOUT_MS = 25_000
const ERROR_BODY_MAX_CHARS = 4096
const PROVIDER_CODE_FORMAT = /^[A-Za-z0-9_.-]{1,64}$/
/** A credit clears the seat's 5-hour and weekly windows. */
const CREDIT_CLEARS: readonly string[] = [FIVE_HOUR_WINDOW, SEVEN_DAY_WINDOW]

export interface ChatGptBankedResetGrant {
  id: string
  resetsLeft: 1
  expiresAt: number | null
  /** When the credit was granted: it is usable from then on. */
  startsAt: number | null
  paused: false
  /** The seat-wide `applicable_available_count` > 0; null when the payload stated none. */
  usableNow: boolean | null
  kind: "full"
  providerType: string | null
  clears: string[]
  givesBackWeekly: null
  description: string | null
  /** The seat's current reading of each window in `clears`, 0..100. */
  percentUsed: Record<string, number>
}

export interface ChatGptBankedResets {
  eligible: boolean
  ineligibleReason: string | null
  nextGrantId: string | null
  grants: ChatGptBankedResetGrant[]
  /** Credits the seat holds that cannot be listed as grants: the list was unreadable, or an entry had no id. */
  unreadableGrants: number
}

/** The grant id a credit is listed and redeemed under. */
export function chatGptCreditGrantId(creditId: string): string {
  return `credit_${createHash("sha256").update(creditId).digest("hex").slice(0, 24)}`
}

/** The seat's windows a credit clears, as the seat reports them. */
export function chatGptCreditClears(windowTypes: readonly string[]): string[] {
  return [...new Set(windowTypes.filter(type => CREDIT_CLEARS.includes(type)))]
}

/**
 * A seat's credits in the shape of a Claude profile's `bankedResets`. Null when
 * nothing is known about them. A list that could not be read keeps the count
 * the usage payload states as unreadable grants rather than claiming none.
 *
 * `redeemable` is false where another program owns the seat's sign-in: the
 * credits are still listed, but this Meridian does not spend them.
 */
export function chatGptBankedResets(
  resets: CodexResetCredits | null | undefined,
  windows: readonly { type: string; utilization: number | null }[],
  redeemable: boolean,
): ChatGptBankedResets | null {
  if (!resets) return null
  const eligibility = redeemable
    ? { eligible: true, ineligibleReason: null }
    : { eligible: false, ineligibleReason: "external_owner" }
  if (resets.credits === null) {
    const held = resets.availableCount
    if (held === null || !Number.isSafeInteger(held) || held < 0) return null
    return { ...eligibility, nextGrantId: null, grants: [], unreadableGrants: held }
  }

  const clears = chatGptCreditClears(windows.map(window => window.type))
  const percentUsed: Record<string, number> = {}
  for (const window of windows) {
    if (clears.includes(window.type) && window.utilization !== null) percentUsed[window.type] = Math.round(window.utilization * 10_000) / 100
  }
  const usableNow = resets.applicableAvailableCount === null ? null : resets.applicableAvailableCount > 0

  const grants: ChatGptBankedResetGrant[] = []
  let unlisted = 0
  for (const credit of resets.credits) {
    if (credit.id === null) {
      unlisted++
      continue
    }
    const id = chatGptCreditGrantId(credit.id)
    if (grants.some(grant => grant.id === id)) continue
    grants.push({
      id,
      resetsLeft: 1,
      expiresAt: credit.expiresAt,
      startsAt: credit.grantedAt,
      paused: false,
      usableNow,
      kind: "full",
      providerType: credit.resetType,
      clears,
      givesBackWeekly: null,
      description: credit.title,
      percentUsed,
    })
  }
  const stated = resets.listedCount ?? resets.credits.length
  return {
    ...eligibility,
    // Credits are listed soonest expiry first, and the vendor names no next one.
    nextGrantId: grants[0]?.id ?? null,
    grants,
    unreadableGrants: unlisted + Math.max(0, stated - resets.credits.length),
  }
}

export type ChatGptResetFailureCode =
  | "no_token" | "identity_mismatch" | "upstream_auth" | "rate_limited" | "upstream_error" | "reset_indeterminate"

export type ChatGptResetResult = QuotaResetResult<ChatGptResetFailureCode>

export interface ChatGptResetRedeemerDeps {
  source: ChatGptCredentialSource
  /**
   * Read the seat's usage again after a consume went out, so later quota reads
   * show the credit spent; resolves to the fresh reading's credits, or null
   * when no fresh reading was taken.
   */
  reread: (seat: string) => Promise<CodexResetCredits | null>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * The redemption idempotency key chatgpt.com is sent: the same for a retry of
 * one request, so the backend can tell a repeat from a second redemption.
 * UUID-shaped, as the official clients send it.
 */
function redeemRequestId(seat: string, creditId: string, requestId: string): string {
  const bytes = createHash("sha256").update(`meridian:chatgpt-reset:${seat}:${creditId}:${requestId}`).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function fail(status: 429 | 502 | 503, code: ChatGptResetFailureCode, message: string, dispatched = false): ChatGptResetResult {
  return { ok: false, status, code, message, indeterminate: code === "reset_indeterminate", dispatched }
}

function answered(result: QuotaResetOutcome["result"], reason: string | null, resetsLeft: number | null, cleared: string[]): ChatGptResetResult {
  return { ok: true, outcome: { result, reason, resetsLeft, cleared, weeklyResetsAt: null, cooldownUntil: null } }
}

function readFailure(error: CodexUsageError | null): ChatGptResetResult {
  switch (error) {
    case "unauthorized": return fail(502, "upstream_auth", "chatgpt.com refused the seat's access token")
    case "rate_limited": return fail(429, "rate_limited", "chatgpt.com rate limited the request")
    case "identity_mismatch": return fail(502, "identity_mismatch", "The seat's access token belongs to another account")
    case "no_token":
    case "invalid_token":
    case "token_expired": return fail(503, "no_token", "No usable ChatGPT access token for this seat")
    default: return fail(502, "upstream_error", "Could not read the seat's usage and reset credits")
  }
}

function heldCount(resets: CodexResetCredits | null): number | null {
  return resets ? resets.listedCount ?? resets.availableCount : null
}

/** The vendor's machine-readable reason for a refusal, if it gave one; its prose is never passed on. */
async function refusalCode(response: Response): Promise<string | null> {
  let body: unknown
  try {
    body = JSON.parse((await response.text()).slice(0, ERROR_BODY_MAX_CHARS))
  } catch {
    return null
  }
  const record = (value: unknown) => typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
  for (const candidate of [record(body)?.code, record(record(body)?.error)?.code, record(record(body)?.detail)?.code]) {
    if (typeof candidate === "string" && PROVIDER_CODE_FORMAT.test(candidate)) return candidate
  }
  return null
}

export function createChatGptResetRedeemer(deps: ChatGptResetRedeemerDeps) {
  const ledger = new QuotaResetLedger<ChatGptResetResult>()

  async function redeem(input: QuotaResetRequest, seat: string): Promise<ChatGptResetResult> {
    const credential = await deps.source.credentials(seat)
    if (!credential.ok) return fail(503, "no_token", "No usable ChatGPT access token for this seat")
    const { accountId, accessToken } = credential.account

    const read = await fetchCodexAccountUsage(
      { accountId, accountUserId: seat, accessToken, email: null },
      { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs },
    )
    if (!read.usage) return readFailure(read.error)
    // chatgpt.com answers a mismatched account header with the token's own
    // account (codex/usage.ts), so a credit is spent only once the read named
    // exactly this seat.
    if (!read.usage.identityConfirmed) return fail(502, "identity_mismatch", "chatgpt.com did not confirm the seat's identity")
    const resets = read.usage.resetCredits
    if (!resets || resets.credits === null) return fail(502, "upstream_error", "Could not read the seat's reset credits")

    const held = heldCount(resets)
    const creditId = resets.credits.find(credit => credit.id !== null && chatGptCreditGrantId(credit.id) === input.grantId)?.id
    if (!creditId) return answered("unavailable", "credit_not_available", held, [])
    if (resets.applicableAvailableCount === 0) return answered("not_limited", null, held, [])
    const clears = chatGptCreditClears(read.usage.windows.map(window => profileWindowType(window.limitWindowSeconds)))

    let response: Response
    try {
      response = await (deps.fetchImpl ?? fetch)(CONSUME_URL, {
        method: "POST",
        headers: { ...codexRequestHeaders(accessToken, accountId), "Content-Type": "application/json" },
        body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId(seat, creditId, input.requestId) }),
        // A bearer credential must never be replayed to a redirect target.
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? CONSUME_TIMEOUT_MS),
      })
    } catch {
      await deps.reread(seat)
      return fail(502, "reset_indeterminate", "Reset outcome is unknown; do not automatically retry", true)
    }
    if (response.status >= 500) {
      await deps.reread(seat)
      return fail(502, "reset_indeterminate", "Reset outcome is unknown; do not automatically retry", true)
    }
    if (response.status === 401 || response.status === 403) return fail(502, "upstream_auth", "chatgpt.com refused the seat's access token", true)
    if (response.status === 429) return fail(429, "rate_limited", "chatgpt.com rate limited the request", true)
    // Any other refusal spent nothing: the credit is as it was.
    if (!response.ok) return answered("unavailable", await refusalCode(response), held, [])
    return answered("reset", null, heldCount(await deps.reread(seat)), clears)
  }

  return {
    /** One explicit redemption of `input.grantId` on `seat`, under the shared ledger (quotaReset.ts). */
    redeemOnce(input: QuotaResetRequest, seat: string): Promise<QuotaResetAttempt<ChatGptResetResult>> {
      return ledger.redeemOnce(input, () => redeem(input, seat))
    },
  }
}

export type ChatGptResetRedeemer = ReturnType<typeof createChatGptResetRedeemer>
