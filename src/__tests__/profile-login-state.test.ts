import { describe, expect, it } from "bun:test"
import { applyLogin, applyObservation, applyRefreshRejected, applyRefreshSucceeded, authLifecycleLoggedOut } from "../proxy/authLifecycle"
import { profileLoginState } from "../proxy/profileLoginState"

const START = 1_790_000_000_000
const HOUR = 3_600_000

describe("one profile login state across surfaces", () => {
  it("counts a refused renewal as logged out only once the access token it left has run out", () => {
    const rejected = applyRefreshRejected(undefined, { at: START }).record

    const serving = authLifecycleLoggedOut(rejected, START + HOUR, START + 1)
    const lapsed = authLifecycleLoggedOut(rejected, START + HOUR, START + HOUR + 1)

    expect(profileLoginState({ loggedIn: true, presence: "present", loggedOut: serving })).toBe("authenticated")
    expect(profileLoginState({ loggedIn: true, presence: "present", loggedOut: lapsed })).toBe("needs_login")
  })

  it("counts a cleared credential as logged out whatever its stored access expiry says", () => {
    const cleared = applyObservation(undefined, { at: START, presence: "absent" }).record
    expect(profileLoginState({ loggedIn: true, presence: "absent", loggedOut: authLifecycleLoggedOut(cleared, START + HOUR, START) }))
      .toBe("needs_login")
  })

  it("keeps a transiently unreadable store distinct from absent credentials", () => {
    expect(profileLoginState({ loggedIn: true, presence: "unknown" })).toBe("authenticated")
    expect(profileLoginState({ presence: "unknown" })).toBe("unverified")
    expect(profileLoginState({ loggedIn: true, presence: "absent" })).toBe("needs_login")
    expect(profileLoginState({ loggedIn: false, presence: "present" })).toBe("needs_login")
  })

  it("clears a recorded refusal after a completed login or token refresh", () => {
    const rejected = applyRefreshRejected(undefined, { at: START }).record

    const loggedIn = applyLogin(rejected, { at: START + 1 }).record
    const refreshed = applyRefreshSucceeded(rejected, { at: START + 1 }).record

    expect(loggedIn.firstUnauthedAt).toBeUndefined()
    expect(refreshed.firstUnauthedAt).toBeUndefined()
  })
})
