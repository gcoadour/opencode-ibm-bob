import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IbmBobPlugin } from "../src/index.ts"
import { jwt, modelInfoEntry, resetEnv } from "./helpers.ts"

const originalFetch = globalThis.fetch
let cacheDir: string
let stored: unknown[]

/** Stands in for the OpenCode SDK client the plugin receives. */
function pluginInput() {
  stored = []
  return {
    client: {
      auth: {
        set: async (options: unknown) => {
          stored.push(options)
          return true
        },
      },
    },
  } as never
}

async function config(hooks: Awaited<ReturnType<typeof IbmBobPlugin>>) {
  const input: { provider?: Record<string, any> } = {}
  await hooks.config!(input as never)
  return input.provider!["ibm-bob"]
}

beforeEach(() => {
  resetEnv()
  cacheDir = mkdtempSync(join(tmpdir(), "ibm-bob-plugin-"))
  process.env.IBM_BOB_CATALOG_CACHE = join(cacheDir, "catalog.json")
  process.env.IBM_BOB_PROFILE_CACHE = join(cacheDir, "profile.json")
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(cacheDir, { recursive: true, force: true })
})

describe("config hook", () => {
  test("registers the Bob provider with the fallback catalog", async () => {
    const provider = await config(await IbmBobPlugin(pluginInput()))

    expect(provider.name).toBe("IBM Bob")
    expect(provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(provider.env).toEqual(["IBM_BOB_API_KEY", "IBM_BOB_KEY"])
    expect(Object.keys(provider.models)).toEqual(["premium"])
    expect(provider.options.baseURL).toBe("https://api.us-east.bob.ibm.com/inference/v1")
    expect(typeof provider.options.fetch).toBe("function")
  })

  test("uses the discovered catalog when an API key is configured", async () => {
    process.env.IBM_BOB_API_KEY = "bob-key"
    let seen: Record<string, string> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.us-east.bob.ibm.com/inference/v1/model/info")
      seen = init?.headers as Record<string, string>
      return new Response(
        JSON.stringify({ data: [modelInfoEntry(), modelInfoEntry({ model_name: "flash", exposed: true })] }),
      )
    }) as unknown as typeof fetch

    const provider = await config(await IbmBobPlugin(pluginInput()))

    expect(seen.Authorization).toBe("Apikey bob-key")
    expect(Object.keys(provider.models)).toEqual(["premium", "flash"])
    expect(provider.options.apiKey).toBe("bob-key")
  })

  test("falls back to the cached catalog when discovery fails", async () => {
    process.env.IBM_BOB_API_KEY = "bob-key"
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [modelInfoEntry({ model_name: "pro" })] }))) as unknown as typeof fetch
    await config(await IbmBobPlugin(pluginInput()))

    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    const provider = await config(await IbmBobPlugin(pluginInput()))

    expect(Object.keys(provider.models)).toEqual(["pro"])
  })

  test("skips discovery when IBM_BOB_DISCOVER_MODELS is off", async () => {
    process.env.IBM_BOB_API_KEY = "bob-key"
    process.env.IBM_BOB_DISCOVER_MODELS = "false"
    globalThis.fetch = (async () => {
      throw new Error("discovery should not run")
    }) as unknown as typeof fetch

    expect(Object.keys((await config(await IbmBobPlugin(pluginInput()))).models)).toEqual(["premium"])
  })

  test("leaves user configuration in place", async () => {
    const hooks = await IbmBobPlugin(pluginInput())
    const input = {
      provider: {
        "ibm-bob": {
          name: "Bob (corp)",
          models: { premium: { name: "Pinned premium" } },
          options: { baseURL: "https://bob.internal/inference/v1" },
        },
      },
    }

    await hooks.config!(input as never)
    const provider = input.provider["ibm-bob"] as any

    expect(provider.name).toBe("Bob (corp)")
    expect(provider.models.premium.name).toBe("Pinned premium")
    expect(provider.options.baseURL).toBe("https://bob.internal/inference/v1")
    expect(typeof provider.options.fetch).toBe("function")
  })

  test("registers nothing when IBM_BOB_ENABLED is off", async () => {
    process.env.IBM_BOB_ENABLED = "false"
    const hooks = await IbmBobPlugin(pluginInput())
    const input: { provider?: Record<string, unknown> } = {}

    await hooks.config!(input as never)
    expect(input.provider).toBeUndefined()
  })
})

describe("auth hook", () => {
  test("advertises SSO and API-key login for the Bob provider", async () => {
    const hooks = await IbmBobPlugin(pluginInput())

    expect(hooks.auth?.provider).toBe("ibm-bob")
    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["oauth", "api"])
  })

  test("returns no options when OpenCode has no stored credential", async () => {
    const hooks = await IbmBobPlugin(pluginInput())
    expect(await hooks.auth!.loader!(async () => undefined as never, {} as never)).toEqual({})
  })

  test("uses a stored API key as-is", async () => {
    const hooks = await IbmBobPlugin(pluginInput())
    const options = await hooks.auth!.loader!(async () => ({ type: "api", key: "stored-key" }) as never, {} as never)

    expect(options.apiKey).toBe("stored-key")
    expect(options.baseURL).toBe("https://api.us-east.bob.ibm.com/inference/v1")
    expect(typeof options.fetch).toBe("function")
  })

  test("keeps a valid SSO token and refreshes an expired one", async () => {
    process.env.IBM_BOB_DISCOVER_MODELS = "false"
    const valid = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const hooks = await IbmBobPlugin(pluginInput())

    const fresh = await hooks.auth!.loader!(
      async () => ({ type: "oauth", access: valid, refresh: "r1", expires: Date.now() + 3600_000 }) as never,
      {} as never,
    )
    expect(fresh.apiKey).toBe(valid)

    const renewed = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ token: renewed, refresh_token: "r2" }))
    }) as unknown as typeof fetch

    const refreshed = await hooks.auth!.loader!(
      async () => ({ type: "oauth", access: "expired", refresh: "r1", expires: Date.now() - 1000 }) as never,
      {} as never,
    )

    expect(calls).toEqual(["https://api.us-east.bob.ibm.com/authn/v1/auth/refresh"])
    expect(refreshed.apiKey).toBe(renewed)
    expect(stored).toEqual([
      {
        path: { id: "ibm-bob" },
        body: { type: "oauth", access: renewed, refresh: "r2", expires: expect.any(Number) },
      },
    ])
  })

  test("keeps working with the stale token when the refresh call fails", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch
    const hooks = await IbmBobPlugin(pluginInput())

    const options = await hooks.auth!.loader!(
      async () => ({ type: "oauth", access: "stale", refresh: "r1", expires: Date.now() - 1000 }) as never,
      {} as never,
    )

    expect(options.apiKey).toBe("stale")
    expect(stored).toEqual([])
  })
})
