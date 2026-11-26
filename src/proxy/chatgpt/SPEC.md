---
id: chatgpt-backend
type: module-design
status: active
title: ChatGPT backend
parent: architecture
depends-on: [session, profiles-routing, telemetry-ui]
references: [api-contract]
---

## Responsibility

Serve OpenAI models from the operator's **ChatGPT subscription seats** (opt-in):
`/v1/responses` turns for OpenAI model ids and the OpenAI Images routes are
passed through to the Codex backend on one seat, with seat failover, plan/credit
policy, usage and cost telemetry. Also owns seat sign-in and renewal, the
`meridian chatgpt-migrate` and `meridian instance-import` commands, the
read-only oc-codex usage view on the dashboard, and listing and redeeming a
seat's banked rate-limit reset credits.

Code: `src/proxy/chatgpt/` (incl. `migrate/`), `src/proxy/codex/`,
`src/proxy/upstream/`, `src/proxy/instanceImport/`, `backends/chatgpt*.ts`.

## Boundary

- **Provider is decided first.** `upstream/provider.ts` (pure) maps a model to
  its provider *before* profile resolution, session lookup and transcript work,
  because all of those are Claude-shaped. `upstream/backend.ts` is the
  provider-neutral seam; it is a separate axis from `AgentAdapter` (which
  describes the client), so a Codex client can be served by Claude or ChatGPT.
- **Never enters the Claude pipeline:** no Agent SDK, adapter detection, system
  prompt, or plugin hooks, so a Claude-oriented plugin cannot rewrite a GPT
  request. Bodies are adapted only where the Codex backend requires it; the
  response streams back byte for byte. A GPT model is never answered by Claude
  (`/v1/messages` returns 404 when ChatGPT is configured).
- **Client attribution stays local.** Turn events retain the optional client and purpose for request telemetry, including retries and Images requests. Codex request headers are assembled separately and never contain a Meridian header.
- **Exactly one program refreshes a seat.** ChatGPT refresh tokens are
  single-use: exchanging one invalidates every other copy and breaks the account
  (`refresh_token_reused`). Hence:
  - `owned` mode holds a machine-wide **writer lease**, taken explicitly at
    startup (never in `createProxyServer`, which tests and embedders call), and
    fails rather than degrades if it cannot;
  - `follow-external` and `codex/` only **read** the oc-codex-multi-auth pool
    and never write it, its locks or the token endpoint;
  - migration *moves* refresh authority rather than copying it;
  - the `exchangeStartedAt` stamp, written before an exchange goes out and
    cleared by the commit of its result, is what stops a second exchange: the
    refresher and renewal pass refuse any stamped seat. For **listing** only,
    a stamp means "needs a sign-in" once no exchange can still clear it. The
    lease holder asks its refresher which exchanges it has out; other readers
    (`MERIDIAN_CREDENTIALS_READONLY`) treat a stamp younger than the exchange
    timeout plus 5 s as in flight, so they may lag a lost sign-in by up to
    about 20 s, and a stamp dated in the future is not trusted (#1463).
  - the renewal pass falls due 80% into a token's life, or at the seat's own
    `seatRenewalHours` interval (6-240 hours) after the token's `iat`, never later than a
    request would renew it; a token without `iat` is left to the request path.
    Each exchange the provider saw is recorded on the seat's own store record
    (`renewals`, newest 64), in the commit of its tokens or beside the stamp a
    failure leaves; an attempt that never reached the provider records
    nothing. The history is never a credential, so a malformed entry is
    dropped on read rather than failing the store. Owner approval pending.
- **Banked resets are listed for every seat and spent only on an owned one**
  (owner-requested 2026-11-26, Portal AI_TODO #762). Each seat's
  `/v1/usage/quota/all` entry carries `bankedResets` in the Claude shape
  (`chatgpt/resetCredits.ts`), built from the credit list the usage read
  already fetches: one grant per available credit, `resetsLeft: 1`,
  `kind: "full"`, `clears` the seat's reported `five_hour`/`seven_day`
  windows, `percentUsed` their current reading, `startsAt` the grant time,
  `usableNow` the seat-wide `applicable_available_count > 0` (null when
  unstated; the vendor does not say which credits it counts), `nextGrantId`
  the soonest-expiring credit, and `unreadableGrants` for credits it holds but
  cannot list (no id, or the list unreadable while the usage payload states a
  count). Credit ids do not fit the route's grant-id format, so each is listed
  as `credit_` plus 24 hex of its SHA-256, which Meridian resolves by reading
  the list again. A followed seat (`follow-external`) lists them with
  `eligible: false, ineligibleReason: "external_owner"`, and the reset route
  answers it 400 `not_owned`: its sign-in belongs to oc-codex-multi-auth,
  whose own `codex-reset` spends them.
  Redemption is the Claude route's contract (explicit only, one per profile in
  flight, dispatched outcomes replayed per request ID; `quotaReset.ts`). Before
  the consume POST, Meridian reads usage and the credit list with the seat's
  token and requires the read to confirm the seat's account and user, the
  named credit to still be listed available, and the seat to state a credit
  applies now (else `not_limited`, nothing sent). The vendor's
  `redeem_request_id` is a UUID derived from the seat, credit and request ID,
  so a retried request is one redemption upstream too. A 4xx refusal spent
  nothing and answers `unavailable` with only the vendor's code; 5xx, timeout
  or transport loss after dispatch is `indeterminate`. A dispatched outcome
  drops the seat's cached usage and reads it again; a confirmed reset also
  drops its last response's windows and a quota bench, never a token or
  provider-fault bench. `codex/` stays read-only: the consume POST lives in
  `chatgpt/resetCredits.ts`.
- Seats are profiles with `type: "chatgpt"` and their own active pointer; they
  never live in Claude's profile config. All additions are absent unless
  ChatGPT is enabled, and existing fields keep their meaning
  ([`api-contract`](../../../.agents/references/api-contract.md)).
- Direct Responses requests can opt in to [pre-dispatch route refusal evidence](../profiles-routing.spec.md#cross-provider-evidence). The ChatGPT backend waits until ordinary seat policy has yielded no dispatch; the provider-specific HTTP proof excludes proxy fallback and billing policies, sits outside streaming, and never authenticates an upstream error body as Meridian-local evidence.
- `chatgpt/migrate/` and `instanceImport/` are CLI-only — **the server never
  imports them**.
- Reuses only `session` durability primitives (durable file writes, process
  incarnation, recovery claims) — never session lineage or caches.

User-facing behavior: `docs/configuration.md` → *ChatGPT subscriptions*,
*ChatGPT migration*, *Moving ChatGPT seats between instances*.

## Known limitations

- Only the Responses and Images APIs reach ChatGPT; `/v1/chat/completions` and
  `/v1/messages` refuse a ChatGPT-served model rather than serving it.
- Cost figures use OpenAI list prices; Fast-mode requests are underestimated.
- With `MERIDIAN_CREDENTIALS_READONLY=1`, owned seats are not renewed ahead of
  expiry by this instance.
