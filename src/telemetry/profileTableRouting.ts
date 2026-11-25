type RoutingSettings = {
  readonly routingExcludedProfiles?: readonly string[]
  readonly routingManagedExcludedProfiles?: readonly string[]
  readonly routingHeldProfiles?: readonly string[]
  readonly cvpManagedExcludedProfiles?: readonly string[]
  readonly routingManagedReasons?: Readonly<Record<string, string>>
}

function tableRouting(
  profile: { readonly id: string; readonly seat?: string; readonly aliases?: readonly string[]; readonly forced?: unknown },
  quota: { readonly reserve?: { readonly held?: boolean; readonly reason?: string; readonly opensAt?: number | null } },
  routing: RoutingSettings | null,
): string | null {
  const aliases = new Set((profile.aliases ?? []).map(alias => alias.toLowerCase()))
  const matches = (id: string) => id === profile.id || id === profile.seat || aliases.has(id.toLowerCase())
  const facts: string[] = []
  if (routing?.routingExcludedProfiles?.some(matches)) facts.push('Manually excluded')
  const supervisorReason = Object.entries(routing?.routingManagedReasons ?? {}).find(([id]) => matches(id))?.[1]
  const supervisorSuffix = (profile.forced ? ' (overridden)' : '') + (supervisorReason ? ': ' + supervisorReason : '')
  if (routing?.routingManagedExcludedProfiles?.some(matches)) facts.push('Excluded by supervisor' + supervisorSuffix)
  if (routing?.routingHeldProfiles?.some(matches)) facts.push('Held by supervisor' + supervisorSuffix)
  if (routing?.cvpManagedExcludedProfiles?.some(matches)) facts.push('Excluded from CVP by supervisor')
  if (quota.reserve?.held) facts.push('Usage reserve' + (profile.forced && profile.seat == null ? ' (overridden)' : '')
    + (quota.reserve.reason ? ': ' + quota.reserve.reason : '')
    + (quota.reserve.opensAt != null && quota.reserve.opensAt > Date.now() ? ' · opens ' + new Date(quota.reserve.opensAt).toLocaleString() : ''))
  return facts.length ? facts.join('; ') : null
}

export const profileTableRoutingJs = `var meridianTableRouting = ${tableRouting.toString()};`
