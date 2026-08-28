import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  env,
  envInt,
  errorMessage,
  log,
  providerBaseUrl,
  routingHeaders,
  type BobRouting,
} from "./env.ts"

export interface BobDiscoveredModel {
  id: string
  /** Backend route behind the alias. Bob only reports it on some catalog views. */
  backend?: string
  reasoning: boolean
  supportsVision: boolean
  contextWindow?: number
  maxTokens?: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

interface CachedCatalog {
  updated: number
  baseUrl: string
  models: BobDiscoveredModel[]
}

const MAX_RESPONSE_BYTES = 1_048_576
const MAX_CATALOG_ENTRIES = 500
const MAX_CATALOG_LABEL_LENGTH = 512
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Bob reports prices per token; models.dev and OpenCode display them per million tokens. */
export function perMillionCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  const scaled = value * 1_000_000
  return Number.isFinite(scaled) ? scaled : 0
}

export function safeLabel(value: unknown): string {
  if (typeof value !== "string") return ""
  const label = value.trim()
  return label && label.length <= MAX_CATALOG_LABEL_LENGTH && !CONTROL_CHARACTER.test(label) ? label : ""
}

export function truncateHttpBody(body: string): string {
  const trimmed = body.trim()
  const truncated = trimmed.length > 512 ? `${trimmed.slice(0, 512)}...` : trimmed
  return truncated.replace(
    CONTROL_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/**
 * Parses Bob's LiteLLM-shaped `/model/info` payload.
 *
 * Only `model_name` and `model_info` are required: the API-key view of the
 * endpoint reports just those, while other views add `litellm_params.model`
 * (the backend route behind the alias) and an `exposed` flag. Routes explicitly
 * marked `exposed: false` or `completion_only: true` are dropped; everything
 * else is kept, and Bob still enforces route access at inference time.
 */
export function parseBobModelCatalog(payload: unknown): BobDiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("IBM Bob model-info response did not contain a data array.")
  }
  if (payload.data.length > MAX_CATALOG_ENTRIES) {
    throw new Error(`IBM Bob model-info response exceeded ${MAX_CATALOG_ENTRIES} entries.`)
  }

  const models: BobDiscoveredModel[] = []
  const seen = new Set<string>()
  let structurallyValidEntries = 0

  for (const entry of payload.data) {
    if (!isRecord(entry) || !isRecord(entry.model_info)) continue
    const id = safeLabel(entry.model_name)
    if (!id) continue
    const backend = isRecord(entry.litellm_params) ? safeLabel(entry.litellm_params.model) : ""
    const exposed = entry.model_info.exposed
    if (exposed !== undefined && typeof exposed !== "boolean") continue
    structurallyValidEntries++

    if (exposed === false || entry.model_info.completion_only === true || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      ...(backend ? { backend } : {}),
      reasoning:
        entry.model_info.supports_reasoning === true ||
        entry.model_info.supports_reasoning_effort === true ||
        entry.model_info.supports_thinking === true,
      supportsVision: entry.model_info.supports_vision === true,
      contextWindow: positiveNumber(entry.model_info.max_input_tokens),
      // `max_tokens` is Bob's configured output cap for the route;
      // `max_output_tokens` is the backend ceiling, used when the cap is absent.
      maxTokens: positiveNumber(entry.model_info.max_tokens) ?? positiveNumber(entry.model_info.max_output_tokens),
      cost: {
        input: perMillionCost(entry.model_info.input_cost_per_token),
        output: perMillionCost(entry.model_info.output_cost_per_token),
        cacheRead: perMillionCost(entry.model_info.cache_read_input_token_cost),
        cacheWrite: perMillionCost(entry.model_info.cache_creation_input_token_cost),
      },
    })
  }

  if (structurallyValidEntries === 0) {
    throw new Error("IBM Bob model-info response contained no structurally valid model entries.")
  }
  if (models.length === 0) {
    throw new Error("IBM Bob model-info response contained no visible models.")
  }
  return models
}

export function sanitizeCatalog(value: unknown): BobDiscoveredModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const models: BobDiscoveredModel[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.cost)) continue
    const id = safeLabel(entry.id)
    const backend = safeLabel(entry.backend)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      ...(backend ? { backend } : {}),
      reasoning: entry.reasoning === true,
      supportsVision: entry.supportsVision === true,
      contextWindow: positiveNumber(entry.contextWindow),
      maxTokens: positiveNumber(entry.maxTokens),
      cost: {
        input: positiveNumber(entry.cost.input) ?? 0,
        output: positiveNumber(entry.cost.output) ?? 0,
        cacheRead: positiveNumber(entry.cost.cacheRead) ?? 0,
        cacheWrite: positiveNumber(entry.cost.cacheWrite) ?? 0,
      },
    })
  }
  return models.length > 0 ? models : undefined
}

export async function readBoundedResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`IBM Bob response exceeded ${MAX_RESPONSE_BYTES} bytes.`)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let body = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`IBM Bob response exceeded ${MAX_RESPONSE_BYTES} bytes.`)
      }
      body += decoder.decode(value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function fetchBobModelCatalog(
  accessToken: string,
  authScheme: string,
  routing?: BobRouting,
): Promise<BobDiscoveredModel[]> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeoutMs = envInt("IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS", DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers: Record<string, string> = {
    ...routingHeaders(undefined, routing),
    Accept: "application/json",
    Authorization: `${authScheme} ${accessToken}`,
  }

  const url = `${providerBaseUrl()}/model/info`
  log(`model discovery -> ${url} (timeout=${timeoutMs}ms)`)
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal })
    if (!response.ok) {
      const body = truncateHttpBody(await readBoundedResponseBody(response))
      throw new Error(`IBM Bob model discovery failed: ${response.status} ${body}`.trim())
    }
    const catalog = parseBobModelCatalog(JSON.parse(await readBoundedResponseBody(response)))
    log(`model discovery ok: ${catalog.length} models in ${Date.now() - startedAt}ms`)
    return catalog
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`IBM Bob model discovery timed out after ${timeoutMs}ms.`)
    log(`model discovery failed in ${Date.now() - startedAt}ms: ${errorMessage(error)}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function cacheFile(): string {
  const explicit = env("IBM_BOB_CATALOG_CACHE")
  if (explicit) return explicit
  const base = env("XDG_CACHE_HOME") ?? join(homedir(), ".cache")
  return join(base, "opencode", "ibm-bob", "catalog.json")
}

/** Cached catalogs are scoped to the base URL that produced them. */
export function readCachedCatalog(): { models: BobDiscoveredModel[]; updated: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile(), "utf8"))
    if (!isRecord(parsed)) return undefined
    if (safeLabel(parsed.baseUrl) !== providerBaseUrl()) return undefined
    const models = sanitizeCatalog(parsed.models)
    if (!models) return undefined
    return { models, updated: positiveNumber(parsed.updated) ?? 0 }
  } catch {
    return undefined
  }
}

export function writeCachedCatalog(models: BobDiscoveredModel[]): void {
  const payload: CachedCatalog = { updated: Date.now(), baseUrl: providerBaseUrl(), models }
  try {
    const file = cacheFile()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    log(`cached ${models.length} models in ${file}`)
  } catch (error) {
    log(`failed to cache the model catalog: ${errorMessage(error)}`)
  }
}
