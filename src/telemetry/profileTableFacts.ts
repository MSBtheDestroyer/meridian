import { LOGIN_STATES } from "./profileLoginStates"
import { PROFILE_PROVIDERS } from "./profileProviders"
import { formatExtraUsage, formatExtraUsageAmount, formatResetCountdown, classifyUtilization } from "./profileUsage"
import type { FreeResetView } from "./freeResets"

type Cell = { readonly value: number | string | null; readonly html?: string }
type Input = {
  readonly name: string
  readonly provider: string
  readonly login: string
  readonly active: boolean
  readonly quota?: {
    readonly windows?: readonly { readonly type: string; readonly utilization?: number | null; readonly resetsAt?: number | null }[]
    readonly extraUsage?: Parameters<typeof formatExtraUsage>[0]
    readonly stale?: boolean
  }
  readonly spentLabel?: string | null
  readonly spentDetail?: string | null
  readonly routingDetail?: string | null
  readonly extraHtml?: string
}

function tableFacts(input: Input, format: {
  readonly escape: (text: string) => string
  readonly providerName: string
  readonly loginName: string | null
  readonly countdown: typeof formatResetCountdown
  readonly extra: typeof formatExtraUsage
}): Record<string, Cell> {
  const esc = format.escape
  const sub = (text: string) => text ? '<span class="profile-table-note">' + esc(text) + '</span>' : ""
  const windowCell = (type: string): Cell => {
    const window = input.quota?.windows?.find(w => w.type === type)
    const utilization = window?.utilization
    const reset = window?.resetsAt
    const note = reset != null && Number.isFinite(reset)
      ? '<time datetime="' + new Date(reset).toISOString() + '" title="' + esc(new Date(reset).toLocaleString()) + '">'
        + esc(reset > Date.now() ? 'Resets ' + format.countdown(reset) : 'Reset at ' + new Date(reset).toLocaleString()) + '</time>'
      : ""
    const value = utilization != null && Number.isFinite(utilization) ? utilization * 100 : null
    if (value === null && !note) return { value }
    const reading = value === null ? "\u2014" : Math.round(value) + "%"
    return { value, html: reading + (note || input.quota?.stale
      ? '<span class="profile-table-note">' + note + (input.quota?.stale ? (note ? ' · ' : '') + 'Last reading' : '') + '</span>' : '') }
  }
  const extra = format.extra(input.quota?.extraUsage)
  return {
    name: { value: input.name },
    provider: { value: format.providerName },
    active: { value: input.active ? 'Active' : 'Inactive' },
    login: { value: format.loginName },
    fiveHour: windowCell('five_hour'),
    weekly: windowCell('seven_day'),
    extra: extra ? { value: extra.utilizationPct, html: input.extraHtml ?? (esc(extra.used + ' / ' + extra.limit)
      + sub(extra.utilizationPct + '%' + (extra.over ? ' · ' + extra.over + ' over limit' : ''))) } : { value: null },
    spent: { value: input.spentLabel || null, html: input.spentLabel ? esc(input.spentLabel) + sub(input.spentDetail || '') : undefined },
    routing: { value: input.routingDetail || null },
  }
}

type ForkInput = Input & {
  readonly profile?: { readonly cvpAccess?: readonly {
    readonly model: string; readonly name?: string; readonly type: 'active' | 'inactive'; readonly tier?: string | null; readonly reason?: string | null; readonly inferredFrom?: string
  }[] }
  readonly forced?: { readonly until: number } | null
  readonly resetView?: FreeResetView | null
}

function addForkTableFacts(input: ForkInput, esc: (text: string) => string): Record<string, Cell> {
  const groups = input.resetView?.groups ?? []
  const resets = (kind: "full" | "fable" | "unknown"): Cell => {
    const matching = groups.filter(group => group.kind === kind)
    if (matching.length === 0) return { value: null }
    return { value: matching.reduce((count, group) => count + group.available, 0), html: matching.map(group =>
      '<span class="profile-table-readout">' + group.available + '<span class="profile-table-note">' + esc(group.note) + '</span></span>').join('') }
  }
  const cvp = input.profile?.cvpAccess ?? []
  return {
    ...(input.forced ? { active: { value: 'Forced', html: 'Forced<span class="profile-table-note">Until '
      + esc(new Date(input.forced.until).toLocaleString()) + '</span>' } } : {}),
    fullReset: resets('full'),
    fableReset: resets('fable'),
    otherReset: resets('unknown'),
    cvp: { value: cvp.length === 0 ? null : cvp.map(entry => (entry.name || entry.model) + ': ' + entry.type
      + (entry.tier ? ' (tier ' + entry.tier.toUpperCase() + ')' : '') + (entry.reason ? ' - ' + entry.reason : '')
      + (entry.inferredFrom ? ' via ' + entry.inferredFrom : '')).join('; ') },
  }
}

export const profileTableFactsJs = `
function meridianTableFacts(input) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const providers = ${JSON.stringify(PROFILE_PROVIDERS)};
  const states = ${JSON.stringify(LOGIN_STATES)};
  const formatExtraUsageAmount = ${formatExtraUsageAmount.toString()};
  const classifyUtilization = ${classifyUtilization.toString()};
  const extra = ${formatExtraUsage.toString()};
  const cells = (${tableFacts.toString()})(input, {
    escape,
    providerName: providers.find(p => p.id === input.provider)?.label || input.provider,
    loginName: states.find(s => s.id === input.login)?.label || null,
    countdown: ${formatResetCountdown.toString()},
    extra,
  });
  return Object.assign(cells, (${addForkTableFacts.toString()})(input, escape));
}
`
