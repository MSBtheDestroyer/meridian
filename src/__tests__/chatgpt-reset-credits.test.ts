/**
 * A ChatGPT seat's reset credits: listed as Claude-shaped `bankedResets` and
 * redeemed through chatgpt.com, which is mocked here. Nothing reaches the
 * network; every consume a test sends is counted.
 */
import { describe, expect, test } from "bun:test"
import { chatGptBankedResets, chatGptCreditGrantId, createChatGptResetRedeemer } from "../proxy/chatgpt/resetCredits"
import type { ChatGptCredentialSource } from "../proxy/chatgpt/source"
import type { CodexResetCredit, CodexResetCredits } from "../proxy/codex/types"

const NOW = Date.now()
const SEAT = "user-ABC__ws-1"
const ACCOUNT = "ws-1"
const GRANT_ID = /^[a-z0-9_-]{1,40}$/

function token(overrides: Record<string, unknown> = {}): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "RS256" })}.${part({
    exp: Math.floor(NOW / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_account_user_id: SEAT, chatgpt_user_id: "user-ABC", chatgpt_plan_type: "pro", ...overrides },
  })}.sig`
}

const owned = (accessToken = token()) => ({
  mode: "owned",
  credentials: async () => ({ ok: true, account: { accountUserId: SEAT, accountId: ACCOUNT, accessToken } }),
}) as unknown as ChatGptCredentialSource

function credit(id: string | null, expiresAt: number | null, extra: Partial<CodexResetCredit> = {}): CodexResetCredit {
  return { id, status: "available", expiresAt, grantedAt: NOW - 86_400_000, resetType: "codex_rate_limits", title: "Rate limit reset", ...extra }
}

function resets(extra: Partial<CodexResetCredits>): CodexResetCredits {
  return { availableCount: null, applicableAvailableCount: null, listedCount: null, credits: null, error: null, ...extra }
}

const WINDOWS = [{ type: "five_hour", utilization: 0.42 }, { type: "seven_day", utilization: 1 }, { type: "30d", utilization: 0.1 }]

describe("a seat's credits as bankedResets", () => {
  test("lists each credit under a stable alias in the Claude grant shape", () => {
    const banked = chatGptBankedResets(resets({
      availableCount: 2, applicableAvailableCount: 2, listedCount: 2,
      credits: [credit("RateLimitResetCredit_a", NOW + 3_000), credit("RateLimitResetCredit_b", NOW + 9_000)],
    }), WINDOWS, true)
    expect(banked).toEqual({
      eligible: true,
      ineligibleReason: null,
      nextGrantId: chatGptCreditGrantId("RateLimitResetCredit_a"),
      grants: ["RateLimitResetCredit_a", "RateLimitResetCredit_b"].map((id, index) => ({
        id: chatGptCreditGrantId(id),
        resetsLeft: 1,
        expiresAt: NOW + (index === 0 ? 3_000 : 9_000),
        startsAt: NOW - 86_400_000,
        paused: false,
        usableNow: true,
        kind: "full",
        providerType: "codex_rate_limits",
        clears: ["five_hour", "seven_day"],
        givesBackWeekly: null,
        description: "Rate limit reset",
        percentUsed: { five_hour: 42, seven_day: 100 },
      })),
      unreadableGrants: 0,
    })
    for (const grant of banked!.grants) expect(grant.id).toMatch(GRANT_ID)
    expect(chatGptCreditGrantId("RateLimitResetCredit_a")).toBe(chatGptCreditGrantId("RateLimitResetCredit_a"))
    expect(chatGptCreditGrantId("RateLimitResetCredit_a")).not.toBe(chatGptCreditGrantId("RateLimitResetCredit_b"))
  })

  test("usableNow follows the seat's applicable count, and is unknown without one", () => {
    const listed = (applicableAvailableCount: number | null) => chatGptBankedResets(resets({
      applicableAvailableCount, listedCount: 1, credits: [credit("c1", null)],
    }), [], true)!.grants[0]!.usableNow
    expect([listed(0), listed(1), listed(null)]).toEqual([false, true, null])
  })

  test("clears only the windows the seat reports", () => {
    const weeklyOnly = chatGptBankedResets(resets({ listedCount: 1, credits: [credit("c1", null)] }), [{ type: "seven_day", utilization: null }], true)
    expect(weeklyOnly!.grants[0]).toMatchObject({ clears: ["seven_day"], percentUsed: {} })
  })

  test("counts what it cannot list instead of guessing: an id-less credit, credits beyond the list, an unreadable list", () => {
    expect(chatGptBankedResets(resets({ listedCount: 3, credits: [credit(null, NOW), credit("c1", NOW + 1)] }), [], true))
      .toMatchObject({ grants: [{ id: chatGptCreditGrantId("c1") }], unreadableGrants: 2 })
    expect(chatGptBankedResets(resets({ availableCount: 4, error: "upstream_error" }), [], true))
      .toEqual({ eligible: true, ineligibleReason: null, nextGrantId: null, grants: [], unreadableGrants: 4 })
    expect(chatGptBankedResets(resets({ error: "upstream_error" }), [], true)).toBeNull()
    expect(chatGptBankedResets(null, [], true)).toBeNull()
  })

  test("a seat another program owns is listed but not redeemable", () => {
    expect(chatGptBankedResets(resets({ listedCount: 1, credits: [credit("c1", null)] }), [], false))
      .toMatchObject({ eligible: false, ineligibleReason: "external_owner", grants: [{ id: chatGptCreditGrantId("c1") }] })
  })
})

interface Call { url: string; method: string; body: Record<string, unknown> | null; headers: Headers }

/** chatgpt.com as the redeemer sees it: usage, the credit list and the consume endpoint. */
function chatgpt(options: {
  credits?: Array<Record<string, unknown>>
  applicable?: number
  accountId?: string
  consume?: () => Response | Promise<Response>
} = {}) {
  const calls: Call[] = []
  const credits = options.credits ?? [
    { id: "RateLimitResetCredit_a", status: "available", reset_type: "codex_rate_limits", expires_at: new Date(NOW + 86_400_000).toISOString() },
    { id: "RateLimitResetCredit_b", status: "available", reset_type: "codex_rate_limits", expires_at: new Date(NOW + 2 * 86_400_000).toISOString() },
  ]
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null, headers: new Headers(init?.headers) })
    if (url.endsWith("/wham/usage")) {
      return Response.json({
        user_id: "user-ABC", account_id: options.accountId ?? ACCOUNT, plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: Math.floor(NOW / 1000) + 3600 },
          secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: Math.floor(NOW / 1000) + 86_400 },
        },
        rate_limit_reset_credits: { available_count: credits.length, applicable_available_count: options.applicable ?? credits.length },
      })
    }
    if (url.endsWith("/wham/rate-limit-reset-credits")) return Response.json({ available_count: credits.length, credits })
    if (url.endsWith("/wham/rate-limit-reset-credits/consume")) return (options.consume ?? (() => Response.json({ code: "ok", windows_reset: ["primary", "secondary"] })))()
    throw new Error(`unexpected network call in test: ${url}`)
  }) as unknown as typeof fetch
  const consumes = () => calls.filter(call => call.url.endsWith("/consume"))
  return { calls, consumes, fetchImpl }
}

function redeemer(fetchImpl: typeof fetch, source = owned()) {
  const rereads: string[] = []
  const after = resets({ availableCount: 1, applicableAvailableCount: 0, listedCount: 1, credits: [credit("RateLimitResetCredit_b", NOW + 2 * 86_400_000)] })
  const instance = createChatGptResetRedeemer({ source, fetchImpl, reread: async (seat) => { rereads.push(seat); return after } })
  return { instance, rereads }
}

const input = { profile: "seat-abc", grantId: chatGptCreditGrantId("RateLimitResetCredit_a"), requestId: "Request-1" }

describe("redeeming a seat's credit", () => {
  test("consumes the named credit once, with the seat's token and a stable idempotency key", async () => {
    const upstream = chatgpt()
    const { instance, rereads } = redeemer(upstream.fetchImpl)
    const attempt = await instance.redeemOnce(input, SEAT)
    expect(attempt).toEqual({ kind: "settled", replayed: false, result: { ok: true, outcome: {
      result: "reset", reason: null, resetsLeft: 1, cleared: ["five_hour", "seven_day"], weeklyResetsAt: null, cooldownUntil: null,
    } } })
    expect(rereads).toEqual([SEAT])
    const [consume] = upstream.consumes()
    expect(upstream.consumes()).toHaveLength(1)
    expect(consume!.method).toBe("POST")
    expect(consume!.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume")
    expect(consume!.headers.get("authorization")).toBe(`Bearer ${token()}`)
    expect(consume!.headers.get("chatgpt-account-id")).toBe(ACCOUNT)
    expect(consume!.headers.get("content-type")).toBe("application/json")
    expect(consume!.body?.credit_id).toBe("RateLimitResetCredit_a")
    expect(String(consume!.body?.redeem_request_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // A fresh process given the same request derives the same key, so the backend can tell a retry.
    const again = chatgpt()
    await redeemer(again.fetchImpl).instance.redeemOnce(input, SEAT)
    expect(again.consumes()[0]!.body?.redeem_request_id).toBe(consume!.body?.redeem_request_id)
  })

  test("a repeated request ID replays the outcome; with another grant it is a conflict; neither consumes again", async () => {
    const upstream = chatgpt()
    const { instance } = redeemer(upstream.fetchImpl)
    const first = await instance.redeemOnce(input, SEAT)
    if (first.kind !== "settled") throw new Error("Expected a settled first redemption")
    expect(await instance.redeemOnce(input, SEAT)).toEqual({ kind: "settled", replayed: true, result: first.result })
    expect(await instance.redeemOnce({ ...input, grantId: chatGptCreditGrantId("RateLimitResetCredit_b") }, SEAT)).toEqual({ kind: "request_id_conflict" })
    expect(upstream.consumes()).toHaveLength(1)
  })

  test("a second redemption for the seat while one is in flight sends nothing", async () => {
    const release = Promise.withResolvers<Response>()
    const posted = Promise.withResolvers<void>()
    const upstream = chatgpt({ consume: () => { posted.resolve(); return release.promise } })
    const { instance } = redeemer(upstream.fetchImpl)
    const first = instance.redeemOnce(input, SEAT)
    await posted.promise
    expect(await instance.redeemOnce({ ...input, requestId: "Request-2" }, SEAT)).toEqual({ kind: "in_progress" })
    release.resolve(Response.json({}))
    expect(await first).toMatchObject({ kind: "settled", result: { ok: true, outcome: { result: "reset" } } })
    expect(upstream.consumes()).toHaveLength(1)
  })

  test("a timeout or provider fault after dispatch is indeterminate, re-reads the seat and is replayed, never re-sent", async () => {
    for (const consume of [
      () => { throw new DOMException("The operation timed out.", "TimeoutError") },
      () => new Response("private upstream body", { status: 502 }),
    ]) {
      const upstream = chatgpt({ consume })
      const { instance, rereads } = redeemer(upstream.fetchImpl)
      const first = await instance.redeemOnce(input, SEAT)
      expect(first).toMatchObject({ kind: "settled", replayed: false, result: { ok: false, status: 502, code: "reset_indeterminate", indeterminate: true, dispatched: true } })
      expect(JSON.stringify(first)).not.toContain("private upstream body")
      expect(rereads).toEqual([SEAT])
      expect(await instance.redeemOnce(input, SEAT)).toMatchObject({ kind: "settled", replayed: true, result: { code: "reset_indeterminate" } })
      expect(upstream.consumes()).toHaveLength(1)
    }
  })

  test("a refusal spends nothing and passes on only the provider's code", async () => {
    const upstream = chatgpt({ consume: () => Response.json({ detail: { code: "credit_not_applicable", message: "private prose" } }, { status: 409 }) })
    const { instance, rereads } = redeemer(upstream.fetchImpl)
    const attempt = await instance.redeemOnce(input, SEAT)
    expect(attempt).toMatchObject({ kind: "settled", result: { ok: true, outcome: { result: "unavailable", reason: "credit_not_applicable", resetsLeft: 2, cleared: [] } } })
    expect(JSON.stringify(attempt)).not.toContain("private prose")
    expect(rereads).toEqual([])
    const auth = chatgpt({ consume: () => new Response(null, { status: 401 }) })
    expect(await redeemer(auth.fetchImpl).instance.redeemOnce(input, SEAT))
      .toMatchObject({ result: { ok: false, status: 502, code: "upstream_auth", indeterminate: false, dispatched: true } })
  })

  test("nothing is consumed for a credit no longer listed, a seat that is not limited, or an unconfirmed identity", async () => {
    const gone = chatgpt()
    expect(await redeemer(gone.fetchImpl).instance.redeemOnce({ ...input, grantId: chatGptCreditGrantId("RateLimitResetCredit_z") }, SEAT))
      .toMatchObject({ result: { ok: true, outcome: { result: "unavailable", reason: "credit_not_available", resetsLeft: 2 } } })
    const idle = chatgpt({ applicable: 0 })
    expect(await redeemer(idle.fetchImpl).instance.redeemOnce(input, SEAT))
      .toMatchObject({ result: { ok: true, outcome: { result: "not_limited", resetsLeft: 2 } } })
    const elsewhere = chatgpt({ accountId: "ws-other" })
    expect(await redeemer(elsewhere.fetchImpl).instance.redeemOnce(input, SEAT))
      .toMatchObject({ result: { ok: false, code: "identity_mismatch", dispatched: false } })
    for (const upstream of [gone, idle, elsewhere]) expect(upstream.consumes()).toHaveLength(0)
  })

  test("a seat without a usable token makes no request, and the failure is not remembered", async () => {
    const upstream = chatgpt()
    const refused = { mode: "owned", credentials: async () => ({ ok: false, reason: "requires_reauth" }) } as unknown as ChatGptCredentialSource
    const { instance } = redeemer(upstream.fetchImpl, refused)
    expect(await instance.redeemOnce(input, SEAT)).toMatchObject({ kind: "settled", replayed: false, result: { ok: false, status: 503, code: "no_token", dispatched: false } })
    expect(await instance.redeemOnce(input, SEAT)).toMatchObject({ replayed: false })
    expect(upstream.calls).toHaveLength(0)
  })
})
