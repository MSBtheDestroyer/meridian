import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { configPath } from "../configDir"
import {
  CLAUDE_AI_READING_FRESH_MS,
  cvpAccessFor,
  cvpAccessOn,
  cvpActive,
  cvpTierFromBadge,
  cyberVerificationOf,
  forgetCvpAccess,
  normalizeCvpModel,
  parseRoutingRequirements,
  recordCvpReading,
  recordCvpRefusal,
  resetCvpAccessCacheForTests,
} from "../proxy/cvpAccess"

const DEFENSE = { message: "CVP: Defense Access", variant: "neutral" }
const T0 = 1_800_000_000_000

beforeEach(() => {
  rmSync(configPath("cvp-access.json"), { force: true })
  resetCvpAccessCacheForTests()
})

describe("claude.ai readings", () => {
  it("marks badged models active with their tier and the rest inactive", () => {
    const map = recordCvpReading("team", [
      { id: "claude-opus-5-5", name: "Opus 5.5", badge: DEFENSE, selector_badge: { message: "CVP" } },
      { id: "claude-fable-5-2", name: "Fable 5.2" },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", badge: null },
    ], T0)

    expect(map).toEqual([
      { model: "claude-fable-5-2", type: "inactive", tier: null, reason: null, source: "claude_ai", at: T0, name: "Fable 5.2" },
      { model: "claude-haiku-4-5", type: "inactive", tier: null, reason: null, source: "claude_ai", at: T0, name: "Haiku 4.5" },
      { model: "claude-opus-5-5", type: "active", tier: "c", reason: null, source: "claude_ai", at: T0, name: "Opus 5.5" },
    ])
    expect(cvpActive("team", "claude-opus-5-5[1m]", T0)).toBe(true)
    expect(cvpActive("team", "claude-fable-5-2", T0)).toBe(false)
    expect(cvpActive("max", "claude-opus-5-5", T0)).toBe(false)
  })

  it("replaces the previous reading but keeps observed refusals", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }, { id: "claude-sonnet-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("team", "claude-mythos-5-2", { type: "active", tier: "c" }, T0 + 1)
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0 + 2)

    expect(cvpAccessFor("team", T0 + 2).map(e => [e.model, e.type, e.source])).toEqual([
      ["claude-mythos-5-2", "active", "observed"],
      ["claude-opus-5-5", "active", "claude_ai"],
    ])
  })

  it("reads the tier the badge names", () => {
    expect(cvpTierFromBadge("CVP: Defense Access")).toBe("c")
    expect(cvpTierFromBadge("CVP: Red Team Access")).toBe("b")
    expect(cvpTierFromBadge("CVP: Specialized Access")).toBe("a")
    expect(cvpTierFromBadge("CVP")).toBeNull()
  })
})

describe("refusals", () => {
  it("records an active tier and an inactive reason", () => {
    expect(recordCvpRefusal("max", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)).toBe(true)
    expect(recordCvpRefusal("team", "claude-opus-5-5", { type: "active", tier: "c" }, T0)).toBe(true)

    expect(cvpAccessOn("max", "claude-opus-5-5", T0)).toMatchObject({ type: "inactive", tier: null, reason: "organization_not_approved", source: "observed" })
    expect(cvpActive("team", "claude-opus-5-5", T0)).toBe(true)
  })

  it("ignores a refusal without a readable cyber_verification", () => {
    expect(recordCvpRefusal("team", "claude-opus-5-5", { type: "active", tier: "z" }, T0)).toBe(false)
    expect(recordCvpRefusal("team", "claude-opus-5-5", undefined, T0)).toBe(false)
    expect(recordCvpRefusal("team", "", { type: "active", tier: "c" }, T0)).toBe(false)
    expect(cvpAccessFor("team", T0)).toEqual([])
  })

  it("finds cyber_verification on a refusal row only", () => {
    const refusal = { message: { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", cyber_verification: { type: "active", tier: "c" } } } }
    expect(cyberVerificationOf(refusal)).toEqual({ model: "claude-opus-5-5", value: { type: "active", tier: "c" } })
    expect(cyberVerificationOf({ message: { stop_reason: "end_turn" } })).toBeNull()
    expect(cyberVerificationOf({ message: { stop_reason: "refusal", stop_details: { category: "cyber" } } })).toBeNull()
  })
})

describe("which source decides", () => {
  it("a fresh claude.ai reading beats a later refusal", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("team", "claude-opus-5-5", { type: "inactive", reason: "not_assigned_but_organization_approved" }, T0 + 60_000)

    expect(cvpAccessOn("team", "claude-opus-5-5", T0 + 60_000)?.source).toBe("claude_ai")
    expect(cvpActive("team", "claude-opus-5-5", T0 + 60_000)).toBe(true)
  })

  it("a refusal newer than a stale reading decides", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    const later = T0 + CLAUDE_AI_READING_FRESH_MS + 1
    recordCvpRefusal("team", "claude-opus-5-5", { type: "inactive", reason: "not_assigned_but_organization_approved" }, later)

    expect(cvpAccessOn("team", "claude-opus-5-5", later)).toMatchObject({ source: "observed", type: "inactive" })
    expect(cvpActive("team", "claude-opus-5-5", later)).toBe(false)
  })

  it("a stale reading still beats an older refusal", () => {
    recordCvpRefusal("team", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0 + 1)

    expect(cvpActive("team", "claude-opus-5-5", T0 + CLAUDE_AI_READING_FRESH_MS * 3)).toBe(true)
  })
})

describe("persistence", () => {
  it("survives a restart and is forgotten per profile", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("max", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)
    resetCvpAccessCacheForTests()

    expect(cvpActive("team", "claude-opus-5-5", T0)).toBe(true)
    forgetCvpAccess("team")
    resetCvpAccessCacheForTests()
    expect(cvpAccessFor("team", T0)).toEqual([])
    expect(cvpAccessFor("max", T0)).toHaveLength(1)
    expect(JSON.parse(readFileSync(configPath("cvp-access.json"), "utf-8")).profiles.team).toBeUndefined()
  })

  it("treats a malformed file as empty", () => {
    writeFileSync(configPath("cvp-access.json"), "{\"profiles\": 3}")
    expect(cvpAccessFor("team", T0)).toEqual([])
  })
})

describe("x-meridian-require", () => {
  it("parses cvp and reports unknown requirements", () => {
    expect(parseRoutingRequirements(undefined)).toEqual({ cvp: false, known: [], unknown: [] })
    expect(parseRoutingRequirements(" CVP ")).toEqual({ cvp: true, known: ["cvp"], unknown: [] })
    expect(parseRoutingRequirements("cvp, zdr")).toEqual({ cvp: true, known: ["cvp"], unknown: ["zdr"] })
  })

  it("normalizes model ids the same on every side", () => {
    expect(normalizeCvpModel("Claude-Opus-5-5[1m]")).toBe("claude-opus-5-5")
    expect(normalizeCvpModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5")
  })
})
