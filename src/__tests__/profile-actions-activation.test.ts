import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import type { ActivationRefusal } from "../proxy/forcedProfile"
import { profileActionsJs } from "../telemetry/profileActions"

const target = { profile: "target" } as const
const forced = { profile: "current", forcedAt: Date.UTC(2026, 10, 19, 12), until: Date.UTC(2026, 10, 19, 17) } as const
const releaseFlags = { releaseForce: true, releaseForceFor: { profile: forced.profile, forcedAt: forced.forcedAt } } as const
type BrowserRefusal = ActivationRefusal & { readonly releaseAndForce?: true }
const releaseOnly = {
  kind: "forced_elsewhere", profile: target.profile, by: "Operator",
  reason: "Current is forced active.", forceable: false, forceAllowed: false,
  forceNote: "Release the current force to switch.", forced,
} satisfies ActivationRefusal
const forceOnly = {
  kind: "managed_excluded", profile: target.profile, by: "Supervisor",
  reason: "Target is excluded from rotation.", forceable: true, forceAllowed: true,
  forceNote: "The switch will force target active.", forced,
} satisfies ActivationRefusal
const combined = {
  ...releaseOnly, releaseAndForce: true, reason: "Current is forced active and target is excluded.",
} satisfies BrowserRefusal

const forceLabel = "Activate anyway"
const releaseLabel = "Release and switch"
const combinedLabel = "Release current and activate anyway"

type Dialog = {
  readonly message: string
  readonly facts: readonly (readonly [string, string])[]
  readonly actions: readonly { readonly label: string; readonly value: unknown }[]
  readonly focus: number
  readonly cancelValue: unknown
}

async function activate(replies: readonly (BrowserRefusal | "success")[], choices: readonly string[]) {
  const posts: unknown[] = []
  const dialogs: Dialog[] = []
  const result: unknown = await runInNewContext(`${profileActionsJs}\nmeridianProfileActions.activate('target');`, {
    window: {},
    fetch(url: string, init: { readonly method: string; readonly body: string }) {
      expect([init.method, url]).toEqual(["POST", "/profiles/active"])
      const reply = replies[posts.length]
      posts.push(JSON.parse(init.body))
      if (!reply) throw new Error("Unexpected extra activation POST")
      return Promise.resolve(reply === "success"
        ? Response.json({ success: true })
        : Response.json({ refusal: reply }, { status: 409 }))
    },
    meridianDialog: {
      show(dialog: Dialog) {
        const label = choices[dialogs.length] ?? "Close"
        dialogs.push(dialog)
        const selected = dialog.actions.find(action => action.label === label)
        return Promise.resolve(selected ? selected.value : dialog.cancelValue)
      },
    },
  })
  return { result, posts, dialogs, labels: dialogs.map(dialog => Array.from(dialog.actions, action => action.label)) }
}

test("offers one combined confirmation that names the current force and sends both flags", async () => {
  const { result, posts, dialogs, labels } = await activate([combined, "success"], [combinedLabel])

  expect(labels).toEqual([["Close", combinedLabel]])
  expect(dialogs[0]?.focus).toBe(0)
  expect(dialogs[0]?.message).toBe(combined.reason)
  expect(dialogs[0]?.facts.some(([, value]) =>
    value.includes(forced.profile) && value.includes(new Date(forced.until).toLocaleString()),
  )).toBe(true)
  expect(posts).toEqual([target, { ...target, ...releaseFlags, force: true }])
  expect(result).toBe(true)
})

test.each([
  { order: "force then release", first: forceOnly, second: releaseOnly, labels: [forceLabel, releaseLabel], initialFlags: { force: true } },
  { order: "release then force", first: releaseOnly, second: forceOnly, labels: [releaseLabel, forceLabel], initialFlags: releaseFlags },
])("retains consent across fallback dialogs ($order)", async ({ first, second, labels: choices, initialFlags }) => {
  const { result, posts, labels } = await activate([first, second, "success"], choices)

  expect(labels).toEqual(choices.map(label => ["Close", label]))
  expect(posts).toEqual([target, { ...target, ...initialFlags }, { ...target, ...releaseFlags, force: true }])
  expect(result).toBe(true)
})

test.each([
  { label: forceLabel, refusal: forceOnly, flags: { force: true } },
  { label: releaseLabel, refusal: releaseOnly, flags: releaseFlags },
  { label: combinedLabel, refusal: combined, flags: { ...releaseFlags, force: true } },
])("reports a refused '$label' retry without offering it again", async ({ label, refusal, flags }) => {
  const finalRefusal = { ...refusal, reason: "Meridian still refuses to switch." }
  const { result, posts, dialogs, labels } = await activate([refusal, finalRefusal], [label, label])

  expect(labels).toEqual([["Close", label], ["Close"]])
  expect(dialogs[1]?.message).toBe(finalRefusal.reason)
  expect(posts).toEqual([target, { ...target, ...flags }])
  expect(result).toBe(false)
})

test.each([
  { label: releaseLabel, refusal: releaseOnly, flags: releaseFlags },
  { label: combinedLabel, refusal: combined, flags: { ...releaseFlags, force: true } },
])("asks for fresh '$label' consent when the same profile is forced again", async ({ label, refusal, flags }) => {
  const newer = { ...forced, forcedAt: forced.forcedAt + 60_000, until: forced.until + 60_000 }
  const freshRefusal = { ...refusal, forced: newer }
  const { result, posts, labels } = await activate([refusal, freshRefusal, freshRefusal], [label, label, label])

  expect(labels).toEqual([["Close", label], ["Close", label], ["Close"]])
  expect(posts).toEqual([
    target,
    { ...target, ...flags },
    { ...target, ...flags, releaseForceFor: { profile: newer.profile, forcedAt: newer.forcedAt } },
  ])
  expect(result).toBe(false)
})

test("sends the legacy bare release flag when the refusal has no force identity", async () => {
  const { kind, profile, by, reason, forceable, forceAllowed, forceNote } = releaseOnly
  const refusal = { kind, profile, by, reason, forceable, forceAllowed, forceNote }
  const { result, posts, labels } = await activate([refusal, "success"], [releaseLabel])

  expect(labels).toEqual([["Close", releaseLabel]])
  expect(posts).toEqual([target, { ...target, releaseForce: true }])
  expect(result).toBe(true)
})
