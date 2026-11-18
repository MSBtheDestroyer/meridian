/**
 * The free-reset view both account pages draw from `bankedResets`, and the
 * sentence /profiles shows after a redeem. Pure functions, no mocks; each is
 * also rebuilt from its `.toString()` copy, the way the pages embed it.
 */
import { describe, expect, it } from "bun:test"
import { freeResetOutcomeText, freeResetView, type FreeResetView } from "../telemetry/freeResets"
import { profilePageHtml } from "../telemetry/profilePage"
import { landingHtml } from "../telemetry/landing"

const NOW = 1_794_900_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id, resetsLeft: 1, expiresAt: NOW + 112 * DAY, startsAt: NOW - 7 * DAY, paused: false, usableNow: true, ...over,
})

/** As claude.ai reported DH Sub #1 on 2026-11-16: four grants, one reset each. */
const SUB1 = {
  eligible: true,
  ineligibleReason: null,
  nextGrantId: "full-reset-2611",
  grants: [
    grant("full-reset-2611", { expiresAt: NOW + 24 * DAY, startsAt: NOW - 6 * DAY }),
    grant("launch-2610-fable"),
    grant("launch-2610-fable-12mo"),
    grant("launch-2610-fable-6mo"),
  ],
}

const pageView = new Function(`return (${freeResetView.toString()})`)() as typeof freeResetView
const pageOutcome = new Function(`return (${freeResetOutcomeText.toString()})`)() as typeof freeResetOutcomeText

describe("freeResetView", () => {
  it("counts every grant's resets and names the provider's next grant to redeem", () => {
    const view = freeResetView(SUB1, NOW) as FreeResetView
    expect(view.available).toBe(4)
    expect(view.usable).toBe(4)
    expect(view.grantId).toBe("full-reset-2611")
    expect(view.expiresAt).toBe(NOW + 24 * DAY)
    expect(view.value).toBe("4")
    expect(view.note).toBe("all usable now \u00b7 next expires in 24d")
  })

  it("separates resets the provider holds back from those usable now", () => {
    const view = freeResetView({
      ...SUB1,
      grants: [SUB1.grants[0], { ...SUB1.grants[1], usableNow: false }, { ...SUB1.grants[2], paused: true },
        { ...SUB1.grants[3], startsAt: NOW + DAY }],
    }, NOW) as FreeResetView
    expect(view.available).toBe(4)
    expect(view.usable).toBe(1)
    expect(view.note).toBe("1 usable now \u00b7 next expires in 24d")
    expect(view.title).toContain("4 free resets banked; 1 can be redeemed now")
  })

  it("offers no grant when none is usable, and says so", () => {
    const view = freeResetView({ ...SUB1, grants: [{ ...SUB1.grants[0], usableNow: false }] }, NOW) as FreeResetView
    expect(view.usable).toBe(0)
    expect(view.grantId).toBeNull()
    expect(view.note).toBe("none usable now \u00b7 expires in 24d")
  })

  it("falls back to the soonest-expiring usable grant when the provider's next one is not usable", () => {
    const view = freeResetView({
      ...SUB1,
      nextGrantId: "full-reset-2611",
      grants: [{ ...SUB1.grants[0], usableNow: false }, grant("b", { expiresAt: NOW + 90 * DAY }), grant("a", { expiresAt: NOW + 30 * DAY })],
    }, NOW) as FreeResetView
    expect(view.grantId).toBe("a")
  })

  it("ignores expired and spent grants, and never offers a grant with no id", () => {
    const view = freeResetView({
      eligible: true,
      nextGrantId: null,
      grants: [grant("old", { expiresAt: NOW - HOUR }), grant("spent", { resetsLeft: 0 }), { ...grant("x"), id: null }],
    }, NOW) as FreeResetView
    expect(view.available).toBe(1)
    expect(view.usable).toBe(1)
    expect(view.grantId).toBeNull()
  })

  it("shows nothing for an ineligible, empty, absent or malformed reading", () => {
    expect(freeResetView(null, NOW)).toBeNull()
    expect(freeResetView(undefined, NOW)).toBeNull()
    expect(freeResetView({ ...SUB1, eligible: false }, NOW)).toBeNull()
    expect(freeResetView({ ...SUB1, grants: [] }, NOW)).toBeNull()
    expect(freeResetView({ eligible: true, grants: "nope" }, NOW)).toBeNull()
    expect(freeResetView({ eligible: true, grants: [{ resetsLeft: "1" }, null] }, NOW)).toBeNull()
  })

  it("words short expiries in hours and minutes", () => {
    expect(freeResetView({ eligible: true, nextGrantId: "a", grants: [grant("a", { expiresAt: NOW + 5 * HOUR + 1 })] }, NOW)?.note)
      .toBe("all usable now \u00b7 expires in 5h")
    expect(freeResetView({ eligible: true, nextGrantId: "a", grants: [grant("a", { expiresAt: NOW + 20 * 60_000 })] }, NOW)?.note)
      .toBe("all usable now \u00b7 expires in 20m")
    expect(freeResetView({ eligible: true, nextGrantId: "a", grants: [grant("a", { expiresAt: null })] }, NOW)?.note)
      .toBe("all usable now")
  })

  it("is self-contained, so the copy the pages embed gives the same answer", () => {
    for (const input of [SUB1, null, { ...SUB1, eligible: false },
      { ...SUB1, grants: [{ ...SUB1.grants[0], usableNow: false }] }]) {
      expect(pageView(input, NOW)).toEqual(freeResetView(input, NOW))
    }
  })
})

