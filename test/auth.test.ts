import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  BobTokenResolver,
  applyBobAuthHeaders,
  buildLoginUrl,
  createBobFetch,
  credentialsFromTokenResponse,
  jwtExpiry,
  readInstanceFromJwt,
} from "../src/auth.ts"
import { BobProfileResolver } from "../src/profile.ts"
import { jwt, resetEnv } from "./helpers.ts"

const originalFetch = globalThis.fetch

beforeEach(resetEnv)
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("applyBobAuthHeaders", () => {
  test("sends API keys with Bob's Apikey scheme", () => {
    const headers = applyBobAuthHeaders({ Authorization: "Bearer sdk-placeholder" }, "bob-key")
    expect(headers).toEqual({ Authorization: "Apikey bob-key" })
  })

  test("sends SSO tokens as bearer tokens", () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    expect(applyBobAuthHeaders({}, token)).toEqual({ Authorization: `Bearer ${token}` })
  })

  test("honours IBM_BOB_AUTH_SCHEME for non-JWT credentials", () => {
    process.env.IBM_BOB_AUTH_SCHEME = "Bearer"
    expect(applyBobAuthHeaders({}, "bob-key")).toEqual({ Authorization: "Bearer bob-key" })
  })

  test("replaces the x-api-key header the Anthropic adapter sends", () => {
    const headers = applyBobAuthHeaders({ "x-api-key": "sdk-placeholder", "x-team-id": "team" }, "bob-key")
    expect(headers).toEqual({ "x-team-id": "team", Authorization: "Apikey bob-key" })
  })

  test("reuses an existing credential when no token is resolved", () => {
    expect(applyBobAuthHeaders({ "x-api-key": "from-sdk" })).toEqual({ Authorization: "Apikey from-sdk" })
    expect(applyBobAuthHeaders({})).toEqual({})
  })
})

describe("BobTokenResolver", () => {
  test("prefers stored credentials over the environment key", async () => {
    process.env.IBM_BOB_API_KEY = "env-key"
    const resolver = new BobTokenResolver()
    resolver.registerStored(async () => "stored-token")
    expect(await resolver.resolve()).toBe("stored-token")
  })

  test("falls back to IBM_BOB_API_KEY, then IBM_BOB_KEY", async () => {
    const resolver = new BobTokenResolver()
    expect(await resolver.resolve()).toBeUndefined()

    process.env.IBM_BOB_KEY = "alias-key"
    expect(await resolver.resolve()).toBe("alias-key")

    process.env.IBM_BOB_API_KEY = "primary-key"
    expect(await resolver.resolve()).toBe("primary-key")
  })

  test("falls back to the environment key when the stored source fails", async () => {
    process.env.IBM_BOB_API_KEY = "env-key"
    const resolver = new BobTokenResolver()
    resolver.registerStored(async () => {
      throw new Error("auth store unavailable")
    })
    expect(await resolver.resolve()).toBe("env-key")
  })
})

