/**
 * followUsage — a follower reports the usage figures the followed instance
 * has already paid for, instead of competing with it for the same per-account
 * rate-limit budget.
 *
 * The parser is pure and gets direct tests. The lookup is gated on
 * MERIDIAN_FOLLOW_ACTIVE, which this file sets and restores per test; the
 * preload clears it, so nothing here leaks into the profile/routing suites.
 */

import { describe, expect, test, afterEach } from "bun:test"
import {
  FOLLOW_USAGE_MAX_AGE_MS,
  FOLLOW_USAGE_STALE_AFTER_MS,
  followedUsageSnapshot,
  pollFollowedUsage,
  readFollowedUsage,
  resetFollowedUsage,
  setFollowedUsageForTesting,
  stopFollowUsagePolling,
} from "../proxy/followUsage"
import { fetchOAuthUsageResult, resetOAuthUsageCache, toUsageEntry, type OAuthUsageSnapshot } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const FLAG = "MERIDIAN_FOLLOW_ACTIVE"

function quotaBody(profiles: unknown[]): unknown {
  return { profiles, activeProfile: "personal", asOf: Date.now() }
}

function snapshot(utilization: number): OAuthUsageSnapshot {
  return {
    windows: [{ type: "five_hour", utilization, resetsAt: null }],
    extraUsage: null,
    bankedResets: null,
    fetchedAt: Date.now(),
  }
}

const originalFetch = globalThis.fetch

/** A credential store and usage endpoint that count every touch. */
function localPath() {
  let reads = 0
  let calls = 0
  const store: CredentialStore = {
    async read() { reads++; return null },
    async write() { return true },
  }
  const fetchImpl = async () => { calls++; return new Response("{}", { status: 500 }) }
  return { store, fetchImpl, reads: () => reads, calls: () => calls }
}

/** A signed-in account whose own usage read answers `utilization`. */
function signedIn(utilization: number) {
  let calls = 0
  const store: CredentialStore = {
    async read() { return { claudeAiOauth: { accessToken: "tok", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 } } },
    async write() { return true },
  }
  const fetchImpl = async () => { calls++; return Response.json({ five_hour: { utilization } }) }
  return { store, fetchImpl, calls: () => calls }
}

afterEach(() => {
  delete process.env[FLAG]
  delete process.env.CLAUDE_PROXY_FOLLOW_ACTIVE
  resetFollowedUsage()
  resetOAuthUsageCache()
  globalThis.fetch = originalFetch
})

