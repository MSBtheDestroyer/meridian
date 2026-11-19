import { describe, expect, it } from "bun:test"
import { USAGE_REFRESH_MIN_INTERVAL_MS, UsageRefreshGate, openedWindowTypes } from "../proxy/usageRefresh"

describe("UsageRefreshGate", () => {
  it("lets one refresh per key through per interval", () => {
    const gate = new UsageRefreshGate()
    expect(gate.claim("work", 1_000)).toEqual({ ok: true })
    expect(gate.claim("work", 1_000 + USAGE_REFRESH_MIN_INTERVAL_MS - 1)).toEqual({ ok: false, retryAfterMs: 1 })
    expect(gate.claim("work", 1_000 + USAGE_REFRESH_MIN_INTERVAL_MS)).toEqual({ ok: true })
  })

  it("keeps keys apart", () => {
    const gate = new UsageRefreshGate()
    expect(gate.claim("work", 0).ok).toBe(true)
    expect(gate.claim("personal", 0).ok).toBe(true)
  })

  it("forgets a key", () => {
    const gate = new UsageRefreshGate()
    gate.claim("work", 0)
    gate.forget("work")
    expect(gate.claim("work", 1).ok).toBe(true)
  })
})

describe("openedWindowTypes", () => {
  it("lists the windows a fresh reading shows below their limit", () => {
    expect(openedWindowTypes([
      { type: "five_hour", utilization: 0.1 },
      { type: "seven_day", utilization: 1 },
      { type: "seven_day_opus", utilization: null },
      { type: "seven_day_sonnet", utilization: 0.99 },
    ])).toEqual(["five_hour", "seven_day_sonnet"])
  })
})
