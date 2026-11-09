import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import plugin from "../src/index.ts"
import tuiModule from "../src/tui.tsx"
import { API_KEY_ENV, SSO_METHOD_ID, setup, toModelInfo, v2Package } from "../src/v2.ts"
import { buildModels } from "../src/models.ts"
import { jwt, modelInfoEntry, resetEnv } from "./helpers.ts"

const originalFetch = globalThis.fetch

type Connection = { type: "credential"; id: string } | { type: "env"; name: string }
type Credential = { type: "oauth"; access: string; refresh: string; expires: number; methodID: string } | { type: "key"; key: string }

/**
 * Stands in for OpenCode V2's plugin context: transforms are captured so each
 * test can fold them over its own editor, and hooks are captured by name.
 */
function fakeContext(options: { connection?: Connection; credential?: Credential } = {}) {
  const transforms: Record<string, ((editor: any) => void)[]> = {}
  const hooks: Record<string, (event: any) => Promise<void> | void> = {}
  const hookOptions: Record<string, unknown> = {}
  let reloads = 0
  const transform = (domain: string) => async (callback: (editor: any) => void) => {
    ;(transforms[domain] ??= []).push(callback)
    return { dispose: async () => {} }
  }
  const ctx = {
    integration: {
      transform: transform("integration"),
      connection: {
        active: async () => options.connection,
        resolve: async () => options.credential,
      },
    },
    provider: {
      transform: transform("provider"),
      reload: async () => {
        reloads++
      },
    },
    tool: { transform: transform("tool") },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void, scope?: unknown) => {
        hooks[name] = callback
        hookOptions[name] = scope
        return { dispose: async () => {} }
      },
    },
  }
  return {
    ctx: ctx as never,
    transforms,
    hooks,
    hookOptions,
    get reloads() {
      return reloads
    },
  }
}

/** A minimal provider editor, shaped like the one OpenCode hands to `ctx.provider.transform`. */
function providerEditor(initial?: { info: Record<string, any>; models: Record<string, any>[] }) {
  const records = new Map<string, { provider: Record<string, any>; models: Map<string, Record<string, any>> }>()
  if (initial) {
    records.set(initial.info.id, {
      provider: structuredClone(initial.info),
      models: new Map(initial.models.map((model) => [model.id, model])),
    })
  }
  return {
    records,
    get: (id: string) => records.get(id),
    add: ({ info, models }: { info: Record<string, any>; models: Record<string, any>[] }) => {
      records.set(info.id, { provider: structuredClone(info), models: new Map(models.map((m) => [m.id, m])) })
    },
    update: (id: string, update: (provider: Record<string, any>) => void) => update(records.get(id)!.provider),
    models: {
      update: (providerID: string, modelID: string, update: (model: Record<string, any>) => void) => {
        const model: Record<string, any> = {}
        update(model)
        records.get(providerID)!.models.set(modelID, model)
      },
    },
  }
}

function integrationEditor() {
  const methods: any[] = []
  const names: Record<string, string> = {}
  return {
    methods,
    names,
    method: { update: (input: any) => methods.push(input) },
    update: (id: string, update: (integration: { id: string; name: string }) => void) => {
      const integration = { id, name: id }
      update(integration)
      names[id] = integration.name
    },
  }
}

