import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { getConversationFingerprint } from "../proxy/session/fingerprint"
import { join } from "node:path"
import { clearSessionCache, lookupSession, rollbackPrioritySessionPublication, storeSession, type PrioritySessionPublication } from "../proxy/session/cache"
import { computeLineageHash } from "../proxy/session/lineage"
import { openCodePrimaryAgentContextHash } from "../proxy/adapters/opencodeAgentContext"
import { claimPriorityAttempt, lookupPriorityAssignmentResult, lookupSharedSession, lookupSharedSessionResult, setSessionStoreDir } from "../proxy/sessionStore"
import { commitRawSession, holdWriteLock, readCommittedSession, releaseStoreDatabase } from "./storeDatabaseHelpers"

const messages = [{ role: "user", content: "raw original objective" }]
const continuation = [...messages, { role: "assistant", content: "answer" }, { role: "user", content: "next question" }]

async function priorityPublication(routeKey: string): Promise<PrioritySessionPublication> {
  const route = lookupPriorityAssignmentResult(routeKey)
  if (route.status === "error") throw route.error
  const claim = await claimPriorityAttempt({ routeKey, expectedAssignmentGeneration: route.generation })
  if (!claim) throw new Error("fixture priority claim failed")
  return { routeKey, profileId: "work", lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1_900_000_000,
    attemptOwnerToken: claim.ownerToken, expectedAssignmentGeneration: route.generation }
}

