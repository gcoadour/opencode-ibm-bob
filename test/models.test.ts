import { beforeEach, describe, expect, test } from "bun:test"
import type { BobDiscoveredModel } from "../src/catalog.ts"
import { buildModels, modelName } from "../src/models.ts"
import { resetEnv } from "./helpers.ts"

beforeEach(resetEnv)

const discovered: BobDiscoveredModel[] = [
  {
    id: "premium",
    backend: "anthropic/claude-sonnet-4-5",
    reasoning: false,
    supportsVision: true,
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "flash",
    backend: "flash",
    reasoning: true,
    supportsVision: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
]

describe("fallback catalog", () => {
  test("registers the documented premium default", () => {
    const models = buildModels()

    expect(Object.keys(models)).toEqual(["premium"])
    expect(models.premium).toMatchObject({
      id: "premium",
      name: "IBM Bob Premium",
      tool_call: true,
      reasoning: false,
      attachment: false,
      limit: { context: 200000, output: 8192 },
      modalities: { input: ["text"], output: ["text"] },
    })
  })

  test("honours IBM_BOB_MODELS", () => {
    process.env.IBM_BOB_MODELS = "premium, pro ,bob-3-pro-preview"
    expect(Object.keys(buildModels())).toEqual(["premium", "pro", "bob-3-pro-preview"])
  })

  test("honours limit and capability overrides", () => {
    process.env.IBM_BOB_CONTEXT_WINDOW = "120000"
    process.env.IBM_BOB_MAX_TOKENS = "4096"
    process.env.IBM_BOB_INPUT = "text,image"
    process.env.IBM_BOB_REASONING_MODELS = "premium"

    expect(buildModels().premium).toMatchObject({
      reasoning: true,
      attachment: true,
      limit: { context: 120000, output: 4096 },
      modalities: { input: ["text", "image"], output: ["text"] },
    })
  })
})

describe("discovered catalog", () => {
  test("maps discovered limits, prices and capabilities", () => {
    const models = buildModels(discovered)

    expect(models.premium).toMatchObject({
      name: "IBM Bob Premium (anthropic/claude-sonnet-4-5)",
      attachment: true,
      reasoning: false,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 200000, output: 8192 },
      modalities: { input: ["text", "image"], output: ["text"] },
    })
    expect(models.flash).toMatchObject({
      name: "IBM Bob Flash",
      reasoning: true,
      attachment: false,
      limit: { context: 200000, output: 8192 },
    })
  })

  test("lets environment overrides win over discovered metadata", () => {
    process.env.IBM_BOB_CONTEXT_WINDOW = "150000"
    process.env.IBM_BOB_REASONING = "false"
    process.env.IBM_BOB_INPUT = "text"

    const models = buildModels(discovered)

    expect(models.premium?.limit.context).toBe(150000)
    expect(models.flash?.reasoning).toBe(false)
    expect(models.premium?.modalities.input).toEqual(["text"])
    expect(models.premium?.attachment).toBe(false)
  })
})

test("modelName falls back to a title-cased id", () => {
  expect(modelName("premium")).toBe("IBM Bob Premium")
  expect(modelName("granite-3.2-8b")).toBe("Granite 3 2 8b")
})

describe("Bobcoin pricing", () => {
  test("prices a model with the rate learned from Bob's own charges", () => {
    const models = buildModels(
      [{ id: "premium", reasoning: false, supportsVision: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      { premium: { input: 2, output: 2, samples: 4 } },
    )
    expect(models.premium?.cost).toEqual({ input: 2, output: 2, cache_read: 2, cache_write: 2 })
  })

  test("keeps a price Bob actually declared, rather than the learned one", () => {
    const models = buildModels(
      [{ id: "premium", reasoning: false, supportsVision: false, cost: { input: 3, output: 15, cacheRead: 1, cacheWrite: 2 } }],
      { premium: { input: 2, output: 2, samples: 4 } },
    )
    expect(models.premium?.cost).toEqual({ input: 3, output: 15, cache_read: 1, cache_write: 2 })
  })

  test("leaves an unlearned model at zero", () => {
    const models = buildModels(
      [{ id: "premium", reasoning: false, supportsVision: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      {},
    )
    expect(models.premium?.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
  })

  test("prices fallback models too", () => {
    process.env.IBM_BOB_MODELS = "premium"
    const models = buildModels(undefined, { premium: { input: 2, output: 2, samples: 4 } })
    expect(models.premium?.cost.input).toBe(2)
  })
})