describe("freeResetOutcomeText", () => {
  it("reports a redeemed reset with what it cleared and what is left", () => {
    expect(freeResetOutcomeText(200, { result: "reset", cleared: ["five_hour", "seven_day"], resetsLeft: 0 }))
      .toEqual({ ok: true, text: "Reset redeemed: cleared five_hour, seven_day. 0 left on that grant." })
    expect(freeResetOutcomeText(200, { result: "reset", cleared: [], resetsLeft: null }))
      .toEqual({ ok: true, text: "Reset redeemed." })
  })

  it("explains each refusal in words rather than the provider's code", () => {
    expect(freeResetOutcomeText(200, { result: "not_limited" }).text)
      .toBe("Not redeemed: Anthropic says this account is not rate limited, so there is nothing to reset yet.")
    expect(freeResetOutcomeText(200, { result: "already_used" }).text).toContain("already been used")
    expect(freeResetOutcomeText(200, { result: "cooldown" }).ok).toBe(false)
  })

  it("warns when the outcome is unknown, so nobody retries blindly", () => {
    const out = freeResetOutcomeText(502, { code: "upstream_error", error: "Upstream request failed", indeterminate: true })
    expect(out.ok).toBe(false)
    expect(out.text).toBe("Not redeemed: Upstream request failed. It may have gone through - check the figures before trying again.")
    expect(freeResetOutcomeText(409, { error: "Another reset for this profile is still in progress" }).text)
      .toBe("Not redeemed: Another reset for this profile is still in progress.")
    expect(freeResetOutcomeText(0, null).text).toBe("Not redeemed: Meridian did not answer.")
  })

  it("is self-contained, so the embedded copy gives the same answer", () => {
    for (const [status, body] of [[200, { result: "reset", cleared: ["five_hour"], resetsLeft: 2 }], [200, { result: "not_limited" }],
      [502, { error: "x", indeterminate: true }], [0, null]] as const) {
      expect(pageOutcome(status, body)).toEqual(freeResetOutcomeText(status, body))
    }
  })
})

describe("both account pages embed it", () => {
  it("/profiles draws the free-reset block and its deliberate redeem control", () => {
    expect(profilePageHtml).toContain("var freeResetView = ")
    expect(profilePageHtml).toContain("var freeResetOutcomeText = ")
    expect(profilePageHtml).toContain("usage-extra free-resets")
    expect(profilePageHtml).toContain("onclick=\"redeemFreeReset(this)\"")
    expect(profilePageHtml).toContain("confirm(")
    expect(profilePageHtml).toContain("'/v1/usage/quota/reset'")
  })

  it("/ draws a free-reset row on each Claude card", () => {
    expect(landingHtml).toContain("var freeResetView=")
    expect(landingHtml).toContain("resets-row")
  })
})
