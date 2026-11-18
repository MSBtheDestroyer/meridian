/**
 * A Claude account's banked free resets, as /profiles and / show them.
 *
 * Meridian is the only reader: oauthUsage.ts parses the provider's grants per
 * profile, `/v1/usage/quota/all` serves them as each entry's `bankedResets`,
 * and `POST /v1/usage/quota/reset` redeems one. Both pages turn that reading
 * into the same view here, so a card on / and its card on /profiles never
 * disagree about how many resets an account has or whether one is usable.
 *
 * Both functions are serialized with `.toString()` into the pages' inline
 * scripts (the buildBadge.ts pattern), so each must stay self-contained: no
 * references to anything outside its own body. They take `unknown` because
 * the browser hands them raw JSON; a grant that cannot be read is skipped.
 */

export interface FreeResetView {
  /** Resets on unexpired grants, the ones the provider holds back included. */
  readonly available: number
  /** Resets that could be redeemed right now. */
  readonly usable: number
  /** When the soonest-expiring unexpired grant expires, if the provider says. */
  readonly expiresAt: number | null
  /** The grant a redeem spends: the provider's next one if usable, else the usable one expiring soonest. */
  readonly grantId: string | null
  readonly value: string
  readonly note: string
  readonly title: string
}

export function freeResetView(raw: unknown, nowMs: number): FreeResetView | null {
  if (typeof raw !== "object" || raw === null) return null
  const banked = raw as { eligible?: unknown; nextGrantId?: unknown; grants?: unknown }
  if (banked.eligible !== true || !Array.isArray(banked.grants)) return null
  const live: { id: string | null; left: number; expiresAt: number | null; usable: boolean }[] = []
  for (const item of banked.grants as unknown[]) {
    if (typeof item !== "object" || item === null) continue
    const g = item as { id?: unknown; resetsLeft?: unknown; expiresAt?: unknown; startsAt?: unknown; paused?: unknown; usableNow?: unknown }
    if (typeof g.resetsLeft !== "number" || !Number.isSafeInteger(g.resetsLeft) || g.resetsLeft <= 0) continue
    const expiresAt = typeof g.expiresAt === "number" && isFinite(g.expiresAt) ? g.expiresAt : null
    if (expiresAt !== null && expiresAt <= nowMs) continue
    const startsAt = typeof g.startsAt === "number" && isFinite(g.startsAt) ? g.startsAt : null
    live.push({
      id: typeof g.id === "string" && g.id.length > 0 ? g.id : null,
      left: g.resetsLeft,
      expiresAt,
      usable: g.usableNow === true && g.paused !== true && (startsAt === null || startsAt <= nowMs),
    })
  }
  if (live.length === 0) return null

  let available = 0
  let usable = 0
  let expiresAt: number | null = null
  let soonest: { id: string | null; expiresAt: number | null } | null = null
  let next: string | null = null
  for (const g of live) {
    available += g.left
    if (g.expiresAt !== null && (expiresAt === null || g.expiresAt < expiresAt)) expiresAt = g.expiresAt
    if (!g.usable) continue
    usable += g.left
    if (g.id !== null && g.id === banked.nextGrantId) next = g.id
    if (g.id !== null && (soonest === null
      || (g.expiresAt !== null && (soonest.expiresAt === null || g.expiresAt < soonest.expiresAt)))) soonest = g
  }

  function within(ms: number): string {
    const minutes = Math.max(1, Math.floor(ms / 60000))
    if (minutes < 60) return minutes + "m"
    const hours = Math.floor(minutes / 60)
    return hours < 24 ? hours + "h" : Math.floor(hours / 24) + "d"
  }
  const plural = (n: number) => n + " free reset" + (n === 1 ? "" : "s")
  const status = usable === 0 ? "none usable now" : usable === available ? "all usable now" : usable + " usable now"
  const expiry = expiresAt === null ? "" : (available === 1 ? "expires in " : "next expires in ") + within(expiresAt - nowMs)
  const held = available - usable
  return {
    available,
    usable,
    expiresAt,
    grantId: next ?? (soonest ? soonest.id : null),
    value: String(available),
    note: status + (expiry ? " \u00b7 " + expiry : ""),
    title: plural(available) + " banked; " + usable + " can be redeemed now"
      + (held > 0 ? ", " + held + " held back by Anthropic (paused, not started yet, or blocked until a limit is hit)" : "")
      + (expiresAt === null ? "." : ". The soonest expires " + new Date(expiresAt).toLocaleString() + ".")
      + " Redeeming one clears this account's usage limits.",
  }
}

/** What /profiles says after `POST /v1/usage/quota/reset` answers `status` with `body`; `label` names a window. */
export function freeResetOutcomeText(status: number, body: unknown, label?: (window: string) => string): { ok: boolean; text: string } {
  const answer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  if (status >= 200 && status < 300 && answer.result === "reset") {
    const cleared = Array.isArray(answer.cleared) ? answer.cleared.filter((c): c is string => typeof c === "string") : []
    const left = answer.resetsLeft
    return {
      ok: true,
      text: "Reset redeemed" + (cleared.length > 0 ? ": cleared " + cleared.map(c => (label ? label(c) : c)).join(", ") : "") + "."
        + (typeof left === "number" ? " " + left + " left on that grant." : ""),
    }
  }
  if (status >= 200 && status < 300) {
    const why: Record<string, string> = {
      not_limited: "Anthropic says this account is not rate limited, so there is nothing to reset yet",
      already_used: "this grant has already been used",
      cooldown: "Anthropic asks to wait before redeeming another reset on this account",
      ineligible: "Anthropic says this account cannot redeem resets",
      unavailable: "Anthropic has no reset to redeem on this account right now",
    }
    const result = typeof answer.result === "string" ? answer.result : ""
    return { ok: false, text: "Not redeemed: " + (why[result] ?? "Anthropic answered " + (result || "nothing")) + "." }
  }
  if (status === 0) return { ok: false, text: "Not redeemed: Meridian did not answer." }
  const error = typeof answer.error === "string" && answer.error.length > 0 ? answer.error : "Meridian answered " + status
  return {
    ok: false,
    text: "Not redeemed: " + error + "." + (answer.indeterminate === true ? " It may have gone through - check the figures before trying again." : ""),
  }
}
