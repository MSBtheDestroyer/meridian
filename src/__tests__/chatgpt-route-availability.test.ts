import { describe, expect, it } from "bun:test"
import { chatGptRouteAvailability } from "../proxy/chatgpt/routeAvailability"
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
    const response = chatGptRouteAvailability(request, [live], NOW)

    expect(response).toEqual({ ...request, version: 1, available: true, routable_allotment: 0.25, observed_at: NOW - 1_000 })
  })

  it.each([
    ["stale", { ...live, stale: true }],
    ["expired", { ...live, fetchedAt: NOW - 30_001 }],
    ["from the future", { ...live, fetchedAt: NOW + 1 }],
    ["unknown", { ...live, windows: [{ ...windows[0]!, utilization: null }] }],
    ["exhausted", { ...live, windows: [{ ...windows[0]!, utilization: 1 }] }],
  ] as const)("does not claim %s plan allotment", (_name, entry) => {
    const response = chatGptRouteAvailability(request, [entry], NOW)

    expect(response).toEqual({ ...request, version: 1, available: false, routable_allotment: 0, observed_at: null })
  })
})
