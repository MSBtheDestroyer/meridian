/**
 * POST /profiles/:id/refresh: the card's Refresh re-reads everything Meridian
 * can about a profile (its login, usage and model list), says per part what
 * happened, gives each part its own budget, and says CVP access is learned
 * from claude.ai rather than read here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { FetchOAuthUsageOpts, OAuthUsageSnapshot } from "../proxy/oauthUsage"
import type { ClaudeAuthStatus } from "../proxy/models"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { installModelsMock } from "./modelsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "profile-refresh-route.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

let authAnswer: ClaudeAuthStatus = { loggedIn: true, email: "a@example.com", subscriptionType: "max" }
let rechecks: Array<string | undefined> = []
installModelsMock(() => ({
  getClaudeAuthStatusAsync: async () => authAnswer,
  recheckClaudeAuthStatus: async (profileId?: string) => { rechecks.push(profileId); return authAnswer },
}))

const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { createProxyServer } = await import("../proxy/server")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { resetActiveProfile } = await import("../proxy/profiles")
const { clearAccountModels } = await import("../proxy/accountModels")
const { forgetCvpAccess } = await import("../proxy/cvpAccess")

let usageCalls: FetchOAuthUsageOpts[] = []
let modelCalls: string[] = []
const realFetch = globalThis.fetch

function snapshot(): OAuthUsageSnapshot {
  return { windows: [{ type: "five_hour", utilization: 0.1, resetsAt: null }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
}

function app() {
  return createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [
      { id: "work", claudeConfigDir: "/tmp/meridian-refresh-all-work" },
      { id: "token", type: "oauth-token", oauthToken: "token-x" },
      { id: "keyed", type: "api", apiKey: "sk-test" },
    ],
    defaultProfile: "work",
  }).app
}

type Part = { state: string; note: string; retryAfterMs?: number }
type Body = { profile: string; parts: Partial<Record<"login" | "usage" | "models" | "cvp", Part>> }

function post(target: ReturnType<typeof app>, path: string, origin?: string) {
  return target.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: origin ? { origin } : {} }))
}

async function refresh(target: ReturnType<typeof app>, id: string): Promise<Body> {
  const res = await post(target, `/profiles/${id}/refresh`)
  expect(res.status).toBe(200)
  return await res.json() as Body
}

beforeEach(() => {
  authAnswer = { loggedIn: true, email: "a@example.com", subscriptionType: "max" }
  rechecks = []
  usageCalls = []
  modelCalls = []
  rateLimitStore.clear()
  resetActiveProfile()
  resetOAuthUsageCache()
  clearAccountModels()
  forgetCvpAccess("work")
  __setFetchOAuthUsageOverride(async opts => {
    usageCalls.push(opts ?? {})
    return snapshot()
  })
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const url = String(args[0])
      if (!url.startsWith("https://api.anthropic.com/v1/models")) throw new Error(`unexpected network call in test: ${url}`)
      modelCalls.push(new Headers(args[1]?.headers).get("authorization") ?? "")
      return Response.json({ data: [{ type: "model", id: "claude-sonnet-4-6" }, { type: "model", id: "claude-mythos-5-2" }], has_more: false })
    },
    { preconnect: realFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
  __setFetchOAuthUsageOverride(null)
  resetOAuthUsageCache()
  rateLimitStore.clear()
})

describe("POST /profiles/:id/refresh", () => {
  it("re-checks the login, re-reads usage, and says CVP is learned from claude.ai", async () => {
    const body = await refresh(app(), "work")

    expect(body.profile).toBe("work")
    expect(body.parts.login).toMatchObject({ state: "fresh" })
    expect(body.parts.login!.note).toContain("a@example.com")
    expect(body.parts.usage).toMatchObject({ state: "fresh" })
    expect(body.parts.models?.state).toBeDefined()
    expect(body.parts.cvp).toMatchObject({ state: "unavailable" })
    expect(rechecks).toEqual(["work"])
    expect(usageCalls).toHaveLength(1)
    expect(usageCalls[0]).toMatchObject({ profileId: "work", claudeConfigDir: "/tmp/meridian-refresh-all-work", force: true })
  })

  it("re-lists the account's models past their cache", async () => {
    const target = app()
    await target.fetch(new Request("http://localhost/v1/models", { headers: { "x-meridian-profile": "token" } }))
    expect(modelCalls).toEqual(["Bearer token-x"])

    const body = await refresh(target, "token")

    expect(body.parts.models).toEqual({ state: "fresh", note: "Listed 2 models for this account." })
    expect(modelCalls).toEqual(["Bearer token-x", "Bearer token-x"])
    expect(body.parts.usage?.state).toBe("unavailable")
  })

  it("gives each part its own budget, the usage part sharing its slot with /usage/refresh", async () => {
    const target = app()
    expect((await post(target, "/profiles/work/usage/refresh")).status).toBe(200)

    const first = await refresh(target, "work")
    expect(first.parts.usage?.state).toBe("rate_limited")
    expect(first.parts.usage?.retryAfterMs).toBeGreaterThan(0)
    expect(first.parts.login?.state).toBe("fresh")

    const second = await refresh(target, "work")
    expect(second.parts.login?.state).toBe("rate_limited")
    expect(second.parts.models?.state).toBe("rate_limited")
    expect(usageCalls).toHaveLength(1)
    expect(rechecks).toHaveLength(1)
  })

  it("skips usage and models when the login is gone", async () => {
    authAnswer = { loggedIn: false }

    const body = await refresh(app(), "work")

    expect(body.parts.login?.state).toBe("failed")
    expect(body.parts.usage?.state).toBe("skipped")
    expect(body.parts.models?.state).toBe("skipped")
    expect(usageCalls).toHaveLength(0)
  })

  it("names the age of the last claude.ai CVP reading", async () => {
    const target = app()
    const seeded = await post(target, "/profiles/work/cvp-access")
    expect(seeded.status).toBe(400)
    await target.fetch(new Request("http://localhost/profiles/work/cvp-access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [{ id: "claude-opus-4-7", badge: { message: "CVP: Defense Access" } }] }),
    }))

    const body = await refresh(target, "work")

    expect(body.parts.cvp?.state).toBe("unavailable")
    expect(body.parts.cvp?.note).toContain("just now")
  })

  it("has no login or usage to re-read for an API-key profile", async () => {
    const body = await refresh(app(), "keyed")

    expect(body.parts.login?.state).toBe("unavailable")
    expect(body.parts.usage?.state).toBe("unavailable")
    expect(rechecks).toHaveLength(0)
    expect(usageCalls).toHaveLength(0)
  })

  it("refuses an unknown profile and another site", async () => {
    const target = app()
    expect((await post(target, "/profiles/nobody/refresh")).status).toBe(404)
    expect((await post(target, "/profiles/work/refresh", "https://evil.example")).status).toBe(403)
    expect(rechecks).toHaveLength(0)
  })

  it("advertises the refresh on GET /settings/api/routing", async () => {
    const body = await (await app().fetch(new Request("http://localhost/settings/api/routing"))).json() as { capabilities?: string[] }
    expect(body.capabilities).toContain("profile-refresh")
  })
})
