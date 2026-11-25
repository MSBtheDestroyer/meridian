import { describe, expect, it } from "bun:test"
import { accountChanged, claudeLoginPart, cvpPart, modelsPart, seatLoginPart, tooSoonPart } from "../proxy/profileRefresh"

describe("claudeLoginPart", () => {
  it("names who the profile is signed in as", () => {
    const part = claudeLoginPart({ state: "authenticated", checkFailed: false, everAnswered: true, presence: "present", email: "a@example.com", accountChanged: false })
    expect(part.state).toBe("fresh")
    expect(part.note).toContain("a@example.com")
  })

  it("says a new login holds another account and that its facts were read afresh", () => {
    const part = claudeLoginPart({ state: "authenticated", checkFailed: false, everAnswered: true, presence: "present", email: "b@example.com", accountChanged: true })
    expect(part.state).toBe("fresh")
    expect(part.note).toContain("another account")
  })

  it("asks for a sign-in when the login is gone", () => {
    const part = claudeLoginPart({ state: "needs_login", checkFailed: false, everAnswered: true, presence: "absent", email: null, accountChanged: false })
    expect(part.state).toBe("failed")
    expect(part.note).toContain("Sign this profile in again")
  })

  it("does not claim an earlier answer stays when there never was one", () => {
    const failed = claudeLoginPart({ state: "unverified", checkFailed: true, everAnswered: false, presence: "unknown", email: null, accountChanged: false })
    expect(failed.state).toBe("failed")
    expect(failed.note).not.toContain("stays")
    expect(claudeLoginPart({ state: "unverified", checkFailed: true, everAnswered: true, presence: "unknown", email: null, accountChanged: false }).note).toContain("stays")
  })
})

describe("seatLoginPart", () => {
  it("reads a seat's login from the usage read that just ran", () => {
    expect(seatLoginPart({ loggedIn: true, tokenState: "ok", email: "s@example.com" })).toMatchObject({ state: "fresh" })
    expect(seatLoginPart({ loggedIn: false, tokenState: "refused", email: null }).state).toBe("failed")
  })
})

describe("modelsPart", () => {
  it("counts a fresh list", () => {
    expect(modelsPart({ count: 3, failure: null, listedAt: 1_000 }, 1_000)).toEqual({ state: "fresh", note: "Listed 3 models for this account." })
  })

  it("calls a provider 429 a rate limit and keeps a list read earlier", () => {
    const part = modelsPart({ count: null, failure: { reason: "upstream_error", status: 429 }, listedAt: 0 }, 5 * 60_000)
    expect(part.state).toBe("rate_limited")
    expect(part.note).toContain("5 min ago stays")
  })

  it("names the built-in list when no list was ever read", () => {
    const part = modelsPart({ count: null, failure: { reason: "no_credential" }, listedAt: null }, 0)
    expect(part.state).toBe("failed")
    expect(part.note).toContain("built-in list")
    expect(part.note).not.toContain("stays")
  })
})

describe("cvpPart", () => {
  it("says Meridian cannot read CVP and how old the last claude.ai reading is", () => {
    const part = cvpPart({ lastClaudeAiReadingAt: 0, forgotten: false }, 3 * 60_000)
    expect(part.state).toBe("unavailable")
    expect(part.note).toContain("claude.ai")
    expect(part.note).toContain("3 min ago")
  })

  it("says when no reading has arrived, and when a new account dropped the old one", () => {
    expect(cvpPart({ lastClaudeAiReadingAt: null, forgotten: false }, 0).note).toContain("No claude.ai reading")
    expect(cvpPart({ lastClaudeAiReadingAt: null, forgotten: true }, 0).note).toContain("another account")
  })
})

describe("tooSoonPart", () => {
  it("answers the time left on the part's own budget", () => {
    expect(tooSoonPart("Usage", 4_200)).toEqual({ state: "rate_limited", note: "Usage was re-read moments ago; the next re-read opens in 5s.", retryAfterMs: 4_200 })
  })
})

describe("accountChanged", () => {
  it("is true only when both readings name an account and they differ", () => {
    expect(accountChanged({ accountUuid: "a" }, { accountUuid: "b" })).toBe(true)
    expect(accountChanged({ accountUuid: "a" }, { accountUuid: "a" })).toBe(false)
    expect(accountChanged(undefined, { accountUuid: "b" })).toBe(false)
    expect(accountChanged({ accountUuid: "a" }, null)).toBe(false)
    expect(accountChanged({ accountUuid: null }, { accountUuid: "b" })).toBe(false)
  })
})