describe("readFollowedUsage", () => {
  test("keeps profiles that carry windows", () => {
    const parsed = readFollowedUsage(quotaBody([
      {
        id: "personal",
        windows: [
          { type: "five_hour", utilization: 0.4, resetsAt: 1234 },
          { type: "seven_day", utilization: 0.1, resetsAt: null },
        ],
        extraUsage: null,
        fetchedAt: 999,
        error: null,
      },
    ]))

    expect(parsed.size).toBe(1)
    const personal = parsed.get("personal")!
    expect(personal.windows).toEqual([
      { type: "five_hour", utilization: 0.4, resetsAt: 1234 },
      { type: "seven_day", utilization: 0.1, resetsAt: null },
    ])
    expect(personal.fetchedAt).toBe(999)
    expect(personal.claudeResets).toBeNull()
  })

  test("preserves three peer resets through follower acquisition without identifiers or upstream reads", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    const parsed = readFollowedUsage(quotaBody([{
      id: "reset-peer",
      windows: [{ type: "five_hour", utilization: 0.4, resetsAt: 1800018000000 }],
      fetchedAt: 1800000000000,
      claudeResets: {
        eligible: true, unreadableGrants: 1, accountId: "private-account",
        grants: [{ remainingResets: 3, paused: false, startsAt: null, endsAt: 1800086400000, id: "redemption-handle", label: "private-label" }],
      },
    }]))
    setFollowedUsageForTesting(parsed)

    const entry = toUsageEntry(await fetchOAuthUsageResult({
      profileId: "reset-peer",
      store: {
        async read() { throw new Error("Follower must not read credentials") },
        async write() { throw new Error("Follower must not write credentials") },
      },
      fetchImpl: async () => { throw new Error("Follower must not fetch upstream") },
    }))

    expect(parsed.size).toBe(1)
    expect(entry.claudeResets).toEqual({
      eligible: true, unreadableGrants: 1,
      grants: [{ remainingResets: 3, paused: false, startsAt: null, endsAt: 1800086400000 }],
    })
    expect(entry.windows).toEqual([{ type: "five_hour", utilization: 0.4, resetsAt: 1800018000000 }])
    expect(entry.fetchedAt).toBe(1800000000000)
    expect(entry.error).toBeNull()
  })

  const peerGrant = { remainingResets: 3, paused: false, startsAt: null, endsAt: null }
  test.each([
    undefined, null, {},
    { eligible: "true", grants: [], unreadableGrants: 0 },
    { eligible: true, grants: [], unreadableGrants: -1 },
    { eligible: true, grants: [], unreadableGrants: 0.5 },
    { eligible: true, grants: [peerGrant] },
    { eligible: true, grants: [{ ...peerGrant, remainingResets: -1 }], unreadableGrants: 0 },
    { eligible: true, grants: [{ ...peerGrant, paused: "false" }], unreadableGrants: 0 },
    { eligible: true, grants: [{ ...peerGrant, endsAt: "2099-01-01T00:00:00Z" }], unreadableGrants: 0 },
    { eligible: true, grants: [{ ...peerGrant, startsAt: Infinity }], unreadableGrants: 0 },
    { eligible: true, grants: Array.from({ length: 201 }, () => peerGrant), unreadableGrants: 0 },
    { eligible: true, grants: [peerGrant], unreadableGrants: 200 },
  ])("keeps windows but reports unknown inventory for malformed peer data: %j", claudeResets => {
    const parsed = readFollowedUsage(quotaBody([{ id: "peer", ...snapshot(0.4), claudeResets }]))
    expect(parsed.get("peer")?.claudeResets).toBeNull()
    expect(parsed.get("peer")?.windows).toEqual([{ type: "five_hour", utilization: 0.4, resetsAt: null }])
  })

  test("retains an ineligible peer snapshot and all 200 readable records at the cap", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "ineligible", ...snapshot(0.4), claudeResets: { eligible: false, grants: [], unreadableGrants: 0 } },
      { id: "bounded", ...snapshot(0.4), claudeResets: { eligible: true, grants: Array.from({ length: 200 }, () => peerGrant), unreadableGrants: 0 } },
    ]))
    expect(parsed.get("ineligible")?.claudeResets).toEqual({ eligible: false, grants: [], unreadableGrants: 0 })
    expect(parsed.get("bounded")?.claudeResets?.grants).toHaveLength(200)
  })

  test("drops a profile the followed instance itself could not read", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "dead", windows: [], extraUsage: null, fetchedAt: null, error: "no_token" },
      { id: "limited", windows: [], extraUsage: null, fetchedAt: null, error: "upstream_error" },
    ]))
    expect(parsed.size).toBe(0)
  })

  test("drops an entry with no windows even when it reports no error", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "cold", windows: [], extraUsage: null, fetchedAt: null, error: null },
    ]))
    expect(parsed.size).toBe(0)
  })

  test("survives a garbage body without throwing", () => {
    expect(readFollowedUsage(undefined).size).toBe(0)
    expect(readFollowedUsage(null).size).toBe(0)
    expect(readFollowedUsage("nope").size).toBe(0)
    expect(readFollowedUsage({ profiles: "nope" }).size).toBe(0)
    expect(readFollowedUsage({ profiles: [null, 7, { noId: true }] }).size).toBe(0)
  })

  test("keeps the followed instance's stale mark, banked resets and extra usage", () => {
    const bankedResets = { eligible: true, nextGrantId: "g1", ineligibleReason: null, grants: [] }
    const extraUsage = { isEnabled: true, monthlyLimit: 50, usedCredits: 5, utilization: 0.1, currency: "USD", exponent: 2 }
    const parsed = readFollowedUsage(quotaBody([
      { id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }],
        extraUsage, bankedResets, fetchedAt: 999, stale: true, error: null },
    ]))
    expect(parsed.get("personal")).toEqual({
      windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }],
      extraUsage, bankedResets, claudeResets: null, fetchedAt: 999, stale: true,
    })
  })

  test("converts extra usage from a followed instance that still serves cents", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "personal", windows: [{ type: "five_hour", utilization: 1, resetsAt: null }], fetchedAt: 999, error: null,
        extraUsage: { isEnabled: true, monthlyLimit: 500, usedCredits: 539, utilization: 1, currency: "USD" } },
    ]))
    expect(parsed.get("personal")!.extraUsage).toEqual({ isEnabled: true, monthlyLimit: 5, usedCredits: 5.39, utilization: 1, currency: "USD", exponent: 2 })
  })

  test("drops malformed extra usage and banked resets instead of importing them", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }],
        extraUsage: "lots", bankedResets: { eligible: "yes" }, error: null },
    ]))
    expect(parsed.get("personal")!.extraUsage).toBeNull()
    expect(parsed.get("personal")!.bankedResets).toBeNull()
  })

  test("skips malformed windows but keeps the usable ones", () => {
    const parsed = readFollowedUsage(quotaBody([
      {
        id: "mixed",
        windows: [
          { utilization: 0.5 },
          { type: "five_hour", utilization: "high", resetsAt: "soon" },
          { type: "seven_day", utilization: 0.2, resetsAt: 42 },
        ],
        error: null,
      },
    ]))
    expect(parsed.get("mixed")!.windows).toEqual([
      { type: "five_hour", utilization: null, resetsAt: null },
      { type: "seven_day", utilization: 0.2, resetsAt: 42 },
    ])
  })
})

