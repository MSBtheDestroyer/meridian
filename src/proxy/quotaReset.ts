/**
 * What `POST /v1/usage/quota/reset` means for every provider: the request it
 * takes, the outcome it answers, and the ledger that keeps one redemption per
 * profile in flight and replays a dispatched outcome for a repeated request ID
 * (profiles-routing.spec.md, "One redemption per profile").
 *
 * Provider-neutral on purpose: a Claude profile redeems through Anthropic
 * (oauthUsage.ts) and a ChatGPT seat through chatgpt.com
 * (chatgpt/resetCredits.ts), and both must answer a client the same way.
 */
import { z } from "zod"

export const quotaResetBody = z.object({
  profile: z.string().min(1),
  grantId: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict()

export type QuotaResetRequest = z.infer<typeof quotaResetBody>

export const QUOTA_RESET_RESULTS = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"] as const

export interface QuotaResetOutcome {
  result: (typeof QUOTA_RESET_RESULTS)[number]
  reason: string | null
  resetsLeft: number | null
  cleared: string[]
  weeklyResetsAt: number | null
  cooldownUntil: number | null
}

export interface QuotaResetFailure<Code extends string = string> {
  ok: false
  status: 429 | 502 | 503
  code: Code
  message: string
  indeterminate: boolean
  /** The mutation was handed to fetch; its outcome is then tied to the request ID. */
  dispatched: boolean
}

export type QuotaResetResult<Code extends string = string> = QuotaResetFailure<Code> | { ok: true; outcome: QuotaResetOutcome }

export type QuotaResetAttempt<R> =
  | { kind: "settled"; result: R; replayed: boolean }
  | { kind: "in_progress" }
  | { kind: "request_id_conflict" }

const LEDGER_MAX_ENTRIES = 256
const LEDGER_TTL_MS = 15 * 60_000

/**
 * At most one redemption per profile at a time, and a request ID whose
 * mutation was dispatched replays its remembered outcome - confirmed, refused
 * or uncertain - instead of reaching the provider again. Failures before
 * dispatch are not remembered, since nothing was sent. In memory: a restart
 * forgets it.
 */
export class QuotaResetLedger<R extends QuotaResetResult> {
  /** Redemption currently running per profile. */
  private readonly inflight = new Map<string, { requestId: string; grantId: string }>()
  /** Settled, dispatched outcomes keyed by profile + request ID, oldest first. */
  private readonly settled = new Map<string, { grantId: string; result: R; settledAt: number }>()

  async redeemOnce(input: QuotaResetRequest, redeem: () => Promise<R>): Promise<QuotaResetAttempt<R>> {
    const key = `${input.profile}\u0000${input.requestId}`
    this.prune(Date.now())
    const settled = this.settled.get(key)
    if (settled) {
      return settled.grantId === input.grantId
        ? { kind: "settled", result: settled.result, replayed: true }
        : { kind: "request_id_conflict" }
    }
    const running = this.inflight.get(input.profile)
    if (running) {
      return running.requestId === input.requestId && running.grantId !== input.grantId
        ? { kind: "request_id_conflict" }
        : { kind: "in_progress" }
    }
    this.inflight.set(input.profile, { requestId: input.requestId, grantId: input.grantId })
    try {
      const result = await redeem()
      if (result.ok || result.dispatched) {
        this.settled.set(key, { grantId: input.grantId, result, settledAt: Date.now() })
        this.prune(Date.now())
      }
      return { kind: "settled", result, replayed: false }
    } finally {
      this.inflight.delete(input.profile)
    }
  }

  clear(): void {
    this.inflight.clear()
    this.settled.clear()
  }

  private prune(now: number): void {
    for (const [key, entry] of this.settled) {
      if (now - entry.settledAt < LEDGER_TTL_MS && this.settled.size <= LEDGER_MAX_ENTRIES) break
      this.settled.delete(key)
    }
  }
}
