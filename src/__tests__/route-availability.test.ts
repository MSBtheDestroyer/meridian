import { describe, expect, it } from "bun:test"
import { routeAvailability, claudeReturnUsage } from "../proxy/routeAvailability"
import type { CodexUsageWindow } from "../proxy/codex/types"

const NOW = 1_800_000_000_000
const usage = { fetchedAt: NOW - 1_000, stale: false, error: null, failure: null }
const windows: CodexUsageWindow[] = [
  { type: "5h", utilization: 0.25, resetsAt: NOW + 3_600_000, limitWindowSeconds: 18_000 },
  { type: "7d", utilization: 0.75, resetsAt: NOW + 86_400_000, limitWindowSeconds: 604_800 },
]
const request = { provider: "chatgpt", model: "gpt-6.2-sol", variant: "xhigh" }
const live = { ...usage, windows }

describe("exact ChatGPT work-route availability", () => {
  it("returns the limiting observed plan allotment and its observation time", () => {
    const response = routeAvailability(request, [live], NOW)

    expect(response).toEqual({ ...request, version: 1, available: true, routable_allotment: 0.25, observed_at: NOW - 1_000 })
  })

  it.each([
    ["stale", { ...live, stale: true }],
    ["expired", { ...live, fetchedAt: NOW - 30_001 }],
    ["from the future", { ...live, fetchedAt: NOW + 1 }],
    ["unknown", { ...live, windows: [{ ...windows[0]!, utilization: null }] }],
    ["exhausted", { ...live, windows: [{ ...windows[0]!, utilization: 1 }] }],
  ] as const)("does not claim %s plan allotment", (_name, entry) => {
    const response = routeAvailability(request, [entry], NOW)

    expect(response).toEqual({ ...request, version: 1, available: false, routable_allotment: 0, observed_at: null })
  })
})

describe("exact Claude Opus return availability", () => {
  const claude = { provider: "claude", model: "claude-opus-5-5", variant: "high" }
  const plan = [
    { type: "five_hour", utilization: 0.25, resetsAt: NOW + 3_600_000 },
    { type: "seven_day", utilization: 0.5, resetsAt: NOW + 86_400_000 },
    { type: "seven_day_opus", utilization: 0.75, resetsAt: NOW + 86_400_000 },
    { type: "seven_day_sonnet", utilization: 1, resetsAt: NOW + 86_400_000 },
  ]
  const snapshot = { fetchedAt: NOW - 1_000, windows: plan, extraUsage: null, bankedResets: null }
  it("uses the tightest governing window, not another model's spent window", () => {
    const usage = claudeReturnUsage(claude.model, snapshot, [])

    expect(routeAvailability(claude, usage ? [usage] : [], NOW)).toEqual({
      ...claude, version: 1, available: true, routable_allotment: 0.25, observed_at: NOW - 1_000,
    })
  })

  it("does not return on missing account-wide quota or a newer Opus refusal", () => {
    const missing = claudeReturnUsage(claude.model, { ...snapshot, windows: plan.slice(2) }, [])
    const refused = claudeReturnUsage(claude.model, snapshot, [{
      status: "rejected", rateLimitType: "seven_day_opus", observedAt: NOW - 10, resetsAt: NOW + 86_400_000,
    }])

    expect([missing, refused]).toEqual([undefined, undefined])
  })
})