describe("followedUsageSnapshot", () => {
  test("returns nothing when this instance follows no one", () => {
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })

  test("returns the followed figures when following", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
  })

  test("returns nothing for a profile the followed instance did not report", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("someone-else")).toBeUndefined()
  })

  test("stops serving figures older than the max age", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(
      new Map([["personal", snapshot(0.4)]]),
      Date.now() - FOLLOW_USAGE_MAX_AGE_MS - 1,
    )
    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })

  test("marks figures stale once two polls have been missed", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]), Date.now() - FOLLOW_USAGE_STALE_AFTER_MS - 1)
    const served = followedUsageSnapshot("personal")!
    expect(served.windows[0]!.utilization).toBe(0.4)
    expect(served.stale).toBe(true)
  })

  test("serves recently polled figures unmarked", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")!.stale).toBeUndefined()
  })
})

describe("usage reads on a follower", () => {
  test("serve the followed figures without reading credentials or calling Anthropic", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    const local = localPath()

    const result = await fetchOAuthUsageResult({ profileId: "personal", store: local.store, fetchImpl: local.fetchImpl })

    expect(result.snapshot!.windows[0]!.utilization).toBe(0.4)
    expect(result.error).toBeNull()
    expect(result.failure).toBeNull()
    expect(local.reads()).toBe(0)
    expect(local.calls()).toBe(0)
  })

  test("serve the followed default account to the unscoped read", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["default", snapshot(0.7)]]))
    const local = localPath()

    const result = await fetchOAuthUsageResult({ store: local.store, fetchImpl: local.fetchImpl })

    expect(result.snapshot!.windows[0]!.utilization).toBe(0.7)
    expect(local.reads()).toBe(0)
  })

  test("fall back to this instance's own credentials for a profile the followed instance did not report", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    const local = localPath()

    const result = await fetchOAuthUsageResult({ profileId: "work", force: true, store: local.store, fetchImpl: local.fetchImpl })

    expect(result.snapshot).toBeNull()
    expect(local.reads()).toBeGreaterThan(0)
  })
})

describe("forced usage reads on a follower", () => {
  test("ask Anthropic for the account instead of serving the followed copy", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    const own = signedIn(93)

    const result = await fetchOAuthUsageResult({ profileId: "personal", force: true, store: own.store, fetchImpl: own.fetchImpl })

    expect(own.calls()).toBe(1)
    expect(result.snapshot!.windows.find(w => w.type === "five_hour")!.utilization).toBe(0.93)
  })

  test("are not overwritten by an older followed copy on the next read", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", { ...snapshot(0.4), fetchedAt: Date.now() - 60_000 }]]))
    const own = signedIn(93)
    await fetchOAuthUsageResult({ profileId: "personal", force: true, store: own.store, fetchImpl: own.fetchImpl })

    const next = await fetchOAuthUsageResult({ profileId: "personal", ttlMs: 0, store: own.store, fetchImpl: own.fetchImpl })

    expect(own.calls()).toBe(1)
    expect(next.snapshot!.windows.find(w => w.type === "five_hour")!.utilization).toBe(0.93)
  })
})

describe("pollFollowedUsage", () => {
  test("reads every profile's figures from the followed instance in one request", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    const urls: string[] = []
    globalThis.fetch = Object.assign(async (url: string | URL | Request) => {
      urls.push(String(url))
      return Response.json(quotaBody([
        { id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }], error: null },
        { id: "work", windows: [{ type: "five_hour", utilization: 0.9, resetsAt: null }], error: null },
      ]))
    }, { preconnect: originalFetch.preconnect })

    await pollFollowedUsage()

    expect(urls).toEqual(["http://127.0.0.1:3456/v1/usage/quota/all"])
    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
    expect(followedUsageSnapshot("work")!.windows[0]!.utilization).toBe(0.9)
  })

  test("keeps the last figures when the followed instance cannot be reached", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    globalThis.fetch = Object.assign(async () => { throw new Error("ECONNREFUSED") }, { preconnect: originalFetch.preconnect })

    await pollFollowedUsage()

    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
  })

  test("discards a poll that answers after polling stopped", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    let answer!: (r: Response) => void
    globalThis.fetch = Object.assign(() => new Promise<Response>(resolve => { answer = resolve }), { preconnect: originalFetch.preconnect })

    const poll = pollFollowedUsage()
    stopFollowUsagePolling()
    answer(Response.json(quotaBody([{ id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }], error: null }])))
    await poll

    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })
})
