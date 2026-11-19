/**
 * POST /profiles/active against a profile something keeps out of work: the
 * refusal says why and who, and with "Allow forcing a forbidden profile" on,
 * `force: true` activates it anyway and keeps it active until released.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage, withMockSdkSessionId } from "./helpers"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { installModelsMock } from "./modelsMock"

let queryTokens: Array<string | undefined> = []

installSdkMock(() => ({
  query: (params: { prompt: unknown; options?: { env?: Record<string, string> } }) => {
    queryTokens.push(params.options?.env?.CLAUDE_CODE_OAUTH_TOKEN)
    return (async function* () {
      yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "profile-force-activation.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_context: unknown, run: () => unknown) => run(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

installModelsMock(() => ({
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
}))

const designDir = mkdtempSync(join(tmpdir(), "meridian-force-activation-"))
process.env.MERIDIAN_DESIGN_TOKEN_PATH = join(designDir, "missing-token.json")

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { getActiveProfileId, resetActiveProfile, setActiveProfile } = await import("../proxy/profiles")
const { resetFollowActive } = await import("../proxy/followActive")
const { setSetting } = await import("../settings")

const PROFILES = [
  { id: "own", type: "oauth-token" as const, oauthToken: "token-own" },
  { id: "loaner-bob", type: "oauth-token" as const, oauthToken: "token-loaner" },
]

type Refusal = {
  kind: string
  profile: string
  by: string
  reason: string
  forceable: boolean
  forceAllowed: boolean
  forced?: { profile: string; until: number }
}
type ActivationReply = {
  success?: boolean
  activeProfile?: string
  code?: string
  error?: unknown
  refusal?: Refusal
  forced?: { profile: string; forcedAt: number; until: number } | null
}

function app() {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "own" }).app
}

async function activate(target: ReturnType<typeof app>, body: Record<string, unknown>): Promise<{ status: number; body: ActivationReply }> {
  const res = await target.fetch(new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
  return { status: res.status, body: await res.json() as ActivationReply }
}

async function putRouting(target: ReturnType<typeof app>, body: Record<string, unknown>): Promise<number> {
  const res = await target.fetch(new Request("http://localhost/settings/api/routing", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
  return res.status
}

async function routing(target: ReturnType<typeof app>): Promise<Record<string, unknown>> {
  return await (await target.fetch(new Request("http://localhost/settings/api/routing"))).json() as Record<string, unknown>
}

function resetSettings(): void {
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("routingHeldProfiles", [])
  setSetting("routingManagedReasons", undefined)
  setSetting("allowForcingForbiddenProfile", undefined)
  setSetting("forcedActiveProfile", undefined)
  setSetting("routing", "active")
  setSetting("profileOrder", [])
}

beforeEach(async () => {
  queryTokens = []
  await clearSessionCache()
  resetActiveProfile()
  resetFollowActive()
  resetSettings()
  setActiveProfile("own")
})

afterEach(() => {
  resetSettings()
  resetActiveProfile()
})

afterAll(() => {
  delete process.env.MERIDIAN_DESIGN_TOKEN_PATH
  rmSync(designDir, { recursive: true, force: true })
})

describe("activating a forbidden profile", () => {
  it("says who excluded it and why, in words, keeping the old error type", async () => {
    setSetting("routingManagedExcludedProfiles", ["loaner-bob"])
    setSetting("routingManagedReasons", { "loaner-bob": "Vibeterm fleet policy: loaner outside its harvest window" })
    const reply = await activate(app(), { profile: "loaner-bob" })

    expect(reply.status).toBe(409)
    expect(reply.body.error).toMatchObject({ type: "profile_excluded" })
    expect(reply.body.refusal).toMatchObject({
      kind: "managed_excluded",
      profile: "loaner-bob",
      reason: "Vibeterm fleet policy: loaner outside its harvest window",
      forceable: true,
      forceAllowed: false,
    })
    expect(getActiveProfileId()).toBe("own")
  })

  it("refuses force while the setting is off", async () => {
    setSetting("routingManagedExcludedProfiles", ["loaner-bob"])
    const reply = await activate(app(), { profile: "loaner-bob", force: true })

    expect(reply.status).toBe(409)
    expect(reply.body.code).toBe("force_disabled")
    expect(reply.body.refusal?.forceAllowed).toBe(false)
    expect(getActiveProfileId()).toBe("own")
  })

  it("never forces past the user's own exclusion", async () => {
    setSetting("routingExcludedProfiles", ["loaner-bob"])
    setSetting("allowForcingForbiddenProfile", true)
    const reply = await activate(app(), { profile: "loaner-bob", force: true })

    expect(reply.status).toBe(409)
    expect(reply.body.refusal).toMatchObject({ kind: "excluded", forceable: false })
    expect(getActiveProfileId()).toBe("own")
  })

  it("saves the setting through the routing API, off by default", async () => {
    const target = app()
    expect((await routing(target)).allowForcingForbiddenProfile).toBe(false)
    expect(await putRouting(target, { allowForcingForbiddenProfile: "yes" })).toBe(400)
    expect(await putRouting(target, { allowForcingForbiddenProfile: true })).toBe(200)
    expect((await routing(target)).allowForcingForbiddenProfile).toBe(true)
  })

  it("forces it when allowed, and the force outlasts the supervisor's next write", async () => {
    setSetting("routingManagedExcludedProfiles", ["loaner-bob"])
    setSetting("allowForcingForbiddenProfile", true)
    const target = app()
    const reply = await activate(target, { profile: "loaner-bob", force: true })

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ success: true, activeProfile: "loaner-bob", forced: { profile: "loaner-bob" } })
    expect(getActiveProfileId()).toBe("loaner-bob")

    // The supervisor's tick rewrites its list naming the account again.
    expect(await putRouting(target, { routingManagedExcludedProfiles: ["loaner-bob"] })).toBe(200)
    expect(getActiveProfileId()).toBe("loaner-bob")

    const settings = await routing(target)
    expect(settings.routingManagedExcludedProfiles).toEqual(["loaner-bob"])
    expect(settings.forcedActiveProfile).toMatchObject({ profile: "loaner-bob" })
    expect(settings.capabilities).toContain("forced-active-profile")

    // Unpinned work goes to the forced account.
    const res = await target.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, stream: false, messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(res.status).toBe(200)
    expect(queryTokens).toEqual(["token-loaner"])

    const listed = await (await target.fetch(new Request("http://localhost/profiles/list"))).json() as {
      forcedActiveProfile: { profile: string } | null
      profiles: Array<{ id: string; forced: { until: number } | null }>
    }
    expect(listed.forcedActiveProfile).toMatchObject({ profile: "loaner-bob" })
    expect(listed.profiles.find(p => p.id === "loaner-bob")?.forced).not.toBeNull()
    expect(listed.profiles.find(p => p.id === "own")?.forced).toBeNull()
  })

  it("refuses a switch away from a forced profile unless the force is released with it", async () => {
    setSetting("routingManagedExcludedProfiles", ["loaner-bob"])
    setSetting("allowForcingForbiddenProfile", true)
    const target = app()
    expect((await activate(target, { profile: "loaner-bob", force: true })).status).toBe(200)

    const refused = await activate(target, { profile: "own" })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe("profile_forced")
    expect(refused.body.refusal).toMatchObject({ kind: "forced_elsewhere", forced: { profile: "loaner-bob" } })
    expect(getActiveProfileId()).toBe("loaner-bob")

    const released = await activate(target, { profile: "own", releaseForce: true })
    expect(released.status).toBe(200)
    expect(getActiveProfileId()).toBe("own")
    expect((await routing(target)).forcedActiveProfile).toBeNull()
  })

  it("release puts the ordinary rules back at once", async () => {
    setSetting("routingManagedExcludedProfiles", ["loaner-bob"])
    setSetting("allowForcingForbiddenProfile", true)
    const target = app()
    expect((await activate(target, { profile: "loaner-bob", force: true })).status).toBe(200)

    const res = await target.fetch(new Request("http://localhost/profiles/forced/release", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(getActiveProfileId()).toBe("own")
  })

  it("an expired force no longer holds anything", async () => {
    setSetting("forcedActiveProfile", { profile: "loaner-bob", forcedAt: 1, until: 2 })
    setActiveProfile("loaner-bob")
    const reply = await activate(app(), { profile: "own" })
    expect(reply.status).toBe(200)
    expect(getActiveProfileId()).toBe("own")
  })
})
