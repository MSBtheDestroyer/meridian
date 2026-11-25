import { describe, expect, it } from "bun:test"
import {
  FORCED_PROFILE_HOLD_MS,
  describeActivationRefusal,
  forcedProfileFor,
  liveForcedProfile,
  parseRoutingManagedReasons,
  withoutForcedProfile,
} from "../proxy/forcedProfile"

describe("forced active profile", () => {
  it("holds for the fixed span from the moment it is forced", () => {
    expect(forcedProfileFor("loaner-bob", 1_000)).toEqual({ profile: "loaner-bob", forcedAt: 1_000, until: 1_000 + FORCED_PROFILE_HOLD_MS })
  })

  it("is live until its expiry and gone after it", () => {
    const forced = forcedProfileFor("loaner-bob", 1_000)
    expect(liveForcedProfile(forced, forced.until - 1)).toEqual(forced)
    expect(liveForcedProfile(forced, forced.until)).toBeNull()
  })

  it("ignores a malformed saved value", () => {
    expect(liveForcedProfile(undefined, 0)).toBeNull()
    expect(liveForcedProfile({ profile: "", forcedAt: 0, until: 10 }, 1)).toBeNull()
    expect(liveForcedProfile({ profile: "a", forcedAt: "0", until: 10 }, 1)).toBeNull()
    expect(liveForcedProfile("a", 1)).toBeNull()
  })

  it("takes the forced profile out of a list that would keep it away", () => {
    expect(withoutForcedProfile(["a", "b", "c"], "b")).toEqual(["a", "c"])
    expect(withoutForcedProfile(["a", "b"], null)).toEqual(["a", "b"])
  })
})

describe("routingManagedReasons", () => {
  it("keeps non-empty string reasons per profile and drops the rest", () => {
    expect(parseRoutingManagedReasons({ a: "loaner outside its harvest window", b: "", c: 3 })).toEqual({ a: "loaner outside its harvest window" })
    expect(parseRoutingManagedReasons(null)).toEqual({})
    expect(parseRoutingManagedReasons(["a"])).toEqual({})
  })

  it("caps a reason's length", () => {
    expect(parseRoutingManagedReasons({ a: "x".repeat(1000) }).a!.length).toBe(300)
  })
})

describe("describeActivationRefusal", () => {
  it("names the supervisor and repeats the reason it wrote for a managed exclusion", () => {
    const refusal = describeActivationRefusal({
      kind: "managed_excluded",
      profile: "loaner-bob",
      supervisorReason: "Vibeterm fleet policy: loaner outside its harvest window",
      allowForcing: false,
    })
    expect(refusal).toMatchObject({ kind: "managed_excluded", profile: "loaner-bob", forceable: true, forceAllowed: false })
    expect(refusal.by).toContain("routing supervisor")
    expect(refusal.reason).toBe("Vibeterm fleet policy: loaner outside its harvest window")
  })

  it("says the supervisor gave no reason when it wrote none", () => {
    const refusal = describeActivationRefusal({ kind: "managed_excluded", profile: "a", allowForcing: true })
    expect(refusal.reason).toContain("did not say why")
    expect(refusal.forceAllowed).toBe(true)
  })

  it("never offers to force the user's own exclusion, a missing login or follow mode", () => {
    for (const kind of ["excluded", "needs_login", "following"] as const) {
      const refusal = describeActivationRefusal({ kind, profile: "a", detail: "detail", allowForcing: true })
      expect(refusal.forceable).toBe(false)
      expect(refusal.forceAllowed).toBe(false)
    }
  })

  it("lets a hold and a usage reserve be forced, keeping the reserve's own wording", () => {
    expect(describeActivationRefusal({ kind: "held", profile: "a", allowForcing: true }).forceable).toBe(true)
    const reserve = describeActivationRefusal({ kind: "usage_reserve", profile: "a", detail: "a is at its 5-hour reserve", allowForcing: true })
    expect(reserve.forceable).toBe(true)
    expect(reserve.reason).toContain("a is at its 5-hour reserve")
  })

  it("never forces a ChatGPT seat", () => {
    const refusal = describeActivationRefusal({ kind: "managed_excluded", profile: "seat", seat: true, allowForcing: true })
    expect(refusal.forceable).toBe(false)
    expect(refusal.reason).toContain("Claude profile")
  })

  it("explains a profile forced elsewhere and carries the force", () => {
    const forced = forcedProfileFor("loaner-bob", 1_000)
    const refusal = describeActivationRefusal({ kind: "forced_elsewhere", profile: "own", forced, allowForcing: true })
    expect(refusal.forced).toEqual(forced)
    expect(refusal.reason).toContain("loaner-bob")
    expect(refusal.forceable).toBe(false)
  })
})
