import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER_ID = "ibm-bob"
export const PROVIDER_NAME = "IBM Bob"
export const PLUGIN_VERSION = "0.3.0"

export const DEFAULT_BOB_ORIGIN = "https://api.us-east.bob.ibm.com"
export const DEFAULT_BASE_URL = `${DEFAULT_BOB_ORIGIN}/inference/v1`
export const DEFAULT_WEB_LOGIN_URL = "https://bob.ibm.com/login"
export const DEFAULT_MODELS = ["premium"]
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_MAX_TOKENS = 8192
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 5000
export const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_LOGIN_TIMEOUT_MS = 180_000
export const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_PROFILE_DISCOVERY_TIMEOUT_MS = 5000
export const DEFAULT_PROFILE_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_BUDGET_TIMEOUT_MS = 5000

/** Bob Shell's admin service, which exposes the account's instance/team profile. */
export const ADMIN_SERVICE_PATH = "/admin/v1"

/** Bob's OpenAI-compatible route; `openai-responses` is only useful behind a gateway that exposes it. */
export type BobApi = "openai-completions" | "openai-responses" | "anthropic-messages"

const SUPPORTED_APIS = new Set<BobApi>(["openai-completions", "openai-responses", "anthropic-messages"])

const NPM_BY_API: Record<BobApi, string> = {
  "openai-completions": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  "anthropic-messages": "@ai-sdk/anthropic",
}

export interface BobShellSettings {
  instanceId?: string
  teamId?: string
}

/** The instance/team pair Bob routes a request with. */
export interface BobRouting {
  instanceId?: string
  teamId?: string
}

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function envOptionalInt(name: string): number | undefined {
  const value = env(name)
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function envInt(name: string, fallback: number): number {
  return envOptionalInt(name) ?? fallback
}

export function envOptionalBool(name: string): boolean | undefined {
  const value = env(name)?.toLowerCase()
  if (!value) return undefined
  if (["1", "true", "yes", "y", "on"].includes(value)) return true
  if (["0", "false", "no", "n", "off"].includes(value)) return false
  return undefined
}

export function envBool(name: string, fallback: boolean): boolean {
  return envOptionalBool(name) ?? fallback
}

export function envCsv(name: string, fallback: string[] = []): string[] {
  const value = env(name)
  if (!value) return fallback
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : fallback
}

/**
 * Reads only the non-secret routing metadata Bob Shell keeps in `~/.bob/settings.json`.
 * Stored SSO secrets in that file are never read.
 */
export function readBobShellSettings(): BobShellSettings {
  if (!envBool("IBM_BOB_READ_BOBSHELL_SETTINGS", true)) return {}
  try {
    const raw = readFileSync(join(homedir(), ".bob", "settings.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const ibm = (parsed as { ibm?: { instanceId?: unknown; teamId?: unknown } }).ibm
    return {
      instanceId: typeof ibm?.instanceId === "string" ? ibm.instanceId : undefined,
      teamId: typeof ibm?.teamId === "string" ? ibm.teamId : undefined,
    }
  } catch {
    return {}
  }
}

export function parseApi(): BobApi {
  const requested = env("IBM_BOB_API") ?? "openai-completions"
  if (SUPPORTED_APIS.has(requested as BobApi)) return requested as BobApi
  log(`unsupported IBM_BOB_API=${JSON.stringify(requested)}; falling back to openai-completions.`, "warn")
  return "openai-completions"
}

export function npmPackage(api: BobApi): string {
  return env("IBM_BOB_NPM") ?? NPM_BY_API[api]
}

export function providerBaseUrl(): string {
  return (env("IBM_BOB_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

/**
 * The AI SDK adapters append their own route to `baseURL`
 * (`/chat/completions`, `/responses`, `/messages`), so Bob's
 * `.../inference/v1` base is used verbatim for all three.
 */
export function requestBaseUrl(_api: BobApi = parseApi()): string {
  return providerBaseUrl()
}

export function bobOrigin(): string {
  const explicit = env("IBM_BOB_AUTH_BASE_URL")
  if (explicit) return explicit.replace(/\/+$/, "")
  try {
    return new URL(providerBaseUrl()).origin
  } catch {
    return DEFAULT_BOB_ORIGIN
  }
}

export function adminBaseUrl(): string {
  return `${bobOrigin()}${ADMIN_SERVICE_PATH}`
}

export function bobWebLoginUrl(): string {
  const explicit = env("IBM_BOB_WEB_LOGIN_URL")
  if (explicit) return explicit
  try {
    const host = new URL(bobOrigin()).host
    if (host === "api.dev.bob.ibm.com") return "https://public-dev.bob.ibm.com/login"
    if (host === "api.qa-test.bob.ibm.com") return "https://qa.bob.ibm.com/login"
    return DEFAULT_WEB_LOGIN_URL
  } catch {
    return DEFAULT_WEB_LOGIN_URL
  }
}

export function configuredApiKey(): { envName: "IBM_BOB_API_KEY" | "IBM_BOB_KEY"; value: string } | undefined {
  const primary = env("IBM_BOB_API_KEY")
  if (primary) return { envName: "IBM_BOB_API_KEY", value: primary }
  const alias = env("IBM_BOB_KEY")
  return alias ? { envName: "IBM_BOB_KEY", value: alias } : undefined
}

export function apiKeyAuthScheme(): string {
  return env("IBM_BOB_AUTH_SCHEME") ?? "Apikey"
}

export function userAgent(): string {
  return env("IBM_BOB_USER_AGENT") ?? `opencode-ibm-bob/${PLUGIN_VERSION}`
}

function parseJsonHeaders(): Record<string, string> | undefined {
  const json = env("IBM_BOB_HEADERS_JSON")
  if (!json) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log("IBM_BOB_HEADERS_JSON must be a JSON object; ignoring it.", "warn")
      return undefined
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value
      else log(`header ${JSON.stringify(key)} is not a string; ignoring it.`, "warn")
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  } catch (error) {
    log(`failed to parse IBM_BOB_HEADERS_JSON; ignoring it. ${errorMessage(error)}`, "warn")
    return undefined
  }
}

/** Non-secret instance/team routing headers Bob Shell also sends. */
export function routingHeaders(
  settings: BobShellSettings = readBobShellSettings(),
  discovered?: BobRouting,
): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": userAgent() }
  // Explicit configuration wins, then Bob Shell's settings, then what
  // `/admin/v1/profile` reported for the credential in use.
  const instanceId = env("IBM_BOB_INSTANCE_ID") ?? settings.instanceId ?? discovered?.instanceId
  const teamId = env("IBM_BOB_TEAM_ID") ?? settings.teamId ?? discovered?.teamId
  if (instanceId) headers["x-instance-id"] = instanceId
  if (teamId) headers["x-team-id"] = teamId
  return { ...headers, ...parseJsonHeaders() }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function log(message: string, level: "debug" | "warn" = "debug"): void {
  if (level === "warn") {
    console.warn(`[opencode-ibm-bob] ${message}`)
    return
  }
  if (!envBool("IBM_BOB_DEBUG", false)) return
  console.warn(`[opencode-ibm-bob] ${new Date().toISOString()} ${message}`)
}
