/**
 * What a profile card's Refresh says about each part of the profile it
 * re-read: its login, usage, model list and CVP access. The route
 * (`POST /profiles/:id/refresh`, server.ts) does the reads; this decides each
 * part's state and words. Policy: profiles-routing.spec.md, "Refreshing a
 * profile".
 *
 * Leaf module: type imports only.
 */

import type { ProfileLoginState } from "./profileLoginState"
import type { StoredCredentialPresence } from "./tokenRefresh"
import type { ChatGptTokenState } from "./chatgpt/profiles"

/**
 * `fresh`: read just now. `rate_limited`: turned away by the provider or by
 * the part's own budget. `failed`: the read did not land, or what it found
 * needs the user. `skipped`: not tried, because the login it needs is gone.
 * `unavailable`: nothing Meridian can read for this part of this profile.
 */
export type RefreshPartState = "fresh" | "rate_limited" | "failed" | "skipped" | "unavailable"

export interface RefreshPart {
  readonly state: RefreshPartState
  readonly note: string
  readonly retryAfterMs?: number
}

export type RefreshPartName = "login" | "usage" | "models" | "cvp"

/** How long ago, in the words a card uses. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

export function tooSoonPart(label: string, retryAfterMs: number): RefreshPart {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return { state: "rate_limited", note: `${label} was re-read moments ago; the next re-read opens in ${seconds}s.`, retryAfterMs }
}

export const SKIPPED_WITHOUT_LOGIN: RefreshPart = { state: "skipped", note: "Not read: this profile has no usable login." }

export function claudeLoginPart(input: {
  readonly state: ProfileLoginState
  /** The check itself failed (no answer from Claude Code), rather than answering. */
  readonly checkFailed: boolean
  /** Claude Code has answered for this profile before, so an earlier answer stands. */
  readonly everAnswered: boolean
  readonly presence: StoredCredentialPresence
  readonly email: string | null
  /** The login now holds another account than the one recorded before. */
  readonly accountChanged: boolean
}): RefreshPart {
  if (input.state === "needs_login") {
    return {
      state: "failed",
      note: input.presence === "absent"
        ? "The stored login has no access token. Sign this profile in again."
        : "Claude Code says this profile is not signed in. Sign this profile in again.",
    }
  }
  if (input.checkFailed || input.state === "unverified") {
    return {
      state: "failed",
      note: input.everAnswered
        ? "Claude Code did not answer the login check; its last answer stays."
        : "Claude Code did not answer the login check, and has not answered for this profile before.",
    }
  }
  const who = input.email ? `Signed in as ${input.email}.` : "Signed in."
  return {
    state: "fresh",
    note: input.accountChanged
      ? `${who} The login now holds another account than before; what Meridian knew about the previous one was dropped and is read afresh.`
      : who,
  }
}

/** A ChatGPT seat's login, as the usage read that just ran found its token. */
export function seatLoginPart(input: { readonly loggedIn: boolean; readonly tokenState: ChatGptTokenState; readonly email: string | null }): RefreshPart {
  if (input.loggedIn) return { state: "fresh", note: input.email ? `Signed in as ${input.email}.` : "Signed in." }
  switch (input.tokenState) {
    case "refused": return { state: "failed", note: "ChatGPT refused this seat's token. Sign the seat in again." }
    case "expired": return { state: "failed", note: "This seat's token expired. Sign the seat in again." }
    case "no_token": return { state: "failed", note: "This seat has no token. Sign it in again." }
    case "requires_reauth": return { state: "failed", note: "ChatGPT asks for this seat to sign in again." }
    default: return { state: "failed", note: "Meridian could not tell whether this seat is signed in." }
  }
}

export function modelsPart(
  read: {
    /** Models the forced read listed; null when it failed. */
    readonly count: number | null
    readonly failure: { readonly reason: string; readonly status?: number } | null
    /** When the list still in use was read; null when none is. */
    readonly listedAt: number | null
  },
  now: number,
): RefreshPart {
  if (read.count !== null) return { state: "fresh", note: `Listed ${read.count} ${read.count === 1 ? "model" : "models"} for this account.` }
  const kept = read.listedAt !== null ? `the list read ${ago(now - read.listedAt)} stays.` : "the built-in list stands in."
  const failure = read.failure
  if (failure?.status === 429) return { state: "rate_limited", note: `Anthropic is rate limiting model reads for this account; ${kept}` }
  if (failure?.reason === "no_credential") return { state: "failed", note: `No usable credential to list this account's models with; ${kept}` }
  const status = failure?.status === undefined ? "" : ` (HTTP ${failure.status})`
  return { state: "failed", note: `Anthropic did not list this account's models${status}; ${kept}` }
}

/**
 * CVP access is never readable with the credential Meridian holds; it is
 * learned from a claude.ai session's reading and from refusals
 * (cvpAccess.ts), so the part says how old the last reading is.
 */
export function cvpPart(input: { readonly lastClaudeAiReadingAt: number | null; readonly forgotten: boolean }, now: number): RefreshPart {
  const base = "Meridian cannot read CVP access itself; it learns it from a claude.ai session's reading and from refusals."
  if (input.forgotten) {
    return { state: "unavailable", note: `${base} The login now holds another account, so the access learned for the previous one was dropped until claude.ai is read again.` }
  }
  if (input.lastClaudeAiReadingAt === null) return { state: "unavailable", note: `${base} No claude.ai reading has reached this Meridian yet.` }
  return { state: "unavailable", note: `${base} Last claude.ai reading: ${ago(now - input.lastClaudeAiReadingAt)}.` }
}

/** True only when both records name an account and they differ: an unread account proves nothing. */
export function accountChanged(
  before: { readonly accountUuid?: string | null } | undefined,
  after: { readonly accountUuid?: string | null } | null,
): boolean {
  return !!before?.accountUuid && !!after?.accountUuid && before.accountUuid !== after.accountUuid
}
