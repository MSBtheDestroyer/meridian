import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fetchOAuthUsageResult, resetOAuthUsageCache, toUsageEntry } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const store: CredentialStore = {
  async read() {
    return { claudeAiOauth: { accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now() + 3_600_000 } }
  },
  async write() { throw new Error("Usage inventory must not write credentials") },
}

const windows = {
  five_hour: { utilization: 36, resets_at: "2026-11-04T22:30:00Z" },
  seven_day: { utilization: 5, resets_at: "2026-11-10T17:00:00Z" },
  extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 12, utilization: 12, currency: "USD" },
}

const grant = { resets_left: 2, paused: false }

async function readInventory(cedarEmber: unknown) {
  return toUsageEntry(await fetchOAuthUsageResult({
    force: true,
    store,
    fetchImpl: async input => {
      const url = new URL(input)
      return Response.json({ ...windows, cedar_ember: url.searchParams.get("cedar_ember") === "1" ? cedarEmber : undefined })
    },
  }))
}

describe("OAuth reset inventory boundary", () => {
  beforeEach(resetOAuthUsageCache)
  afterEach(resetOAuthUsageCache)

  test("requests and normalizes saved grants without handles or clock filtering, preserving usage windows", async () => {
    const entry = await readInventory({
      eligible: true,
      account_id: "private-account",
      grants: [
        { ...grant, resets_total: 3, usable_now: false, id: "redemption-handle", label: "private-label", starts_at: null, ends_at: "2099-11-10T17:00:00.123456+02:00" },
        { resets_left: 0, resets_total: null, paused: true, starts_at: "2000-01-01T00:00:00Z", ends_at: "2000-01-02T00:00:00Z" },
        { ...grant, starts_at: "2099-01-01T00:00:00Z" },
      ],
    })

    expect(entry.claudeResets).toEqual({ eligible: true, unreadableGrants: 0, grants: [
      { remainingResets: 2, paused: false, startsAt: null, endsAt: 4098006000123 },
      { remainingResets: 0, paused: true, startsAt: 946684800000, endsAt: 946771200000 },
      { remainingResets: 2, paused: false, startsAt: 4070908800000, endsAt: null },
    ] })
    expect(entry.windows).toEqual([
      { type: "five_hour", utilization: 0.36, resetsAt: 1793831400000 },
      { type: "seven_day", utilization: 0.05, resetsAt: 1794330000000 },
    ])
    expect(entry.extraUsage).toEqual({ isEnabled: true, monthlyLimit: 1, usedCredits: 0.12, utilization: 0.12, currency: "USD", exponent: 2 })
  })

  test.each([true, false])("preserves an empty eligible=%s inventory", async eligible => {
    const entry = await readInventory({ eligible, grants: [] })
    expect(entry.claudeResets).toEqual({ eligible, grants: [], unreadableGrants: 0 })
  })

  test.each([
    undefined, null, false, [], {},
    { eligible: "true", grants: [] },
    { eligible: true },
    { eligible: true, grants: null },
    { eligible: true, grants: {} },
    { eligible: true, grants: Array.from({ length: 201 }, () => grant) },
  ])("returns unknown for an absent or malformed block: %j", async block => {
    const entry = await readInventory(block)
    expect(entry.claudeResets).toBeNull()
    expect(entry.error).toBeNull()
    expect(entry.windows).toHaveLength(2)
  })

  test.each([
    null, [], "grant", {},
    { ...grant, resets_left: -1 },
    { ...grant, resets_left: 1.5 },
    { ...grant, resets_left: "2" },
    { ...grant, resets_left: Number.MAX_SAFE_INTEGER + 1 },
    { ...grant, resets_total: 1 },
    { ...grant, resets_total: 2.5 },
    { ...grant, resets_total: "3" },
    { resets_left: 2 },
    { ...grant, paused: "false" },
    { ...grant, starts_at: "not-a-date" },
    { ...grant, starts_at: "2026-02-30T00:00:00Z" },
    { ...grant, starts_at: "2026-11-04T00:00:00+29:00" },
    { ...grant, starts_at: 123 },
    { ...grant, ends_at: "" },
    { ...grant, ends_at: "11/04/2026" },
    { ...grant, ends_at: true },
  ])("counts an unreadable grant without hiding readable grants: %j", async malformed => {
    const entry = await readInventory({ eligible: true, grants: [malformed, grant] })
    expect(entry.claudeResets).toEqual({
      eligible: true,
      grants: [{ remainingResets: 2, paused: false, startsAt: null, endsAt: null }],
      unreadableGrants: 1,
    })
  })

  test("keeps all 200 allowed records without applying the consumer's active reset limit", async () => {
    const entry = await readInventory({ eligible: true, grants: Array.from({ length: 200 }, () => grant) })
    expect(entry.claudeResets?.grants).toHaveLength(200)
    expect(entry.claudeResets?.unreadableGrants).toBe(0)
  })

  test("coalesces each profile's read and preserves its own inventory on a stale response", async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return Response.json({ ...windows, cedar_ember: { eligible: true, grants: [{ ...grant, resets_left: calls }] } })
    }
    const first = { profileId: "first-reset-profile", store, fetchImpl }
    const second = { ...first, profileId: "second-reset-profile" }
    const [a, coalesced, b] = await Promise.all([
      fetchOAuthUsageResult(first), fetchOAuthUsageResult(first), fetchOAuthUsageResult(second),
    ])
    const cached = await fetchOAuthUsageResult(first)
    const stale = await fetchOAuthUsageResult({ ...first, force: true, fetchImpl: async () => new Response(null, { status: 503 }) })

    expect(calls).toBe(2)
    expect(coalesced.snapshot).toEqual(a.snapshot)
    expect(cached.snapshot).toEqual(a.snapshot)
    expect(toUsageEntry(a).claudeResets?.grants[0]?.remainingResets).toBe(1)
    expect(toUsageEntry(b).claudeResets?.grants[0]?.remainingResets).toBe(2)
    expect(toUsageEntry(stale)).toEqual({ ...toUsageEntry(a), stale: true, failure: stale.failure })
    expect(stale.failure?.reason).toBe("upstream_error")
  })
})
