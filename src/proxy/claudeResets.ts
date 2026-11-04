import { z } from "zod"

export interface ClaudeResetGrant {
  readonly remainingResets: number
  readonly paused: boolean
  readonly startsAt: number | null
  readonly endsAt: number | null
}

export interface ClaudeResets {
  readonly eligible: boolean
  readonly grants: readonly ClaudeResetGrant[]
  readonly unreadableGrants: number
}

const statusSchema = z.object({
  eligible: z.boolean(),
  grants: z.array(z.unknown()).max(200),
})
const boundSchema = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value))).nullish()
const grantSchema = z.object({
  resets_left: z.number().int().nonnegative(),
  resets_total: z.number().int().nonnegative().nullish(),
  paused: z.boolean(),
  starts_at: boundSchema,
  ends_at: boundSchema,
}).refine(grant => grant.resets_total == null || grant.resets_total >= grant.resets_left)

/** Display-only inventory. Redemption handles and provider labels never leave this boundary.
 * Time eligibility and the 50-active-reset display bound belong to the consumer. */
export function normalizeClaudeResets(raw: unknown): ClaudeResets | null {
  const status = statusSchema.safeParse(raw)
  if (!status.success) return null

  const grants: ClaudeResetGrant[] = []
  let unreadableGrants = 0
  for (const rawGrant of status.data.grants) {
    const parsed = grantSchema.safeParse(rawGrant)
    if (!parsed.success) {
      unreadableGrants++
      continue
    }
    const grant = parsed.data
    grants.push({
      remainingResets: grant.resets_left,
      paused: grant.paused,
      startsAt: grant.starts_at == null ? null : Date.parse(grant.starts_at),
      endsAt: grant.ends_at == null ? null : Date.parse(grant.ends_at),
    })
  }
  return { eligible: status.data.eligible, grants, unreadableGrants }
}
