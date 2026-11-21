export const CAPACITY_OBSERVATION_MAX_AGE_MS = 120_000

const PROTECTION_REASONS = new Set([
  "spent", "usage-reserve", "weekly-reserve", "extra-usage",
  "loaner-gate", "unmeasured-loaner", "unmeasured-loaner-cap",
])

export interface ManagedExclusionEvidence {
  readonly observedAt: number
  readonly profiles: ReadonlySet<string>
}

export function parseManagedExclusionEvidence(value: unknown, allowed: ReadonlySet<string>): ManagedExclusionEvidence | undefined {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
    !("observedAt" in value) || typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) ||
    value.observedAt <= 0 || !("reasons" in value) || !value.reasons || typeof value.reasons !== "object" ||
    Array.isArray(value.reasons)) return undefined

  const entries = Object.entries(value.reasons)
  if (entries.some(([id, reason]) => !allowed.has(id) || typeof reason !== "string" || !PROTECTION_REASONS.has(reason))) return undefined
  return { observedAt: value.observedAt, profiles: new Set(entries.map(([id]) => id)) }
}

export function capacityObservationIsFresh(at: number, now: number): boolean {
  return Number.isFinite(at) && at <= now && now - at <= CAPACITY_OBSERVATION_MAX_AGE_MS
}
