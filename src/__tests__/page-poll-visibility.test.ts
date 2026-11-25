import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"
import { providerPageHtml } from "../telemetry/providerPage"

// These pages poll /v1/usage/quota/all (/providers through /providers/view),
// which reaches Anthropic for every profile once Meridian's 30 s usage cache
// lapses. Run each page's actual poll function against a fixture document
// instead of restating its condition.
function pageFunction(html: string, name: string): string {
  const source = html.match(new RegExp(`^(?:async )?function ${name}\\(\\)[^]*?^\\}`, "m"))?.[0]
  if (!source) throw new Error(`Missing rendered page function ${name}`)
  return source
}

function tick(html: string, name: string, visibilityState: string) {
  const fixture = {
    refreshes: 0, timers: 0,
    document: { visibilityState },
    meridianReorder: { dragging: () => false },
    meridianProfileTable: { dragging: () => false },
    meridianProfileActions: { busy: () => false },
    infoPopOpen: () => false,
    activeLogin: null, activeAdd: null, activeChatGptRelogin: null, redeemingReset: null,
    updatePollTimer: null as unknown,
    refresh: () => { fixture.refreshes++ },
    loadProviders: () => { fixture.refreshes++ },
    setTimeout: () => ++fixture.timers,
  }
  runInNewContext(`${pageFunction(html, name)}\n${name}();`, fixture)
  return fixture
}

for (const [page, html] of Object.entries({ landingHtml, profilePageHtml, providerPageHtml })) {
  test(`${page} skips the usage poll while its tab is hidden`, () => {
    expect(tick(html, "pollRefresh", "hidden").refreshes).toBe(0)
    expect(tick(html, "pollRefresh", "visible").refreshes).toBe(1)
  })

  test(`${page} runs its timed poll and its visibilitychange refresh through that guard`, () => {
    expect(html).toMatch(/setInterval\(pollRefresh, ?10000\)/)
    expect(html).toMatch(/addEventListener\('visibilitychange', ?pollRefresh\)/)
  })
}

test("profilePageHtml holds the updating-card poll while hidden and resumes it when shown", () => {
  expect(profilePageHtml).toMatch(/if \(anyUpdating && !updatePollTimer\) \{\s*updatePollTimer = setTimeout\(pollUpdate, 1500\)/)
  const hidden = tick(profilePageHtml, "pollUpdate", "hidden")
  expect(hidden.refreshes).toBe(0)
  expect(hidden.updatePollTimer).toBe(1)
  const visible = tick(profilePageHtml, "pollUpdate", "visible")
  expect(visible.refreshes).toBe(1)
  expect(visible.updatePollTimer).toBeNull()
})

test("profilePageHtml holds its poll while a free reset is being redeemed", () => {
  const fixture = {
    refreshes: 0,
    document: { visibilityState: "visible" },
    meridianReorder: { dragging: () => false },
    meridianProfileTable: { dragging: () => false },
    activeLogin: null, activeAdd: null, activeChatGptRelogin: null, redeemingReset: "sub1",
    meridianProfileActions: { busy: () => false },
    refresh: () => { fixture.refreshes++ },
  }
  runInNewContext(`${pageFunction(profilePageHtml, "pollRefresh")}\npollRefresh();`, fixture)
  expect(fixture.refreshes).toBe(0)
})

test("an in-flight Home refresh failure does not replace the table during a column drag", async () => {
  const health = Promise.withResolvers<Response>()
  let dragging = false
  const content = { innerHTML: '<div draggable="true">Name</div>' }
  const running = runInNewContext(`${pageFunction(landingHtml, "refresh")}\nrefresh();`, {
    infoPopOpen: () => false,
    meridianProfileTable: { dragging: () => dragging },
    document: { getElementById: () => content },
    fetch: (path: string) => path === "/health" ? health.promise : Promise.resolve(Response.json({})),
  })

  dragging = true
  health.reject(new Error("connection dropped"))
  await running

  expect(content.innerHTML).toBe('<div draggable="true">Name</div>')
})

// The refresh redraws the card itself when its read ends; a poll landing in
// between would draw the old figures over the spinner.
for (const [page, html] of Object.entries({ landingHtml, profilePageHtml })) {
  test(`${page} holds its poll while a usage refresh runs`, () => {
    const fixture = {
      refreshes: 0,
      document: { visibilityState: "visible" },
      meridianReorder: { dragging: () => false },
      meridianProfileTable: { dragging: () => false },
      meridianProfileActions: { busy: () => true },
      infoPopOpen: () => false,
      activeLogin: null, activeAdd: null, activeChatGptRelogin: null, redeemingReset: null,
      refresh: () => { fixture.refreshes++ },
    }
    runInNewContext(`${pageFunction(html, "pollRefresh")}\npollRefresh();`, fixture)
    expect(fixture.refreshes).toBe(0)
  })
}