beforeEach(() => {
  resetEnv()
  process.env.IBM_BOB_DISCOVER_PROFILE = "false"
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("module shape", () => {
  test("the server module exports both the V1 and the V2 entry points", () => {
    expect(plugin.id).toBe("opencode-ibm-bob")
    expect(typeof plugin.server).toBe("function")
    expect(plugin.setup).toBe(setup)
  })

  test("the TUI module exports both the V1 and the V2 entry points", () => {
    expect(tuiModule.id).toBe("ibm-bob-sidebar")
    expect(typeof tuiModule.tui).toBe("function")
    expect(typeof tuiModule.setup).toBe("function")
  })
})

describe("V2 provider", () => {
  test("registers the Bob provider with the fallback catalog and a native package", async () => {
    const fake = fakeContext()
    await setup(fake.ctx)

    const editor = providerEditor()
    for (const callback of fake.transforms.provider!) callback(editor)
    const record = editor.records.get("ibm-bob")!

    expect(record.provider).toMatchObject({
      id: "ibm-bob",
      integrationID: "ibm-bob",
      name: "IBM Bob",
      activation: "auto",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://api.us-east.bob.ibm.com/inference/v1" },
    })
    expect(record.provider.headers["User-Agent"]).toStartWith("opencode-ibm-bob/")
    expect([...record.models.keys()]).toEqual(["premium"])
    expect(record.models.get("premium")).toMatchObject({
      providerID: "ibm-bob",
      modelID: "premium",
      enabled: true,
      limit: { context: 200_000, output: 8192 },
      cost: [{ input: 1, output: 1, cache: { read: 1, write: 1 } }],
    })
  })

  test("keeps what opencode.json declared for the provider", async () => {
    const fake = fakeContext()
    await setup(fake.ctx)

    const editor = providerEditor({
      info: {
        id: "ibm-bob",
        name: "ibm-bob",
        activation: "enabled",
        package: "",
        settings: { baseURL: "https://gateway.example/v1" },
        headers: { "x-team-id": "pinned" },
      },
      models: [{ id: "premium", name: "Pinned premium" }],
    })
    for (const callback of fake.transforms.provider!) callback(editor)
    const record = editor.records.get("ibm-bob")!

    expect(record.provider.settings.baseURL).toBe("https://gateway.example/v1")
    expect(record.provider.headers["x-team-id"]).toBe("pinned")
    expect(record.provider.name).toBe("IBM Bob")
    expect(record.provider.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(record.models.get("premium")!.name).toBe("Pinned premium")
  })

  test("maps IBM_BOB_API and IBM_BOB_NPM to a V2 package", () => {
    expect(v2Package("anthropic-messages")).toBe("@opencode/ai/providers/anthropic")
    expect(v2Package("openai-responses")).toBe("@opencode/ai/providers/openai")
    process.env.IBM_BOB_NPM = "@ai-sdk/openai-compatible"
    expect(v2Package("openai-completions")).toBe("aisdk:@ai-sdk/openai-compatible")
    process.env.IBM_BOB_NPM = "@opencode/ai/providers/openai-compatible"
    expect(v2Package("openai-completions")).toBe("@opencode/ai/providers/openai-compatible")
  })

  test("converts a model entry into a V2 Model.Info", () => {
    const info = toModelInfo(buildModels([])["premium"]!)
    expect(info).toMatchObject({
      id: "premium",
      capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true },
      variants: [],
      status: "active",
    })
  })

  test("swaps in the catalog discovered with the stored credential", async () => {
    let calls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++
      expect(String(input)).toBe("https://api.us-east.bob.ibm.com/inference/v1/model/info")
      return new Response(JSON.stringify({ data: [modelInfoEntry(), modelInfoEntry({ model_name: "flash", exposed: true })] }))
    }) as unknown as typeof fetch
    const fake = fakeContext({ connection: { type: "credential", id: "c1" }, credential: { type: "key", key: "stored" } })
    await setup(fake.ctx)
    // The refresh runs in the background once setup returns.
    for (let i = 0; i < 20 && fake.reloads === 0; i++) await Bun.sleep(5)

    expect(calls).toBe(1)
    expect(fake.reloads).toBe(1)
    const editor = providerEditor()
    for (const callback of fake.transforms.provider!) callback(editor)
    expect([...editor.records.get("ibm-bob")!.models.keys()]).toEqual(["premium", "flash"])
  })

  test("does nothing when IBM_BOB_ENABLED=false", async () => {
    process.env.IBM_BOB_ENABLED = "false"
    const fake = fakeContext()
    await setup(fake.ctx)
    expect(fake.transforms).toEqual({})
  })
})

