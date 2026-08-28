import type { BobDiscoveredModel } from "./catalog.ts"
import type { BobRate } from "./rates.ts"
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  env,
  envCsv,
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

/**
 * Prices a model in Bobcoins per million tokens.
 *
 * OpenCode multiplies these by the token counts to fill its cost column, which
 * would otherwise stay at zero for every Bob model. Cache tokens are charged at
 * the input rate, which is what Bob's usage payload implies.
 */
function bobcoinCost(
  catalog: { input: number; output: number; cacheRead: number; cacheWrite: number },
  rate?: BobRate,
): { input: number; output: number; cache_read: number; cache_write: number } {
  const declared = catalog.input > 0 || catalog.output > 0
  if (declared || !rate) {
    return {
      input: catalog.input,
      output: catalog.output,
      cache_read: catalog.cacheRead,
      cache_write: catalog.cacheWrite,
    }
  }
  return { input: rate.input, output: rate.output, cache_read: rate.input, cache_write: rate.input }
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
export function buildModels(
  discovered?: BobDiscoveredModel[],
  rates: Record<string, BobRate> = {},
): Record<string, ProviderModelConfig> {
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
        cost: bobcoinCost(model.cost, rates[model.id]),
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
      cost: bobcoinCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, rates[id]),
      limit: {
        context: context ?? DEFAULT_CONTEXT_WINDOW,
        output: maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      modalities: { input: input ?? ["text"], output: ["text"] },
    }
  }
  return entries
}
