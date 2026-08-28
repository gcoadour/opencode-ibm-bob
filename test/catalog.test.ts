import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cacheFile,
  parseBobModelCatalog,
  perMillionCost,
  readCachedCatalog,
  sanitizeCatalog,
  truncateHttpBody,
  writeCachedCatalog,
} from "../src/catalog.ts"
import { bobApiKeyEntry, modelInfoEntry, resetEnv } from "./helpers.ts"

let cacheDir: string

beforeEach(() => {
  resetEnv()
  cacheDir = mkdtempSync(join(tmpdir(), "ibm-bob-cache-"))
  process.env.IBM_BOB_CATALOG_CACHE = join(cacheDir, "catalog.json")
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

describe("parseBobModelCatalog", () => {
  test("maps LiteLLM model info into discovered models", () => {
    const catalog = parseBobModelCatalog({
      data: [modelInfoEntry({ supports_vision: true, supports_reasoning: true })],
    })

    expect(catalog).toEqual([
      {
        id: "premium",
        backend: "anthropic/claude-sonnet-4-5",
        reasoning: true,
        supportsVision: true,
        contextWindow: 200000,
        maxTokens: 8192,
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      },
    ])
  })

  test("accepts the API-key view, which has no litellm_params and no exposed flag", () => {
    const catalog = parseBobModelCatalog({
      data: [bobApiKeyEntry("premium"), bobApiKeyEntry("granite-8b-code-instruct", { max_tokens: undefined })],
    })

    expect(catalog).toEqual([
      {
        id: "premium",
        reasoning: false,
        supportsVision: true,
        contextWindow: 200000,
        maxTokens: 12000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "granite-8b-code-instruct",
        reasoning: false,
        supportsVision: true,
        contextWindow: 200000,
        maxTokens: 64000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ])
  })

  test("drops completion-only routes, which cannot serve chat", () => {
    const catalog = parseBobModelCatalog({
      data: [bobApiKeyEntry("premium"), bobApiKeyEntry("rnj-1-nextedit-v1-0", { completion_only: true })],
    })

    expect(catalog.map((model) => model.id)).toEqual(["premium"])
  })

  test("converts per-token prices to per-million-token prices", () => {
    expect(perMillionCost(0.000003)).toBeCloseTo(3, 10)
    expect(perMillionCost(0)).toBe(0)
    expect(perMillionCost(-1)).toBe(0)
    expect(perMillionCost("3")).toBe(0)
  })

  test("drops routes explicitly marked as not exposed", () => {
    const catalog = parseBobModelCatalog({
      data: [modelInfoEntry({ model_name: "premium" }), modelInfoEntry({ model_name: "internal", exposed: false })],
    })

    expect(catalog.map((model) => model.id)).toEqual(["premium"])
  })

  test("keeps entries without an exposed flag and de-duplicates ids", () => {
    const catalog = parseBobModelCatalog({
      data: [modelInfoEntry({ model_name: "premium" }), modelInfoEntry({ model_name: "premium" })],
    })

    expect(catalog).toHaveLength(1)
  })

  test("treats reasoning-effort and thinking flags as reasoning support", () => {
    const [effort, thinking] = parseBobModelCatalog({
      data: [
        modelInfoEntry({ model_name: "pro", supports_reasoning_effort: true }),
        modelInfoEntry({ model_name: "flash", supports_thinking: true }),
      ],
    })

    expect(effort?.reasoning).toBe(true)
    expect(thinking?.reasoning).toBe(true)
  })

  test("rejects malformed payloads", () => {
    expect(() => parseBobModelCatalog({})).toThrow(/did not contain a data array/)
    expect(() => parseBobModelCatalog({ data: [{ model_name: "premium" }] })).toThrow(
      /no structurally valid model entries/,
    )
    expect(() => parseBobModelCatalog({ data: [modelInfoEntry({ exposed: false })] })).toThrow(/no visible models/)
    expect(() => parseBobModelCatalog({ data: new Array(501).fill(modelInfoEntry()) })).toThrow(/exceeded 500 entries/)
  })

  test("ignores labels carrying control characters", () => {
    expect(() =>
      parseBobModelCatalog({ data: [modelInfoEntry({ model_name: "prem\u0001ium" })] }),
    ).toThrow(/no structurally valid model entries/)
  })
})

describe("catalog cache", () => {
  const models = [
    {
      id: "premium",
      backend: "anthropic/claude-sonnet-4-5",
      reasoning: false,
      supportsVision: true,
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  ]

  test("round-trips a catalog through the cache file", () => {
    writeCachedCatalog(models)
    expect(readCachedCatalog()?.models).toEqual(models)
    expect(readCachedCatalog()?.updated).toBeGreaterThan(0)
  })

  test("ignores a cache written for another base URL", () => {
    writeCachedCatalog(models)
    process.env.IBM_BOB_BASE_URL = "https://api.dev.bob.ibm.com/inference/v1"
    expect(readCachedCatalog()).toBeUndefined()
  })

  test("ignores an unreadable or malformed cache", () => {
    expect(readCachedCatalog()).toBeUndefined()
    writeFileSync(cacheFile(), "not json")
    expect(readCachedCatalog()).toBeUndefined()
  })

  test("sanitizeCatalog drops entries that lost their shape", () => {
    expect(sanitizeCatalog([{ id: "premium" }, "nope"])).toBeUndefined()
    expect(sanitizeCatalog([{ id: "premium", backend: "b", cost: { input: "x" } }])?.[0]?.cost.input).toBe(0)
  })
})

test("truncateHttpBody escapes control characters and caps the length", () => {
  expect(truncateHttpBody("  oops\u0000  ")).toBe("oops\\u0000")
  expect(truncateHttpBody("x".repeat(600))).toHaveLength(515)
})
