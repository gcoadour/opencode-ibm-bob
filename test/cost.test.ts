import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BobSpend, creditsFromBody, extractCredits, fetchBobBudget, formatBobcoins } from "../src/cost.ts"
import { resetEnv } from "./helpers.ts"

const originalFetch = globalThis.fetch

beforeEach(resetEnv)
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("formatBobcoins", () => {
  test("uses Bob Shell's precision ladder", () => {
    expect(formatBobcoins(12.3456)).toBe("12.35")
    expect(formatBobcoins(1)).toBe("1.00")
    expect(formatBobcoins(0.12345)).toBe("0.123")
    expect(formatBobcoins(0.01)).toBe("0.010")
    expect(formatBobcoins(0.0005)).toBe("0.0005")
    expect(formatBobcoins(0)).toBe("0.0000")
  })

  test("keeps a sub-0.0001 request cost visible, which Bob Shell rounds away", () => {
    // The cost Bob actually reported for a one-line completion.
    expect(formatBobcoins(0.00004)).toBe("0.000040")
  })

  test("never prints NaN", () => {
    expect(formatBobcoins(Number.NaN)).toBe("0.0000")
    expect(formatBobcoins(Number.POSITIVE_INFINITY)).toBe("0.0000")
  })
})

describe("extractCredits", () => {
  test("reads the credits Bob reports on a completion", () => {
    // The usage block Bob actually returns, trimmed to what matters here.
    expect(extractCredits({ usage: { credits: 0.00004, total_tokens: 20 } })).toBe(0.00004)
  })

  test("ignores a missing, negative or non-numeric figure", () => {
    expect(extractCredits({ usage: { total_tokens: 20 } })).toBeUndefined()
    expect(extractCredits({ usage: { credits: -1 } })).toBeUndefined()
    expect(extractCredits({ usage: { credits: "0.1" } })).toBeUndefined()
    expect(extractCredits({})).toBeUndefined()
    expect(extractCredits(null)).toBeUndefined()
  })
})

describe("creditsFromBody", () => {
  test("reads a plain JSON completion", () => {
    expect(creditsFromBody(JSON.stringify({ usage: { credits: 0.25 } }))).toBe(0.25)
  })

  test("reads the last usage chunk of an SSE stream", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"bob"}}]}',
      'data: {"choices":[{"delta":{"content":"-ok"}}]}',
      'data: {"usage":{"credits":0.5,"total_tokens":20}}',
      "data: [DONE]",
      "",
    ].join("\n")
    expect(creditsFromBody(body)).toBe(0.5)
  })

  test("survives a truncated chunk", () => {
    const body = ['data: {"usage":{"credits":0.5}}', 'data: {"choices":[{"delta"', ""].join("\n")
    expect(creditsFromBody(body)).toBe(0.5)
  })

  test("returns nothing for a body without usage", () => {
    expect(creditsFromBody("")).toBeUndefined()
    expect(creditsFromBody("not json")).toBeUndefined()
    expect(creditsFromBody('data: {"choices":[]}')).toBeUndefined()
  })
})

describe("BobSpend", () => {
  test("accumulates what each response reports", () => {
    const spend = new BobSpend()
    spend.record(0.25)
    spend.record(0.5)
    expect(spend.total).toBe(0.75)
    expect(spend.count).toBe(2)
  })

  test("reads a JSON response without consuming it", async () => {
    const spend = new BobSpend()
    const response = new Response(JSON.stringify({ usage: { credits: 0.125 } }), {
      headers: { "content-type": "application/json" },
    })

    spend.observe(response)
    // The response OpenCode receives must still be readable.
    expect(await response.json()).toEqual({ usage: { credits: 0.125 } })
    await Bun.sleep(5)
    expect(spend.total).toBe(0.125)
  })

  test("reads a streamed response without consuming it", async () => {
    const spend = new BobSpend()
    const body = 'data: {"usage":{"credits":0.75}}\ndata: [DONE]\n'
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } })

    spend.observe(response)
    expect(await response.text()).toBe(body)
    await Bun.sleep(5)
    expect(spend.total).toBe(0.75)
  })

  test("ignores responses that cannot carry a cost", async () => {
    const spend = new BobSpend()
    spend.observe(new Response("hello", { headers: { "content-type": "text/plain" } }))
    await Bun.sleep(5)
    expect(spend.count).toBe(0)
  })
})

describe("fetchBobBudget", () => {
  test("reads the member's usage from the admin service", async () => {
    let seenUrl = ""
    let seenAuth: string | undefined
    let seenInstance: string | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      seenAuth = (init?.headers as Record<string, string>).Authorization
      seenInstance = (init?.headers as Record<string, string>)["x-instance-id"]
      return new Response(JSON.stringify({ usage: 0.276374, budget_limit: 40 }))
    }) as unknown as typeof fetch

    expect(await fetchBobBudget("token", "Bearer", { instanceId: "instance-1", teamId: "team-1", instanceUserId: "user-1" })).toEqual({ usage: 0.276374, budgetLimit: 40 })
    expect(seenUrl).toBe("https://api.us-east.bob.ibm.com/admin/v1/teams/team-1/users/user-1")
    expect(seenAuth).toBe("Bearer token")
    // This route rejects a request without the instance header.
    expect(seenInstance).toBe("instance-1")
  })

  test("keeps a null budget limit out of the result", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ usage: 0.5, budget_limit: null }))) as unknown as typeof fetch

    expect(await fetchBobBudget("token", "Bearer", { instanceId: "instance-1", teamId: "team-1", instanceUserId: "user-1" })).toEqual({ usage: 0.5 })
  })

  test("rejects a payload with no usage figure", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ email: "someone" }))) as unknown as typeof fetch
    await expect(fetchBobBudget("token", "Bearer", { instanceId: "instance-1", teamId: "team-1", instanceUserId: "user-1" })).rejects.toThrow(/usage figure/)
  })

  test("reports an HTTP failure with the response body", async () => {
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch
    await expect(fetchBobBudget("token", "Bearer", { instanceId: "instance-1", teamId: "team-1", instanceUserId: "user-1" })).rejects.toThrow(/403 denied/)
  })
})
