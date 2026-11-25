import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { resolveMockSdkSessionId } from "./helpers"
import { installSdkMock } from "./sdkMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { lookupSharedSession } from "../proxy/sessionStore"
import type { RequestMetric } from "../telemetry/types"

installSdkMock(() => ({
  query: ({ options }: { options: Record<string, unknown> }) => (async function* () {
    yield {
      type: "assistant",
      session_id: resolveMockSdkSessionId(options), uuid: randomUUID(),
      message: {
        id: "msg-ok", type: "message", role: "assistant", model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-client-session-attribution.test.ts")
installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")

const messages = { max_tokens: 10, messages: [{ role: "user", content: "Say ok" }] }
const scenarios: {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string>
  readonly expected?: string
  readonly invalid?: string
}[] = [
  { path: "/v1/messages", body: messages, headers: {}, expected: "fallback" },
  { path: "/v1/messages", body: messages, headers: { "x-opencode-session": "native-opencode" }, expected: "native-opencode" },
  { path: "/v1/chat/completions", body: messages, headers: { "x-session-id": "native-openai" }, expected: "native-openai" },
  { path: "/v1/responses", body: { input: "Say ok" }, headers: {}, expected: "fallback" },
  { path: "/v1/messages", body: messages, headers: {}, invalid: "x".repeat(129) },
  { path: "/v1/messages", body: messages, headers: {}, invalid: "bad thread" },
]

test.each(scenarios)("attributes $path client session as $expected without using it for resume", async ({ path, body, headers, expected, invalid }) => {
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  const fallback = `telemetry:${randomUUID()}`
  try {
    const response = await proxy.app.fetch(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-meridian-session": invalid ?? fallback, ...headers },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: false, ...body }),
    }))
    expect(response.status).toBe(200)
    await response.json()
    const history = await proxy.app.fetch(new Request("http://localhost/telemetry/requests?limit=1"))
    const [metric] = await history.json() as RequestMetric[]
    expect(metric).toBeDefined()
    expect(metric?.clientSessionId).toBe(expected === "fallback" ? fallback : expected)
    expect(lookupSharedSession(fallback)).toBeUndefined()
  } finally {
    await proxy.closeBackend?.()
  }
})

test("attributes Claude warm work to Meridian, not the client that requested it", async () => {
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  try {
    const response = await proxy.app.fetch(new Request("http://localhost/profiles/default/warm", {
      method: "POST",
      headers: { "x-meridian-client": "voice-ai", "x-meridian-purpose": "chat", "x-meridian-session": "thread" },
    }))
    expect(response.status).toBe(200)
    await response.json()
    const history = await proxy.app.fetch(new Request("http://localhost/telemetry/requests?limit=1"))
    const [metric] = await history.json() as RequestMetric[]
    expect(metric).toMatchObject({ client: { name: "meridian" }, purpose: "warm" })
    expect(metric?.clientSessionId).toBeUndefined()
  } finally {
    await proxy.closeBackend?.()
  }
})
