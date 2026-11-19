/**
 * CVP access through the HTTP layer: a claude.ai reading posted for a profile,
 * the map on /profiles/list and /v1/models, refusals learned from SDK rows, and
 * `x-meridian-require: cvp` steering unpinned work to an account that holds it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { rmSync } from "node:fs"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { installModelsMock } from "./modelsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let served: string[] = []
let refuseWith: unknown = undefined
let failTokens = new Set<string>()

installSdkMock(() => ({
  query: (params: any) => {
    const token = params.options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? "none"
    served.push(token)
    if (failTokens.has(token)) throw new Error("429 rate limit reached for this account")
    const sessionId = resolveMockSdkSessionId(params.options, "cvp-session")
    return (async function* () {
      const message = assistantMessage([{ type: "text", text: `ok from ${token}` }]) as any
      if (refuseWith !== undefined) {
        message.message = { ...message.message, model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", cyber_verification: refuseWith } }
      }
      yield { ...message, session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "cvp-routing-integration.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_context: unknown, run: () => unknown) => run(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

installModelsMock(() => ({
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "team" }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { clearAccountModels } = await import("../proxy/accountModels")
const { resetCvpAccessCacheForTests } = await import("../proxy/cvpAccess")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { configPath } = await import("../configDir")
const { setSetting } = await import("../settings")

const PROFILES = [
  { id: "max", type: "oauth-token" as const, oauthToken: "token-max" },
  { id: "team", type: "oauth-token" as const, oauthToken: "token-team" },
  { id: "team2", type: "oauth-token" as const, oauthToken: "token-team2" },
]

const TEAM_MODELS = [
  { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { type: "model", id: "claude-mythos-5-2", display_name: "Claude Mythos 5.2", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
]

const DEFENSE = { message: "CVP: Defense Access", variant: "neutral" }
const TEAM_READING = [
  { id: "claude-opus-5-5", name: "Opus 5.5", badge: DEFENSE, selector_badge: { message: "CVP", variant: "neutral" } },
  { id: "claude-mythos-5-2", name: "Mythos 5.2", badge: DEFENSE },
  { id: "claude-fable-5-2", name: "Fable 5.2" },
]

const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  served = []
  refuseWith = undefined
  failTokens = new Set()
  rmSync(configPath("cvp-access.json"), { force: true })
  resetCvpAccessCacheForTests()
  clearAccountModels()
  await clearSessionCache()
  resetActiveProfile()
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("cvpProfileOrder", undefined)
  setSetting("cvpActiveProfile", undefined)
  setSetting("cvpManagedExcludedProfiles", undefined)
  __setFetchOAuthUsageOverride(async () => null)
  savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
  savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "max,team,team2"
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const url = String(args[0])
      if (!url.startsWith("https://api.anthropic.com/v1/models")) throw new Error(`unexpected network call in test: ${url}`)
      const authorization = new Headers(args[1]?.headers).get("authorization") ?? ""
      return Response.json({ data: authorization === "Bearer token-max" ? TEAM_MODELS.filter(m => !m.id.includes("mythos")) : TEAM_MODELS, has_more: false })
    },
    { preconnect: realFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setFetchOAuthUsageOverride(null)
  resetActiveProfile()
})

type TestApp = ReturnType<typeof createProxyServer>["app"]

function app(): TestApp {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "max" }).app
}

async function postReading(target: TestApp, profile: string, models: unknown, headers: Record<string, string> = {}) {
  return target.fetch(new Request(`http://localhost/profiles/${profile}/cvp-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ models }),
  }))
}

async function setActive(target: TestApp, profile: string) {
  const response = await target.fetch(new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  }))
  expect(response.status).toBe(200)
}

async function message(target: TestApp, headers: Record<string, string> = {}, model = "claude-opus-5-5", stream = false) {
  return target.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, max_tokens: 64, stream, messages: [{ role: "user", content: "triage this sample" }] }),
  }))
}

async function models(target: TestApp, headers: Record<string, string>) {
  const response = await target.fetch(new Request("http://localhost/v1/models", { headers }))
  const body = await response.json() as { data?: Array<Record<string, any>> }
  return { response, data: body.data ?? [] }
}

async function cvpAccessOf(target: TestApp, profile: string) {
  const body = await (await target.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Array<{ id: string; cvpAccess?: Array<Record<string, unknown>> }> }
  return body.profiles.find(p => p.id === profile)?.cvpAccess
}

describe("POST /profiles/:id/cvp-access", () => {
  it("stores the reading and lists it on /profiles/list", async () => {
    const server = app()
    const response = await postReading(server, "team", TEAM_READING)

    expect(response.status).toBe(200)
    const body = await response.json() as { profile: string; cvpAccess: Array<Record<string, unknown>> }
    expect(body.profile).toBe("team")
    expect(body.cvpAccess.filter(e => e.type === "active").map(e => e.model)).toEqual(["claude-mythos-5-2", "claude-opus-5-5"])
    expect(await cvpAccessOf(server, "team")).toContainEqual(expect.objectContaining({ model: "claude-opus-5-5", type: "active", tier: "c", source: "claude_ai" }))
    expect(await cvpAccessOf(server, "max")).toEqual([])
  })

  it("refuses a cross-origin page, an unknown profile and a malformed body", async () => {
    const server = app()

    expect((await postReading(server, "team", TEAM_READING, { Origin: "https://evil.example" })).status).toBe(403)
    expect((await postReading(server, "nobody", TEAM_READING)).status).toBe(400)
    expect((await postReading(server, "team", [])).status).toBe(400)
    expect((await postReading(server, "team", [{ name: "no id" }])).status).toBe(400)
    expect(await cvpAccessOf(server, "team")).toEqual([])
  })
})

describe("GET /v1/models and CVP", () => {
  it("annotates a pinned account's models and lists only CVP ones when required", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)

    const all = await models(server, { "x-meridian-profile": "team" })
    expect(all.data.find(m => m.id === "claude-opus-5-5")?.cyber_verification).toMatchObject({ type: "active", tier: "c", source: "claude_ai" })
    expect(all.data.find(m => m.id === "claude-fable-5-2")?.cyber_verification).toMatchObject({ type: "inactive" })

    const cvp = await models(server, { "x-meridian-profile": "team", "x-meridian-require": "cvp" })
    expect(cvp.data.map(m => m.id)).toEqual(["claude-opus-5-5", "claude-mythos-5-2"])
  })

  it("lists unpinned the CVP models of every reachable account, with who holds them", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)
    await postReading(server, "team2", [{ id: "claude-opus-5-5", badge: DEFENSE }])

    const cvp = await models(server, { "x-meridian-require": "cvp" })

    expect(cvp.response.status).toBe(200)
    expect(cvp.data.map(m => [m.id, m.cvp_profiles])).toEqual([
      ["claude-opus-5-5", ["team", "team2"]],
      ["claude-mythos-5-2", ["team"]],
    ])
    expect(cvp.data[1]).toMatchObject({ display_name: "Claude Mythos 5.2", context_window: 1_000_000, cyber_verification: { type: "active", tier: "c" } })
  })

  it("leaves out accounts unpinned work cannot reach", async () => {
    setSetting("routingExcludedProfiles", ["team"])
    const server = app()
    await postReading(server, "team", TEAM_READING)

    expect((await models(server, { "x-meridian-require": "cvp" })).data).toEqual([])
  })

  it("refuses an unknown requirement", async () => {
    expect((await models(app(), { "x-meridian-require": "cvp,zdr" })).response.status).toBe(400)
  })
})

describe("x-meridian-require: cvp on /v1/messages", () => {
  it("passes over an active profile without CVP for the first in priority order with it", async () => {
    const server = app()
    await postReading(server, "team2", [{ id: "claude-opus-5-5", badge: DEFENSE }])
    await setActive(server, "max")

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    expect(served).toEqual(["token-team2", "token-max"])
  })

  it("matches the requested model, not its family", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)

    const response = await message(server, { "x-meridian-require": "cvp" }, "claude-fable-5-2")

    expect(response.status).toBe(429)
    const body = await response.json() as { error: { code: string; message: string; profiles: Array<{ id: string; reason: string; resets_at: string | null }> } }
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.message).toContain("no eligible profile holds CVP access on claude-fable-5-2")
    expect(body.error.profiles).toEqual([
      { id: "max", reason: "no_cvp", resets_at: null },
      { id: "team", reason: "no_cvp", resets_at: null },
      { id: "team2", reason: "no_cvp", resets_at: null },
    ])
    expect(served).toEqual([])
  })

  it("steers active routing too", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    const server = app()
    await postReading(server, "team", TEAM_READING)

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect(served).toEqual(["token-team"])
  })

  it("refuses unsent under active routing when nobody holds it", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    const response = await message(app(), { "x-meridian-require": "cvp" })

    expect(response.status).toBe(429)
    expect(served).toEqual([])
  })

  it("lets a pin win", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)

    expect((await message(server, { "x-meridian-require": "cvp", "x-meridian-profile": "max" })).status).toBe(200)
    expect(served).toEqual(["token-max"])
  })

  it("sends a pin with the requirement to the pinned holder, even past the cvp pointer", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)
    await postReading(server, "team2", TEAM_READING)

    expect((await message(server, { "x-meridian-require": "cvp", "x-meridian-profile": "team2" })).status).toBe(200)
    expect(served).toEqual(["token-team2"])
  })

  it("refuses a pin with the requirement, unsent, when the pinned profile's map says it lacks CVP on the model", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)

    const response = await message(server, { "x-meridian-require": "cvp", "x-meridian-profile": "team" }, "claude-fable-5-2")
    expect(response.status).toBe(403)
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("profile_no_cvp")
    expect(body.error.message).toBe('Profile "team" holds no CVP access on claude-fable-5-2')
    expect(served).toEqual([])
  })

  it("refuses an unknown requirement", async () => {
    const response = await message(app(), { "x-meridian-require": "zdr" })
    expect(response.status).toBe(400)
    expect(served).toEqual([])
  })
})

describe("refusals teach the map", () => {
  it("records stop_details.cyber_verification for the account that refused", async () => {
    const server = app()
    refuseWith = { type: "inactive", reason: "organization_not_approved" }

    await message(server, { "x-meridian-profile": "max" })

    expect(await cvpAccessOf(server, "max")).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", type: "inactive", reason: "organization_not_approved", source: "observed" }),
    ])
  })

  it("learns from a streamed refusal too", async () => {
    const server = app()
    refuseWith = { type: "active", tier: "b" }

    await (await message(server, { "x-meridian-profile": "team" }, "claude-opus-5-5", true)).text()

    expect(await cvpAccessOf(server, "team")).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", type: "active", tier: "b", source: "observed" }),
    ])
  })

  it("routes to an account a refusal showed holds access", async () => {
    const server = app()
    refuseWith = { type: "active", tier: "c" }
    await message(server, { "x-meridian-profile": "team" })
    refuseWith = undefined
    served = []

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect(served).toEqual(["token-team"])
  })
})

const OPUS_ONLY = [{ id: "claude-opus-5-5", badge: DEFENSE }]

async function putRouting(target: TestApp, body: Record<string, unknown>) {
  return target.fetch(new Request("http://localhost/settings/api/routing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

interface CvpRoutingSettings {
  capabilities: string[]
  profileOrder: string[]
  cvpProfileOrder: string[]
  cvpEffectiveProfileOrder: string[]
  cvpActiveProfile: string | null
  cvpManagedExcludedProfiles: string[]
  cvpHolders: Record<string, string[]>
}

async function routingSettings(target: TestApp): Promise<CvpRoutingSettings> {
  const response = await target.fetch(new Request("http://localhost/settings/api/routing"))
  expect(response.status).toBe(200)
  return await response.json() as CvpRoutingSettings
}

describe("the cvp order and active pointer", () => {
  it("orders cvp work by cvpProfileOrder while unflagged work keeps profileOrder", async () => {
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    await setActive(server, "max")
    expect((await putRouting(server, { cvpProfileOrder: ["team2", "team", "max"] })).status).toBe(200)

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    expect(served).toEqual(["token-team2", "token-max"])
  })

  it("falls back to profileOrder when cvpProfileOrder is empty", async () => {
    setSetting("cvpProfileOrder", [])
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect(served).toEqual(["token-team"])
  })

  it("leads with cvpActiveProfile, not the general active profile", async () => {
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    await setActive(server, "team")
    expect((await putRouting(server, { cvpActiveProfile: "team2" })).status).toBe(200)

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    expect(served).toEqual(["token-team2", "token-team"])
  })

  it("never lets the general active profile lead cvp work", async () => {
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    await setActive(server, "team2")

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect(served).toEqual(["token-team"])
  })

  it("passes over a cvpActiveProfile without access on the requested model", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)
    await postReading(server, "team2", OPUS_ONLY)
    setSetting("cvpActiveProfile", "team2")

    expect((await message(server, { "x-meridian-require": "cvp" }, "claude-mythos-5-2")).status).toBe(200)
    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)

    expect(served).toEqual(["token-team", "token-team2"])
  })

  it("fails over only within the profiles holding access", async () => {
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    setSetting("cvpActiveProfile", "team2")
    failTokens = new Set(["token-team2"])

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    // A profile may be retried before failover; the order of accounts is what counts.
    expect([...new Set(served)]).toEqual(["token-team2", "token-team"])
  })

  it("steers active routing by the cvp order and pointer too", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    setSetting("cvpProfileOrder", ["team2", "team"])

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    setSetting("cvpActiveProfile", "team")
    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    expect(served).toEqual(["token-team2", "token-team", "token-max"])
  })
})

describe("cvpManagedExcludedProfiles", () => {
  it("keeps cvp work on an account the general managed list excludes", async () => {
    setSetting("routingManagedExcludedProfiles", ["team"])
    const server = app()
    await postReading(server, "team", OPUS_ONLY)

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect((await models(server, { "x-meridian-require": "cvp" })).data.map(m => [m.id, m.cvp_profiles])).toEqual([["claude-opus-5-5", ["team"]]])
    expect(served).toEqual(["token-team"])
  })

  it("takes accounts out of cvp work only, leaving unflagged work alone", async () => {
    setSetting("cvpManagedExcludedProfiles", ["team", "max"])
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    setSetting("cvpActiveProfile", "team")

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect((await message(server)).status).toBe(200)
    expect((await models(server, { "x-meridian-require": "cvp" })).data.map(m => [m.id, m.cvp_profiles])).toEqual([["claude-opus-5-5", ["team2"]]])

    expect(served).toEqual(["token-team2", "token-max"])
  })

  it("refuses unsent with no_cvp when it leaves no account holding access", async () => {
    setSetting("cvpManagedExcludedProfiles", ["team"])
    const server = app()
    await postReading(server, "team", OPUS_ONLY)

    const response = await message(server, { "x-meridian-require": "cvp" })

    expect(response.status).toBe(429)
    const body = await response.json() as { error: { code: string; profiles: Array<{ id: string; reason: string }> } }
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.profiles.map(p => [p.id, p.reason])).toEqual([["max", "no_cvp"], ["team", "excluded"], ["team2", "no_cvp"]])
    expect(served).toEqual([])
  })

  it("still yields to the user's own exclusions", async () => {
    setSetting("routingExcludedProfiles", ["team"])
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    await postReading(server, "team2", OPUS_ONLY)
    setSetting("cvpActiveProfile", "team")

    expect((await message(server, { "x-meridian-require": "cvp" })).status).toBe(200)
    expect(served).toEqual(["token-team2"])
  })
})

describe("telemetry", () => {
  it("records the parsed requirement as routingRequire, and nothing without the header", async () => {
    const server = app()
    await postReading(server, "team", OPUS_ONLY)
    const since = Date.now()

    expect((await message(server, { "x-meridian-require": " CVP " })).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    const rows = await (await server.fetch(new Request(`http://localhost/telemetry/requests?limit=10&since=${since}`))).json() as Array<{ profileId?: string; routingRequire?: string[] }>
    expect(rows.map(row => [row.profileId, row.routingRequire])).toEqual([["max", undefined], ["team", ["cvp"]]])
  })
})

describe("GET/PUT /settings/api/routing", () => {
  it("advertises cvp-routing and cvp-order beside the existing capabilities", async () => {
    const body = await routingSettings(app())
    expect(body.capabilities).toEqual(expect.arrayContaining(["managed-exclusion-no-routable", "profile-model-list", "pin-bypasses-managed-exclusion", "cvp-routing", "cvp-order"]))
  })

  it("reports nothing saved as empty, with the effective order falling back to profileOrder", async () => {
    const body = await routingSettings(app())
    expect(body.cvpProfileOrder).toEqual([])
    expect(body.cvpEffectiveProfileOrder).toEqual(["max", "team", "team2"])
    expect(body.cvpActiveProfile).toBeNull()
    expect(body.cvpManagedExcludedProfiles).toEqual([])
    expect(body.cvpHolders).toEqual({})
  })

  it("saves and reports the cvp order, pointer, managed list and per-model holders", async () => {
    const server = app()
    await postReading(server, "team", TEAM_READING)
    await postReading(server, "team2", OPUS_ONLY)

    const put = await putRouting(server, { cvpProfileOrder: ["team2", "team"], cvpActiveProfile: "team", cvpManagedExcludedProfiles: ["max", "max"] })
    expect(put.status).toBe(200)

    const body = await routingSettings(server)
    expect(body.cvpProfileOrder).toEqual(["team2", "team"])
    expect(body.cvpEffectiveProfileOrder).toEqual(["team2", "team", "max"])
    expect(body.cvpActiveProfile).toBe("team")
    expect(body.cvpManagedExcludedProfiles).toEqual(["max"])
    expect(body.cvpHolders).toEqual({ "claude-opus-5-5": ["team2", "team"], "claude-mythos-5-2": ["team"] })
    expect(body.profileOrder).toEqual(["max", "team", "team2"])

    expect((await putRouting(server, { cvpActiveProfile: null, cvpProfileOrder: [] })).status).toBe(200)
    const cleared = await routingSettings(server)
    expect(cleared.cvpActiveProfile).toBeNull()
    expect(cleared.cvpProfileOrder).toEqual([])
    expect(cleared.cvpManagedExcludedProfiles).toEqual(["max"])
  })

  it("refuses unknown or malformed cvp fields without writing any of them", async () => {
    const server = app()
    expect((await putRouting(server, { cvpProfileOrder: ["team", "nobody"] })).status).toBe(400)
    expect((await putRouting(server, { cvpProfileOrder: "team" })).status).toBe(400)
    expect((await putRouting(server, { cvpActiveProfile: "nobody" })).status).toBe(400)
    expect((await putRouting(server, { cvpActiveProfile: 3 })).status).toBe(400)
    expect((await putRouting(server, { cvpManagedExcludedProfiles: [1] })).status).toBe(400)
    expect((await putRouting(server, { cvpActiveProfile: "team", cvpProfileOrder: ["nobody"] })).status).toBe(400)

    const body = await routingSettings(server)
    expect(body.cvpActiveProfile).toBeNull()
    expect(body.cvpProfileOrder).toEqual([])
  })
})
