/**
 * Build provenance reads a checkout with Git under a short deadline and
 * SIGKILLs Git past it. `git status` refreshes the index and writes it back
 * under `.git/index.lock`; a Git killed mid-write leaves that lock behind, and
 * every later index-writing Git in the checkout (a pull, a merge) fails until
 * someone deletes it. Provenance only reads, so it must never take the lock.
 */
import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitOutput } from "../proxy/buildSnapshot"

const root = mkdtempSync(join(tmpdir(), "meridian-git-no-index-lock-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
function git(...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, timeout: 5000, killSignal: "SIGKILL" })
  if (result.error || result.status !== 0) throw new Error(`Fixture Git failed: ${result.stderr}`)
}

test("reading status for provenance never rewrites the index", () => {
  writeFileSync(join(root, "input.ts"), "unchanged\n")
  git("init", "-b", "main"); git("add", "."); git("commit", "-m", "fixture")
  // Same content, new mtime: the index's stat data is stale, which is what
  // makes a plain `git status` refresh it and write it back.
  const hourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(join(root, "input.ts"), hourAgo, hourAgo)
  const before = readFileSync(join(root, ".git/index"))

  expect(gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"], 5000)).toBe("")

  expect(readFileSync(join(root, ".git/index")).equals(before)).toBe(true)
})
