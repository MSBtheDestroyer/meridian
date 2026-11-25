#!/usr/bin/env bun
// How many orphaned transcripts does one session GC sweep delete, through the
// real Agent SDK in child processes, at the default settings, and how long
// does that take against a large lifecycle file? No model calls.
//
// Live, 2026-10-09: every turn leaves its fork's transcript for the GC, and
// parallel runs left 1,100-1,700 an hour. Sweeps run on the interval and
// after every managed fork publication, so under load they ran back to back,
// but a fixed 256-transcript backlog over the 11-minute grace let only about
// 23 transcripts a minute be retired. Orphaned transcripts stayed live until
// they filled the ownership ceiling, and every request that needed a new one
// was refused 503 overloaded_error ("session transcript ownership capacity is
// full").
//
// The gate makes ORPHANS live transcripts, each a real file where the SDK
// keeps sessions, none pinned by a mapping, each registered the way the proxy
// does. A first sweep retires as many as the backlog allows; after the grace
// (1 s here) a second sweep deletes what it may, each with the SDK's
// deleteSession in a gated child process. The backlog is MAX_PENDING for
// every run, so only the deletion rate and the store's size differ.
//
//   bun scripts/e2e-session-gc-throughput.mjs                                  # 300 orphans
//   ORPHANS=2000 MAX_PENDING=2112 bun scripts/e2e-session-gc-throughput.mjs    # a larger store
//   E2E_MERIDIAN_ROOT=<checkout> bun scripts/e2e-session-gc-throughput.mjs     # another tree's src
//
// MAX_DELETES sets MERIDIAN_SESSION_GC_MAX_DELETES (64 when unset, the
// build's default). This fork keeps the lifecycle journal in sessions.db and
// a sweep keeps claiming batches while deletions are due, so the deleting
// sweep is expected to delete every orphan; DRAINING=1 starts the proxy's
// drain first, as close() does, and expects none (65ca1cfc). Orphans are all
// registered the way the proxy does; the bulk writer of upstream's JSON
// lifecycle file has no counterpart here.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? ".")
const ORPHANS = Number(process.env.ORPHANS ?? 300)
const MAX_PENDING = process.env.MAX_PENDING ?? "1000"
const DRAINING = process.env.DRAINING === "1"
const EXPECTED_DELETES = DRAINING ? 0 : ORPHANS
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-gc-throughput-")))
const profileDir = join(root, "profile")
const projectDir = join(root, "project")
const storeDir = join(root, "sessions")
const lifecycleFile = join(storeDir, "sessions.db")
mkdirSync(projectDir, { recursive: true })
const sessionsDir = join(profileDir, "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"))
mkdirSync(sessionsDir, { recursive: true })

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: storeDir, MERIDIAN_WORKDIR: projectDir,
  MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_SESSION_GC_GRACE_MS: "1000", MERIDIAN_SESSION_GC_MAX_PENDING: MAX_PENDING,
  ...(process.env.MAX_DELETES ? { MERIDIAN_SESSION_GC_MAX_DELETES: process.env.MAX_DELETES } : {}),
})

const { createProxyServer } = await import(pathToFileURL(join(repo, "src/proxy/server.ts")).href)
const { readSessionGcSnapshot, registerLiveTranscript } = await import(pathToFileURL(join(repo, "src/proxy/sessionLifecycle.ts")).href)
const { setSessionStoreDir } = await import(pathToFileURL(join(repo, "src/proxy/sessionStore.ts")).href)
setSessionStoreDir(storeDir)

const failures = []
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

function writeTranscript(sessionId) {
  const file = join(sessionsDir, `${sessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "orphan" } })}\n`)
  return file
}

function stateCounts() {
  const counts = {}
  for (const resource of Object.values(readSessionGcSnapshot(storeDir).resources)) {
    counts[resource.state] = (counts[resource.state] ?? 0) + 1
  }
  return counts
}

try {
  console.log(`${ORPHANS} orphaned transcripts, backlog ${MAX_PENDING}${DRAINING ? ", draining" : ""}, proxy ${repo}`)
  const files = []
  for (let i = 0; i < ORPHANS; i++) {
    const sessionId = randomUUID()
    files.push(writeTranscript(sessionId))
    await registerLiveTranscript({ sessionId, configDir: profileDir, projectDir })
  }
  console.log(`  note  lifecycle file ${(statSync(lifecycleFile).size / 1_048_576).toFixed(1)} MB`)

  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", defaultProfile: "p", profiles: [{ id: "p", claudeConfigDir: profileDir }] })
  let startedAt = Date.now()
  await proxy.sweepSessionGc()
  const retireSeconds = (Date.now() - startedAt) / 1000
  console.log(`  note  the first sweep retired ${stateCounts().retired ?? 0} in ${retireSeconds.toFixed(1)} s`)
  await new Promise(resolve => setTimeout(resolve, 1_500))
  if (DRAINING) proxy.beginDrain()
  startedAt = Date.now()
  await proxy.sweepSessionGc()
  const seconds = (Date.now() - startedAt) / 1000
  const deleted = files.filter(file => !existsSync(file)).length
  console.log(`  note  the second sweep deleted ${deleted} transcript file(s) in ${seconds.toFixed(1)} s` +
    (deleted ? `, ${(seconds / deleted * 1000).toFixed(0)} ms each` : "") +
    `; lifecycle file now ${JSON.stringify(stateCounts())}`)
  check(deleted === EXPECTED_DELETES, `one sweep deletes ${EXPECTED_DELETES} orphaned transcripts through the SDK`, `${deleted}`)
  check(seconds < 300, "within the sweep's five-minute continuation bound", `${seconds.toFixed(1)} s`)
} finally {
  setSessionStoreDir(null)
  rmSync(root, { recursive: true, force: true })
}
console.log(failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED: ${failures.join("; ")}`)
process.exit(failures.length === 0 ? 0 : 1)
