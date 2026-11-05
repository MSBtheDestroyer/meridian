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
  followedUsageSnapshot,
  readFollowedUsage,
  resetFollowedUsage,
  setFollowedUsageForTesting,
} from "../proxy/followUsage"
import { fetchOAuthUsageResult, resetOAuthUsageCache, toUsageEntry, type OAuthUsageSnapshot } from "../proxy/oauthUsage"

const FLAG = "MERIDIAN_FOLLOW_ACTIVE"

function quotaBody(profiles: unknown[]): unknown {
  return { profiles, activeProfile: "personal", asOf: Date.now() }
}

function snapshot(utilization: number): OAuthUsageSnapshot {
  return {
    windows: [{ type: "five_hour", utilization, resetsAt: null }],
    extraUsage: null,
    fetchedAt: Date.now(),
  }
}

afterEach(() => {
  delete process.env[FLAG]
  delete process.env.CLAUDE_PROXY_FOLLOW_ACTIVE
  resetFollowedUsage()
  resetOAuthUsageCache()
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
})
