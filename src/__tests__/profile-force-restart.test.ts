import { it } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const routingStatus = z.object({
  forcedActiveProfile: z.object({ profile: z.string(), forcedAt: z.number(), until: z.number() }).nullable(),
})
const profileHealth = z.object({ activeProfile: z.string() })
const switchResult = z.object({ code: z.string().optional() })

const phase = process.argv[2]
if (phase === "seed-force" || phase === "check-force" || phase === "check-mismatched-force") {
  const { assertSyntheticClaudeBoundary, setSdkMock } = await import("./sdkMock")
  setSdkMock(() => ({ query: () => assert.fail("Profile restart must not query Claude") }))
  await assertSyntheticClaudeBoundary()
  let outboundRequests = 0
  globalThis.fetch = Object.assign(() => {
    outboundRequests += 1
    return assert.fail("Profile restart must not contact an upstream")
  }, { preconnect: globalThis.fetch.preconnect })

  const { runCli } = await import("../../bin/cli")
  const { createProxyServer } = await import("../proxy/server")
  const { loadSettings, saveSettings } = await import("../settings")
  const mismatched = phase === "check-mismatched-force"
  if (mismatched) {
    saveSettings({ activeProfile: "own", routingExcludedProfiles: ["own"], routingManagedExcludedProfiles: [] })
  }
  const beforeStartup = loadSettings()
  await runCli(async config => {
    const proxy = createProxyServer({ ...config, silent: true })
    const request = (path: string, method = "GET", body?: object) => proxy.app.fetch(new Request(
      new URL(path, "http://127.0.0.1").href, {
        method,
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify(body),
      },
    ))
    try {
      if (phase === "seed-force") {
        const settings = await request("/settings/api/routing", "PUT", {
          allowForcingForbiddenProfile: true,
          routingManagedExcludedProfiles: ["loaner"],
        })
        assert.equal(settings.status, 200)
        const activated = await request("/profiles/active", "POST", { profile: "loaner", force: true })
        assert.equal(activated.status, 200)
        const saved = loadSettings()
        assert.equal(saved.activeProfile, "loaner")
        assert.ok(saved.forcedActiveProfile && saved.forcedActiveProfile.until > Date.now())
        assert.equal(saved.forcedActiveProfile.profile, "loaner")
        assert.deepEqual(await activated.json(), { success: true, activeProfile: "loaner", forced: saved.forcedActiveProfile })
      } else {
        const { activeProfile, allowForcingForbiddenProfile, forcedActiveProfile } = beforeStartup
        assert.equal(activeProfile, mismatched ? "own" : "loaner")
        assert.equal(allowForcingForbiddenProfile, true)
        assert.ok(forcedActiveProfile && forcedActiveProfile.until > Date.now())
        assert.equal(forcedActiveProfile.profile, "loaner")
        const routing = await request("/settings/api/routing")
        const health = await request("/profiles/health")
        assert.equal(routing.status, 200)
        assert.equal(health.status, 200)
        const routingBody = routingStatus.parse(await routing.json())
        const healthBody = profileHealth.parse(await health.json())
        assert.equal(healthBody.activeProfile, "loaner")
        if (mismatched) {
          assert.equal(routingBody.forcedActiveProfile, null, "Ordinary startup failover must not revive a force whose saved active profile did not match")
        } else {
          assert.deepEqual(loadSettings(), beforeStartup, "Startup must not rewrite the saved force or active profile")
          const switchAway = await request("/profiles/active", "POST", { profile: "own" })
          const switchBody = switchResult.parse(await switchAway.json())
          assert.deepEqual({
            liveForce: routingBody.forcedActiveProfile,
            status: switchAway.status,
            code: switchBody.code,
          }, {
            liveForce: forcedActiveProfile,
            status: 409,
            code: "profile_forced",
          }, "A fresh env-configured CLI must restore and enforce the saved force")
        }
      }
    } finally {
      await proxy.closeBackend?.()
    }
    assert.equal(outboundRequests, 0)
    return { server: createServer(), config: proxy.config, close: async () => {} }
  })
} else {
  it.each([
    ["restores an unexpired force and blocks switching away", "check-force"],
    ["does not revive a mismatched force through ordinary startup failover", "check-mismatched-force"],
  ] as const)("env-configured CLI restart %s", (_description, checkPhase) => {
    const root = mkdtempSync(join(tmpdir(), "meridian-profile-force-restart-"))
    try {
      const home = join(root, "home")
      mkdirSync(home)
      const env = {
        HOME: home,
        USERPROFILE: home,
        MERIDIAN_CONFIG_DIR: join(root, "config"),
        MERIDIAN_SESSION_DIR: join(root, "sessions"),
        MERIDIAN_DEFAULT_PROFILE: "own",
        MERIDIAN_PROFILES: JSON.stringify(["own", "loaner"].map(id => ({ id, oauthToken: `not-a-credential-${id}` }))),
        MERIDIAN_NO_UPDATE_CHECK: "1",
        MERIDIAN_TELEMETRY_PERSIST: "0",
        MERIDIAN_CREDENTIALS_READONLY: "1",
      }
      for (const step of ["seed-force", checkPhase]) {
        const child = spawnSync(process.execPath, ["--no-env-file", fileURLToPath(import.meta.url), step], {
          cwd: root, env, encoding: "utf8", timeout: 10_000,
        })
        assert.ifError(child.error)
        assert.equal(child.status, 0, `${step} failed:\n${child.stdout}${child.stderr}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
}
