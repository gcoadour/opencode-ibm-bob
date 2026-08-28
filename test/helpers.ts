import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const IBM_BOB_KEYS = [
  "IBM_BOB_API",
  "IBM_BOB_API_KEY",
  "IBM_BOB_AUTH_BASE_URL",
  "IBM_BOB_AUTH_SCHEME",
  "IBM_BOB_BASE_URL",
  "IBM_BOB_BUDGET_TIMEOUT_MS",
  "IBM_BOB_CATALOG_CACHE",
  "IBM_BOB_CATALOG_TTL_MS",
  "IBM_BOB_CONTEXT_WINDOW",
  "IBM_BOB_DEBUG",
  "IBM_BOB_DISCOVER_MODELS",
  "IBM_BOB_DISCOVER_PROFILE",
  "IBM_BOB_ENABLED",
  "IBM_BOB_HEADERS_JSON",
  "IBM_BOB_INPUT",
  "IBM_BOB_INSTANCE_ID",
  "IBM_BOB_KEY",
  "IBM_BOB_MAX_TOKENS",
  "IBM_BOB_MODELS",
  "IBM_BOB_NPM",
  "IBM_BOB_PROFILE_CACHE",
  "IBM_BOB_PROFILE_DISCOVERY_TIMEOUT_MS",
  "IBM_BOB_PROFILE_TTL_MS",
  "IBM_BOB_RATES",
  "IBM_BOB_REASONING",
  "IBM_BOB_REASONING_MODELS",
  "IBM_BOB_READ_BOBSHELL_SETTINGS",
  "IBM_BOB_TEAM_ID",
  "IBM_BOB_USER_AGENT",
  "IBM_BOB_WEB_LOGIN_URL",
] as const

/** Throwaway location for the on-disk caches, wiped before each test. */
const CACHE_DIR = mkdtempSync(join(tmpdir(), "ibm-bob-test-"))

/** Clears every IBM_BOB_* variable so a test starts from documented defaults. */
export function resetEnv(): void {
  for (const key of IBM_BOB_KEYS) delete process.env[key]
  // Bob Shell settings live outside the repo; tests never read the real file.
  process.env.IBM_BOB_READ_BOBSHELL_SETTINGS = "false"
  // Nor the developer's real catalog and profile caches, which would otherwise
  // leak a live Bob account into the suite.
  rmSync(CACHE_DIR, { recursive: true, force: true })
  mkdirSync(CACHE_DIR, { recursive: true })
  process.env.IBM_BOB_CATALOG_CACHE = join(CACHE_DIR, "catalog.json")
  process.env.IBM_BOB_PROFILE_CACHE = join(CACHE_DIR, "profile.json")
}

export function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`
}

/**
 * The shape `GET /inference/v1/model/info` returns for an approved API key:
 * `model_name` + `model_info` only, with no `litellm_params` and no `exposed`.
 */
export function bobApiKeyEntry(name: string, modelInfo: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_name: name,
    model_info: {
      id: "4c6a576bda1095bb14c76f02c3661a9bd9429a9889d09f43fd41e3671a094668",
      max_tokens: 12000,
      max_input_tokens: 200000,
      max_output_tokens: 64000,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
      cache_creation_input_token_cost: 0,
      cache_read_input_token_cost: 0,
      supports_vision: true,
      supports_prompt_caching: true,
      completion_only: false,
      ...modelInfo,
    },
  }
}

export function modelInfoEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { model_name, litellm_model, ...modelInfo } = overrides as {
    model_name?: string
    litellm_model?: string
  } & Record<string, unknown>
  return {
    model_name: model_name ?? "premium",
    litellm_params: { model: litellm_model ?? "anthropic/claude-sonnet-4-5" },
    model_info: {
      max_input_tokens: 200000,
      max_tokens: 8192,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      ...modelInfo,
    },
  }
}