describe("V2 integration", () => {
  test("offers SSO, a stored API key and the env names", async () => {
    const fake = fakeContext()
    await setup(fake.ctx)
    const editor = integrationEditor()
    for (const callback of fake.transforms.integration!) callback(editor)

    expect(editor.names["ibm-bob"]).toBe("IBM Bob")
    expect(editor.methods.map((entry) => entry.method)).toEqual([
      { id: SSO_METHOD_ID, type: "oauth", label: "IBM Bob SSO (browser)" },
      { type: "key", label: "IBM Bob API key" },
      { type: "env", names: [...API_KEY_ENV] },
    ])
    expect(editor.methods.every((entry) => entry.integrationID === "ibm-bob")).toBe(true)
  })

  test("refreshes an SSO credential through Bob's refresh endpoint", async () => {
    const renewed = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input))
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "r1" })
      return new Response(JSON.stringify({ token: renewed, refresh_token: "r2" }))
    }) as unknown as typeof fetch
    const fake = fakeContext()
    await setup(fake.ctx)
    const editor = integrationEditor()
    for (const callback of fake.transforms.integration!) callback(editor)

    const sso = editor.methods.find((entry) => entry.method.type === "oauth")
    const next = await sso.refresh({ type: "oauth", methodID: SSO_METHOD_ID, access: "old", refresh: "r1", expires: 0 })

    expect(calls).toEqual(["https://api.us-east.bob.ibm.com/authn/v1/auth/refresh"])
    expect(next).toEqual({ type: "oauth", methodID: SSO_METHOD_ID, access: renewed, refresh: "r2", expires: expect.any(Number) })
  })
})

describe("V2 request hooks", () => {
  test("rewrites an API key to Bob's Apikey scheme, scoped to the Bob provider", async () => {
    process.env.IBM_BOB_TEAM_ID = "team-1"
    const fake = fakeContext()
    await setup(fake.ctx)
    expect(fake.hookOptions["http.request"]).toEqual({ providerID: "ibm-bob" })

    const request = new Request("https://api.us-east.bob.ibm.com/inference/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer bob-key", "content-type": "application/json" },
      body: "{}",
    })
    const event = { request }
    await fake.hooks["http.request"]!(event)

    expect(event.request.headers.get("authorization")).toBe("Apikey bob-key")
    expect(event.request.headers.get("x-team-id")).toBe("team-1")
    expect(event.request.headers.get("content-type")).toBe("application/json")
  })

  test("keeps an SSO token as Bearer and routes it to the token's instance", async () => {
    const token = jwt({ instances: [{ id: "inst-1" }], exp: Math.floor(Date.now() / 1000) + 3600 })
    const fake = fakeContext()
    await setup(fake.ctx)

    const event = { request: new Request("https://example.test/", { headers: { "x-api-key": token } }) }
    await fake.hooks["http.request"]!(event)

    expect(event.request.headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(event.request.headers.get("x-api-key")).toBeNull()
    expect(event.request.headers.get("x-instance-id")).toBe("inst-1")
  })

  test("records the Bobcoins a response reports, for the bob_usage tool", async () => {
    const fake = fakeContext()
    await setup(fake.ctx)
    const tools: any[] = []
    for (const callback of fake.transforms.tool!) callback({ add: (tool: any) => tools.push(tool) })
    expect(tools.map((tool) => tool.name)).toEqual(["bob_usage"])

    await fake.hooks["http.response"]!({
      response: new Response(JSON.stringify({ usage: { credits: 0.5, prompt_tokens: 1, completion_tokens: 1 } }), {
        headers: { "content-type": "application/json" },
      }),
    })
    await Bun.sleep(10)

    const result = await tools[0].execute({}, {})
    expect(result.content).toContain("This session so far: 0.500 Bobcoins ($0.25) over 1 billed response(s).")
  })
})
