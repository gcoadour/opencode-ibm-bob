import type { BobDiscoveredModel } from "./catalog.ts"
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  env,
  envCsv,
  log,
  envOptionalBool,
  envOptionalInt,
} from "./env.ts"

export type Modality = "text" | "audio" | "image" | "video" | "pdf"

/** The subset of OpenCode's `provider.models[...]` config entry this plugin fills in. */
export interface ProviderModelConfig {
  id: string
  name: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  cost: {
    input: number
    output: number
    cache_read: number
    cache_write: number
  }
  limit: {
    context: number
    output: number
  }
  modalities: {
    input: Modality[]
    output: Modality[]
  }
}

const KNOWN_NAMES: Record<string, string> = {
  premium: "IBM Bob Premium",
  pro: "IBM Bob Pro",
  flash: "IBM Bob Flash",
  "flash-lite": "IBM Bob Flash Lite",
  "bob-3-pro-preview": "IBM Bob 3 Pro Preview",
}

/** Bobcoins per million tokens. */
export interface BobRate {
  input: number
  output: number
}

/**
 * What a Bobcoin is worth. IBM prices the trial plan's 40 Bobcoins at $20, and
 * Bob publishes no rate of its own, so this is the only conversion available.
 */
export const BOBCOIN_USD = 0.5

/**
 * What Bob charges per model, in Bobcoins per million tokens.
 *
 * Bob publishes no price — every `/model/info` entry reports
 * `input_cost_per_token: 0` — and only reveals the amount on each response, so
 * these were measured against the live `us-east` endpoint and reproduce the
 * reported credits exactly. Override them with `IBM_BOB_RATES` if your account
 * or plan is priced differently.
 */
export const BOBCOIN_RATES: Record<string, BobRate> = {
  premium: { input: 2, output: 2 },
  "premium-ide": { input: 2, output: 2 },
  "premium-shell": { input: 2, output: 2 },
  "sonnet-4.5": { input: 2, output: 2 },
  "wxO-model": { input: 2, output: 2 },
  ultra: { input: 2.5, output: 2.5 },
  fast: { input: 0.8, output: 0.84 },
  explorer: { input: 0.8, output: 0.84 },
  "granite-8b-code-instruct": { input: 0, output: 0 },
  "gpt-oss-20b": { input: 0, output: 0 },
  "openai/gpt-oss-20b": { input: 0, output: 0 },
  "rnj-1-test": { input: 0, output: 0 },
  "rnj-1-nextedit-v1-0": { input: 0, output: 0 },
}

/** `IBM_BOB_RATES` holds `model=input:output` pairs in Bobcoins, e.g. `premium=2:2,fast=0.8:0.84`. */
function rateOverrides(): Record<string, BobRate> {
  const rates: Record<string, BobRate> = {}
  for (const entry of envCsv("IBM_BOB_RATES")) {
    const [id, pair] = entry.split("=", 2)
    const [input, output] = (pair ?? "").split(":", 2).map(Number)
    if (!id || !Number.isFinite(input!) || !Number.isFinite(output!) || input! < 0 || output! < 0) {
      log(`ignoring the malformed IBM_BOB_RATES entry ${JSON.stringify(entry)}`, "warn")
      continue
    }
    rates[id] = { input: input!, output: output! }
  }
  return rates
}

/**
 * Prices a model in dollars per million tokens, so OpenCode's cost column holds
 * real money instead of the flat zero Bob's catalog implies. Rates are measured
 * in Bobcoins, Bob's own billing unit, and converted here. Cache tokens are
 * charged at the input rate.
 */
function bobcoinCost(
  id: string,
  catalog: { input: number; output: number; cacheRead: number; cacheWrite: number },
  overrides: Record<string, BobRate>,
): { input: number; output: number; cache_read: number; cache_write: number } {
  // A price Bob actually declares always wins over the measured table.
  if (catalog.input > 0 || catalog.output > 0) {
    return {
      input: catalog.input,
      output: catalog.output,
      cache_read: catalog.cacheRead,
      cache_write: catalog.cacheWrite,
    }
  }
  const rate = overrides[id] ?? BOBCOIN_RATES[id]
  if (!rate) {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  }
  const input = rate.input * BOBCOIN_USD
  const output = rate.output * BOBCOIN_USD
  return { input, output, cache_read: input, cache_write: input }
}

export function modelName(id: string): string {
  const known = KNOWN_NAMES[id]
  if (known) return known
  return id
    .split(/[/:._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function inputOverride(): Modality[] | undefined {
  if (!env("IBM_BOB_INPUT")) return undefined
  const values = envCsv("IBM_BOB_INPUT", ["text"]).filter(
    (value): value is Modality => value === "text" || value === "image",
  )
  return values.length > 0 ? [...new Set(values)] : ["text"]
}

/**
 * Builds the OpenCode model entries for the Bob provider, from the discovered
 * catalog when one is available and from `IBM_BOB_MODELS` otherwise. Every
 * discovered value can be overridden through the matching environment variable.
 */
export function buildModels(discovered?: BobDiscoveredModel[]): Record<string, ProviderModelConfig> {
  const overrides = rateOverrides()
  const reasoningModels = new Set(envCsv("IBM_BOB_REASONING_MODELS"))
  const reasoning = envOptionalBool("IBM_BOB_REASONING")
  const input = inputOverride()
  const context = envOptionalInt("IBM_BOB_CONTEXT_WINDOW")
  const maxTokens = envOptionalInt("IBM_BOB_MAX_TOKENS")

  const entries: Record<string, ProviderModelConfig> = {}

  if (discovered && discovered.length > 0) {
    for (const model of discovered) {
      const vision = model.supportsVision
      entries[model.id] = {
        id: model.id,
        name: !model.backend || model.backend === model.id ? modelName(model.id) : `${modelName(model.id)} (${model.backend})`,
        attachment: input ? input.includes("image") : vision,
        reasoning: reasoning === true || reasoningModels.has(model.id) || (reasoning === undefined && model.reasoning),
        temperature: true,
        tool_call: true,
        // Bob reports a zero token price and bills in Bobcoins instead, so the
        // rate learned from real responses is used when the catalog says zero.
        cost: bobcoinCost(model.id, model.cost, overrides),
        limit: {
          context: context ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          output: maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS,
        },
        modalities: {
          input: input ?? (vision ? ["text", "image"] : ["text"]),
          output: ["text"],
        },
      }
    }
    return entries
  }

  for (const id of envCsv("IBM_BOB_MODELS", DEFAULT_MODELS)) {
    entries[id] = {
      id,
      name: modelName(id),
      attachment: input?.includes("image") ?? false,
      reasoning: reasoning === true || reasoningModels.has(id),
      temperature: true,
      tool_call: true,
      cost: bobcoinCost(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, overrides),
      limit: {
        context: context ?? DEFAULT_CONTEXT_WINDOW,
        output: maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      modalities: { input: input ?? ["text"], output: ["text"] },
    }
  }
  return entries
}
