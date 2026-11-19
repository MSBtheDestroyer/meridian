/**
 * A Claude profile the user made active although a supervisor keeps it out
 * of work, and the words a refused activation is explained in.
 *
 * Leaf module: no imports. The rules are in profiles-routing.spec.md
 * ("Forcing a forbidden profile").
 */

/** How long a force holds when nobody releases it: one five-hour window. */
export const FORCED_PROFILE_HOLD_MS = 5 * 60 * 60 * 1000

/** The longest supervisor reason kept, so a runaway writer cannot bloat settings. */
const MANAGED_REASON_MAX_LENGTH = 300

export interface ForcedProfile {
  readonly profile: string
  readonly forcedAt: number
  readonly until: number
}

export function forcedProfileFor(profile: string, now: number): ForcedProfile {
  return { profile, forcedAt: now, until: now + FORCED_PROFILE_HOLD_MS }
}

/** The saved force while it holds; null when there is none, it expired, or it is malformed. */
export function liveForcedProfile(value: unknown, now: number): ForcedProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const { profile, forcedAt, until } = value as Record<string, unknown>
  if (typeof profile !== "string" || profile === "") return null
  if (typeof forcedAt !== "number" || typeof until !== "number" || !Number.isFinite(until)) return null
  return now < until ? { profile, forcedAt, until } : null
}

/** A supervisor's list, less the profile the user forced. */
export function withoutForcedProfile(ids: readonly string[], forced: string | null): string[] {
  return forced === null ? [...ids] : ids.filter(id => id !== forced)
}

/** `routingManagedReasons`: per profile id, why the supervisor keeps it out. */
export function parseRoutingManagedReasons(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const reasons: Record<string, string> = {}
  for (const [id, reason] of Object.entries(value as Record<string, unknown>)) {
    if (typeof reason !== "string") continue
    const text = reason.trim().slice(0, MANAGED_REASON_MAX_LENGTH)
    if (text) reasons[id] = text
  }
  return reasons
}

export type ActivationRefusalKind =
  | "managed_excluded"
  | "excluded"
  | "held"
  | "usage_reserve"
  | "needs_login"
  | "following"
  | "forced_elsewhere"

/** What a page shows when `POST /profiles/active` will not switch. */
export interface ActivationRefusal {
  readonly kind: ActivationRefusalKind
  readonly profile: string
  /** Who keeps the profile out, in words. */
  readonly by: string
  /** Why, in words. */
  readonly reason: string
  /** Whether "Allow forcing a forbidden profile" can override this refusal. */
  readonly forceable: boolean
  /** Whether a request with `force: true` would be honoured right now. */
  readonly forceAllowed: boolean
  /** What forcing would take, or why it cannot. */
  readonly forceNote: string
  /** The force standing in the way of this switch. */
  readonly forced?: ForcedProfile
}

const FORCEABLE: ReadonlySet<ActivationRefusalKind> = new Set(["managed_excluded", "held", "usage_reserve"])

const SETTING = "Settings, Routing, \u201cAllow forcing a forbidden profile\u201d"

export function describeActivationRefusal(input: {
  readonly kind: ActivationRefusalKind
  readonly profile: string
  /** The supervisor's own words (`routingManagedReasons`). */
  readonly supervisorReason?: string
  /** The message the route has always answered with. */
  readonly detail?: string
  readonly allowForcing: boolean
  readonly seat?: boolean
  readonly forced?: ForcedProfile
}): ActivationRefusal {
  const { kind, profile } = input
  const forceable = FORCEABLE.has(kind) && !input.seat
  const forceAllowed = forceable && input.allowForcing
  const base = { kind, profile, forceable, forceAllowed }
  let by: string
  let reason: string
  switch (kind) {
    case "managed_excluded":
      by = "the routing supervisor (its managed exclusion list, routingManagedExcludedProfiles), such as Vibeterm\u2019s fleet policy"
      reason = input.supervisorReason ?? "The supervisor did not say why; it wrote no reason for this profile."
      break
    case "excluded":
      by = "you: Meridian\u2019s own exclusion list (routingExcludedProfiles)"
      reason = `"${profile}" is on the exclusion list you keep in Meridian, so no work goes to it.`
      break
    case "held":
      by = "the routing supervisor (its held list, routingHeldProfiles)"
      reason = input.supervisorReason ?? `"${profile}" is held out of rotation for a measured run; only requests pinned to it reach it.`
      break
    case "usage_reserve":
      by = "the routing supervisor\u2019s usage reserve for this profile (usageReserves)"
      reason = input.detail ?? `"${profile}" is at the share of its usage the reserve keeps back.`
      break
    case "needs_login":
      by = "Anthropic: the account is not signed in"
      reason = input.detail ?? `"${profile}" needs a login before it can be activated.`
      break
    case "following":
      by = "the Meridian this one follows (MERIDIAN_FOLLOW_ACTIVE)"
      reason = input.detail ?? "This instance takes its active profile from another Meridian."
      break
    case "forced_elsewhere": {
      const forced = input.forced
      by = "you: another profile is forced active"
      reason = forced
        ? `"${forced.profile}" is forced active. Release that force to switch.`
        : "Another profile is forced active. Release that force to switch."
      break
    }
  }
  if (input.seat && FORCEABLE.has(kind)) {
    reason += " Only a Claude profile can be forced; this is a ChatGPT seat."
  }
  const forceNote = forceAllowed
    ? `Activate anyway makes "${profile}" the active profile for up to ${FORCED_PROFILE_HOLD_MS / 3_600_000} hours, or until you release it; the supervisor cannot switch away from it meanwhile.`
    : forceable
      ? `Forcing is off. Turn on ${SETTING} to activate it anyway.`
      : kind === "excluded"
        ? "Your own exclusion is never forced past: remove the profile from the exclusion list instead."
        : kind === "forced_elsewhere"
          ? "Release and switch ends the force and activates this profile, if nothing else keeps it out."
          : "This cannot be forced."
  return { ...base, by, reason, forceNote, ...(input.forced ? { forced: input.forced } : {}) }
}