describe("createBobFetch", () => {
  test("attaches the credential and the routing headers to every request", async () => {
    process.env.IBM_BOB_INSTANCE_ID = "instance-1"
    process.env.IBM_BOB_TEAM_ID = "team-1"
    process.env.IBM_BOB_USER_AGENT = "opencode-ibm-bob/test"
    process.env.IBM_BOB_API_KEY = "bob-key"

    let seen: Record<string, string> = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers as Record<string, string>
      return new Response("{}")
    }) as unknown as typeof fetch

    const request = createBobFetch(new BobTokenResolver())
    await request("https://api.us-east.bob.ibm.com/inference/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sdk-placeholder", "content-type": "application/json" },
      body: "{}",
    })

    expect(seen).toEqual({
      "User-Agent": "opencode-ibm-bob/test",
      "x-instance-id": "instance-1",
      "x-team-id": "team-1",
      "content-type": "application/json",
      Authorization: "Apikey bob-key",
    })
  })

  test("derives the instance header from an SSO token when none is configured", async () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, instances: [{ id: "instance-from-jwt" }] })
    process.env.IBM_BOB_API_KEY = token

    let seen: Record<string, string> = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers as Record<string, string>
      return new Response("{}")
    }) as unknown as typeof fetch

    await createBobFetch(new BobTokenResolver())("https://api.us-east.bob.ibm.com/inference/v1/chat/completions")

    expect(seen["x-instance-id"]).toBe("instance-from-jwt")
    expect(seen.Authorization).toBe(`Bearer ${token}`)
  })

  test("adds the team discovered from /admin/v1/profile to an SSO request", async () => {
    // Bob answers `402 team user not found` when an SSO token carries no team,
    // and the JWT never contains one.
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, instances: [{ id: "instance-from-jwt" }] })
    process.env.IBM_BOB_API_KEY = token

    const seen: Record<string, string>[] = []
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      seen.push(init?.headers as Record<string, string>)
      if (String(input).endsWith("/admin/v1/profile")) {
        return new Response(
          JSON.stringify({ instances: [{ instance_id: "instance-1", teams: [{ id: "team-1", name: "default" }] }] }),
        )
      }
      return new Response("{}")
    }) as unknown as typeof fetch

    const request = createBobFetch(new BobTokenResolver(), new BobProfileResolver())
    await request("https://api.us-east.bob.ibm.com/inference/v1/chat/completions", { method: "POST", body: "{}" })

    expect(urls[0]).toBe("https://api.us-east.bob.ibm.com/admin/v1/profile")
    expect(seen[1]?.["x-instance-id"]).toBe("instance-1")
    expect(seen[1]?.["x-team-id"]).toBe("team-1")
    expect(seen[1]?.Authorization).toBe(`Bearer ${token}`)
  })

  test("lets a configured instance and team win over the discovered profile", async () => {
    process.env.IBM_BOB_API_KEY = "bob-key"
    process.env.IBM_BOB_INSTANCE_ID = "configured-instance"
    process.env.IBM_BOB_TEAM_ID = "configured-team"

    let seen: Record<string, string> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/admin/v1/profile")) {
        return new Response(
          JSON.stringify({ instances: [{ instance_id: "discovered", teams: [{ id: "discovered-team" }] }] }),
        )
      }
      seen = init?.headers as Record<string, string>
      return new Response("{}")
    }) as unknown as typeof fetch

    await createBobFetch(new BobTokenResolver(), new BobProfileResolver())(
      "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
    )

    expect(seen["x-instance-id"]).toBe("configured-instance")
    expect(seen["x-team-id"]).toBe("configured-team")
  })

  test("still routes on the JWT instance when profile discovery fails", async () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, instances: [{ id: "instance-from-jwt" }] })
    process.env.IBM_BOB_API_KEY = token

    let seen: Record<string, string> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/admin/v1/profile")) return new Response("denied", { status: 403 })
      seen = init?.headers as Record<string, string>
      return new Response("{}")
    }) as unknown as typeof fetch

    await createBobFetch(new BobTokenResolver(), new BobProfileResolver())(
      "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
    )

    expect(seen["x-instance-id"]).toBe("instance-from-jwt")
    expect(seen["x-team-id"]).toBeUndefined()
  })

  test("keeps the request body and method untouched", async () => {
    let init: RequestInit | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, options?: RequestInit) => {
      init = options
      return new Response("{}")
    }) as unknown as typeof fetch

    await createBobFetch(new BobTokenResolver())("https://bob.example/inference/v1/chat/completions", {
      method: "POST",
      body: '{"model":"premium"}',
    })

    expect(init?.method).toBe("POST")
    expect(init?.body).toBe('{"model":"premium"}')
  })
})

describe("credentials", () => {
  test("derives the expiry from the token, five minutes early", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const credentials = credentialsFromTokenResponse({ token: jwt({ exp }), refresh_token: "r1" })

    expect(credentials.refresh).toBe("r1")
    expect(credentials.expires).toBe(exp * 1000 - 5 * 60 * 1000)
  })

  test("falls back to expires_in and keeps the previous refresh token", () => {
    const credentials = credentialsFromTokenResponse({ token: "opaque", expires_in: 3600 }, "previous")

    expect(credentials.refresh).toBe("previous")
    expect(credentials.expires).toBeGreaterThan(Date.now())
    expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000 - 5 * 60 * 1000)
  })

  test("rejects a response without a token", () => {
    expect(() => credentialsFromTokenResponse({})).toThrow(/did not include an access token/)
  })

  test("reads the expiry and instance out of an SSO token", () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const token = jwt({ exp, instances: [{ id: "instance-1" }] })

    expect(jwtExpiry(token)).toBe(exp * 1000 - 5 * 60 * 1000)
    expect(readInstanceFromJwt(token)).toBe("instance-1")
    expect(readInstanceFromJwt("not-a-jwt")).toBeUndefined()
  })
})

test("buildLoginUrl carries the callback and state", () => {
  const url = new URL(buildLoginUrl("http://localhost:41234/bob-callback", "state-1"))

  expect(url.origin + url.pathname).toBe("https://bob.ibm.com/login")
  expect(url.searchParams.get("callback_uri")).toBe("http://localhost:41234/bob-callback")
  expect(url.searchParams.get("state")).toBe("state-1")
})