describe("durable raw proof and execution reuse proof", () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meridian-execution-proof-"))
    setSessionStoreDir(directory)
  })
  afterEach(async () => {
    setSessionStoreDir(null)
    await releaseStoreDatabase(directory)
    rmSync(directory, { recursive: true, force: true })
  })

  it("ordinary transformed publication keeps raw continuation and strips inherited UUID/checkpoint authority", async () => {
    expect(await storeSession("ordinary", messages, "sdk-transformed", undefined,
      ["raw-user-uuid", "new-assistant-uuid", "unrelated-uuid"], undefined,
      "inherited-checkpoint", ["inherited-tool"], undefined, undefined, undefined, undefined, false)).not.toBe(false)
    const stored = lookupSharedSession("ordinary")
    expect(stored).toMatchObject({ messageCount: 1, lineageHash: "", clientLineageHash: computeLineageHash(messages),
      sdkMessageUuids: [null, "new-assistant-uuid", null] })
    expect(stored?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(stored?.passthroughToolCallIds).toBeUndefined()
    expect(lookupSession("ordinary", continuation).type).toBe("continuation")
    // Close the store, so the next lookup loads the committed row.
    await releaseStoreDatabase(directory)
    expect(lookupSession("ordinary", continuation).type).toBe("continuation")
    const serialized = readCommittedSession(directory, "ordinary")
    expect(serialized?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(serialized?.lineageHash).toBe("")

    expect(await storeSession("ordinary", continuation, "sdk-full-replay")).not.toBe(false)
    const restored = lookupSharedSession("ordinary")
    expect(restored?.lineageHash).toBe(computeLineageHash(continuation))
    expect(restored?.clientLineageHash).toBeUndefined()
    expect(readCommittedSession(directory, "ordinary")?.clientLineageHash).toBeUndefined()
  })

  it("priority atomic publication, reload and rollback retain distinct proofs", async () => {
    const originalSystem = openCodePrimaryAgentContextHash("primary", "build")
    const revisedSystem = openCodePrimaryAgentContextHash("primary", "reviewer")
    await storeSession("work:priority", messages, "sdk-transformed", undefined, [null, "current-only"], undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false, originalSystem)
    const before = lookupSharedSessionResult("work:priority")
    if (before.status !== "found") throw new Error("fixture mapping missing")
    const publication = await priorityPublication("priority")
    expect(await storeSession("work:priority", continuation, "sdk-full-replay", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, publication, true, revisedSystem)).not.toBe(false)
    expect(lookupSharedSession("work:priority")?.resumeContextHash).toBe(revisedSystem)
    expect(lookupSharedSession("work:priority")?.clientLineageHash).toBeUndefined()
    expect(lookupSharedSession("work:priority")?.lineageHash).toBe(computeLineageHash(continuation))
    expect(await rollbackPrioritySessionPublication("work:priority", continuation, undefined, publication)).not.toBe(false)
    const restored = lookupSharedSession("work:priority")
    expect(restored?.lineageHash).toBe("")
    expect(restored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(restored?.sdkMessageUuids).toEqual([null, "current-only"])
    expect(restored?.resumeContextHash).toBe(originalSystem)
    await releaseStoreDatabase(directory)
    const reloaded = lookupSession("work:priority", continuation)
    expect(reloaded.type).toBe("continuation")
    if (reloaded.type === "diverged") throw new Error("Expected restored mapping")
    expect(reloaded.session.resumeContextHash).toBe(originalSystem)
  })

  it("priority transformed publication clears checkpoint proof in the atomic stored record", async () => {
    const mapping = lookupSharedSessionResult("work:transformed-priority")
    if (mapping.status === "error") throw mapping.error
    const publication = await priorityPublication("transformed-priority")
    expect(await storeSession("work:transformed-priority", messages, "sdk-priority", undefined,
      ["old-user", "new-assistant"], undefined, "old-checkpoint", ["old-tool"], undefined,
      undefined, mapping.generation, publication, false)).not.toBe(false)
    const stored = lookupSharedSession("work:transformed-priority")
    expect(stored?.lineageHash).toBe("")
    expect(stored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(stored?.sdkMessageUuids).toEqual([null, "new-assistant"])
    expect(stored?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(stored?.passthroughToolCallIds).toBeUndefined()
  })

  it("fails closed on malformed persisted raw proof rather than granting SDK resume", async () => {
    await storeSession("malformed", messages, "sdk-malformed", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false)
    const entry = readCommittedSession(directory, "malformed")
    if (!entry) throw new Error("fixture mapping missing")
    commitRawSession(directory, "malformed", { ...entry, clientLineageHash: 7 })
    await releaseStoreDatabase(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(lookupSharedSessionResult("malformed").status).toBe("error")
    } finally { errors.mockRestore() }
  })

  it("persists instruction section digests and drops them when a new SDK session replaces the mapping", async () => {
    const sections = { seen: { ["c".repeat(64)]: "d".repeat(64) } }
    await storeSession("sections", messages, "sdk-sections", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, true, undefined, sections)
    await releaseStoreDatabase(directory)
    expect(readCommittedSession(directory, "sections")?.instructionSections).toEqual(sections)
    const reloaded = lookupSession("sections", continuation)
    if (reloaded.type === "diverged") throw new Error("Expected stored mapping")
    expect(reloaded.session.instructionSections).toEqual(sections)
    expect(await storeSession("sections", continuation, "sdk-other")).not.toBe(false)
    expect(lookupSharedSession("sections")?.instructionSections).toBeUndefined()
  })

  it("fails closed on malformed persisted instruction section digests", async () => {
    await storeSession("malformed-sections", messages, "sdk-malformed-sections")
    const entry = readCommittedSession(directory, "malformed-sections")
    if (!entry) throw new Error("fixture mapping missing")
    commitRawSession(directory, "malformed-sections", { ...entry, instructionSections: { seen: { "/work/AGENTS.md": "x" } } })
    await releaseStoreDatabase(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(lookupSharedSessionResult("malformed-sections").status).toBe("error")
    } finally { errors.mockRestore() }
  })

  it("fails closed on malformed persisted adapter context proof", async () => {
    await storeSession("malformed-system", messages, "sdk-malformed-system")
    const entry = readCommittedSession(directory, "malformed-system")
    if (!entry) throw new Error("fixture mapping missing")
    commitRawSession(directory, "malformed-system", { ...entry, resumeContextHash: "not-a-digest" })
    await releaseStoreDatabase(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try { expect(lookupSharedSessionResult("malformed-system").status).toBe("error") }
    finally { errors.mockRestore() }
  })

  it("captures the headerless rollback key before an ordered store write yields", async () => {
    const history = [{ role: "user", content: "headerless rollback original objective" }]
    const originalHistory = structuredClone(history)
    const cwd = "/fixture/headerless-rollback"
    const key = getConversationFingerprint(history, cwd)
    await storeSession(undefined, history, "sdk-before", cwd)
    const before = lookupSharedSessionResult(key)
    if (before.status !== "found") throw new Error("fixture mapping missing")
    const publication = await priorityPublication("headerless-rollback")
    expect(await storeSession(undefined, history, "sdk-published", cwd, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, publication)).not.toBe(false)

    const holder = await holdWriteLock(directory)
    const pending = rollbackPrioritySessionPublication(undefined, history, cwd, publication)
    try {
      expect(pending).toBeInstanceOf(Promise)
      history[0]!.content = "caller changed its input while rollback waited"
      expect(lookupSharedSession(key)?.claudeSessionId).toBe("sdk-published")
    } finally {
      await holder.release()
      await pending
    }
    expect(lookupSharedSession(key)?.claudeSessionId).toBe("sdk-before")
    // Force the genuine store-error fallback so disk reads cannot hide a stale LRU.
    const entry = readCommittedSession(directory, key)
    if (!entry) throw new Error("fixture mapping missing")
    commitRawSession(directory, key, { ...entry, resumeContextHash: "not-a-digest" })
    await releaseStoreDatabase(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = lookupSession(undefined, [...originalHistory,
        { role: "assistant", content: "answer" }, { role: "user", content: "next" }], cwd)
      expect(result.type).toBe("continuation")
      if (result.type !== "continuation") throw new Error("Expected restored fallback")
      expect(result.session.claudeSessionId).toBe("sdk-before")
    } finally {
      errors.mockRestore()
    }
  })

  it.each(["pending-clear", undefined])("clears the fallback repopulated while durable cleanup waits (%s)", async (key) => {
    const cwd = "/fixture/pending-json-clear"
    await storeSession(key, messages, "old-sdk", cwd)
    const holder = await holdWriteLock(directory)
    const pending = clearSessionCache()
    const later = storeSession("later", messages, "later-sdk", cwd)
    try {
      expect(pending).toBeInstanceOf(Promise)
      // A synchronous read can populate memory from the still-authoritative disk record.
      const during = lookupSession(key, continuation, cwd)
      expect(during.type).toBe("continuation")
    } finally {
      await holder.release()
      await Promise.all([pending, later])
    }
    const durableKey = key ?? getConversationFingerprint(messages, cwd)
    expect(lookupSharedSessionResult(durableKey).status).toBe("missing")
    // Force the genuine store-error fallback for the cleared key.
    const laterEntry = readCommittedSession(directory, "later")
    if (!laterEntry) throw new Error("later mapping missing")
    commitRawSession(directory, durableKey, { ...laterEntry, resumeContextHash: "not-a-digest" })
    await releaseStoreDatabase(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(lookupSession(key, continuation, cwd).type).toBe("diverged")
      const newest = lookupSession("later", continuation, cwd)
      expect(newest.type).toBe("continuation")
      if (newest.type !== "continuation") throw new Error("Later publication lost")
      expect(newest.session.claudeSessionId).toBe("later-sdk")
    } finally {
      errors.mockRestore()
    }
  })
})
