/**
 * The proxy's session GC, at its default settings, can retire as many
 * transcripts as turns create, and a draining proxy claims no new deletion.
 *
 * A retired transcript waits out the grace (the session turn's hold and a
 * minute) before it can be deleted, and a fixed 256 could wait. Live,
 * 2026-10-09, parallel runs created 1,100-1,700 transcripts an hour; orphaned
 * transcripts stayed live until they filled the ownership ceiling, and every
 * request that needed a new one was refused 503 `session transcript ownership
 * capacity is full`.
 *
 * This fork's lifecycle store differs from upstream's (#1399) in two ways
 * pinned here: a sweep keeps claiming batches of eight while deletions are
 * due (up to five minutes), and once the drain starts it claims nothing more,
 * so close() joins only the batch already running (65ca1cfc).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-session-gc-capacity.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, startProxyServer } = await import("../proxy/server")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const lifecycle = await import("../proxy/sessionLifecycle")
const { registerLiveTranscript, readSessionGcSnapshot } = lifecycle

const GC_SETTINGS = [
  "MERIDIAN_SESSION_GC_MAX_PENDING", "MERIDIAN_SESSION_GC_MAX_DELETES", "MERIDIAN_SESSION_GC_GRACE_MS",
  "MERIDIAN_SESSION_GC_INTERVAL_MS", "MERIDIAN_WORKDIR", "MERIDIAN_CONFIG_DIR",
]
let root: string
const savedEnv: Record<string, string | undefined> = {}

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function resourceStates(): string[] {
  return Object.values(readSessionGcSnapshot(join(root, "sessions")).resources).map(resource => resource.state)
}

async function seedRetiredTranscripts(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await registerLiveTranscript({ sessionId: crypto.randomUUID(), configDir: join(root, "profile") })
  }
  // The proxy's clock sees these retirements as eligible without sleeping out
  // its production grace. All claims and settlements still use the real store.
  await lifecycle.reconcile([], { now: () => 0, retiredGraceMs: 0 })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-gc-capacity-")))
  for (const key of GC_SETTINGS) savedEnv[key] = process.env[key]
  // The test preload raises the backlog for the whole run; this file is
  // about the default.
  for (const key of GC_SETTINGS) delete process.env[key]
  Object.assign(process.env, { MERIDIAN_WORKDIR: root, MERIDIAN_CONFIG_DIR: join(root, "config") })
  setSessionStoreDir(join(root, "sessions"))
  mkdirSync(join(root, "profile"))
})

afterEach(() => {
  setSessionStoreDir(null)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("session GC capacity", () => {
  for (const [label, draining, configuredCap, expected] of [
    ["the default cap", false, undefined, 70],
    ["a lower configured cap", false, "8", 70],
    ["a draining proxy", true, undefined, 0],
  ] as const) {
    it(`deletes every due transcript in one sweep with ${label}, and none once draining`, async () => {
      if (configuredCap) process.env.MERIDIAN_SESSION_GC_MAX_DELETES = configuredCap
      await seedRetiredTranscripts(70)
      const runGc = lifecycle.runGc
      let deletions = 0
      const spy = spyOn(lifecycle, "runGc").mockImplementation((pins, options) => runGc(pins, {
        ...options,
        deleter: async () => { deletions++ },
      }))
      try {
        const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
        if (draining) proxy.beginDrain?.()
        const sweep = proxy.sweepSessionGc?.()
        expect(proxy.sweepSessionGc?.()).toBe(sweep)
        await sweep
        expect(deletions).toBe(expected)
        expect(resourceStates().filter(state => state === "deleted")).toHaveLength(expected)
        expect(resourceStates()).not.toContain("deleting")
      } finally {
        spy.mockRestore()
      }
    }, 60_000)
  }

  for (const pauseAt of [1, 25]) {
    it(`close() joins the batch holding deletion ${pauseAt} and claims no further one`, async () => {
      process.env.MERIDIAN_SESSION_GC_INTERVAL_MS = "0"
      const started = gate()
      const release = gate()
      const runGc = lifecycle.runGc
      let deletions = 0
      let closeSettled = false
      const spy = spyOn(lifecycle, "runGc").mockImplementation((pins, options) => runGc(pins, {
        ...options,
        deleter: async () => {
          if (++deletions === pauseAt) {
            started.release()
            await release.promise
          }
        },
      }))
      let instance: Awaited<ReturnType<typeof startProxyServer>> | undefined
      try {
        await seedRetiredTranscripts(70)
        instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
        await started.promise
        const closing = instance.close().then(() => { closeSettled = true })
        // close must await the active deletion, even with no HTTP requests.
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(closeSettled).toBe(false)
        expect(resourceStates()).toContain("deleting")
        release.release()
        await closing
        // Only the batch of eight that held the paused deletion ran to its end.
        const batchEnd = Math.ceil(pauseAt / 8) * 8
        expect(deletions).toBe(batchEnd)
        expect(resourceStates().filter(state => state === "deleted")).toHaveLength(batchEnd)
        expect(resourceStates()).not.toContain("deleting")
      } finally {
        release.release()
        try { await instance?.close() }
        finally { spy.mockRestore() }
      }
    }, 60_000)
  }

  it("retires every orphaned transcript in one sweep, past the 256 the backlog used to hold", async () => {
    const configDir = join(root, "profile")
    for (let i = 0; i < 300; i++) {
      await registerLiveTranscript({ sessionId: crypto.randomUUID(), configDir })
    }
    const proxy = createProxyServer({
      port: 0, host: "127.0.0.1", defaultProfile: "p",
      profiles: [{ id: "p", claudeConfigDir: configDir }],
    })
    await proxy.sweepSessionGc?.()
    expect(resourceStates().filter(state => state === "retired")).toHaveLength(300)
  }, 60_000)

  it("hands a draining proxy's sweeps the shutdown cap of 16", async () => {
    process.env.MERIDIAN_SESSION_GC_INTERVAL_MS = "0"
    const runGc = lifecycle.runGc
    const limits: number[] = []
    const spy = spyOn(lifecycle, "runGc").mockImplementation((pins, options) => {
      limits.push(options?.maxDeletesPerRun ?? -1)
      return runGc(pins, options)
    })
    try {
      const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
      await proxy.sweepSessionGc?.()
      proxy.beginDrain?.()
      await proxy.sweepSessionGc?.()
      expect(limits).toEqual([64, 16])
    } finally {
      spy.mockRestore()
    }
  }, 60_000)
})
