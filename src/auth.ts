import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { truncateHttpBody } from "./catalog.ts"
import type { BobSpend } from "./cost.ts"
import type { BobProfileResolver } from "./profile.ts"
import {
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_TOKEN_REQUEST_TIMEOUT_MS,
  apiKeyAuthScheme,
  bobOrigin,
  bobWebLoginUrl,
  configuredApiKey,
  envInt,
  errorMessage,
  log,
  routingHeaders,
  userAgent,
} from "./env.ts"

/** The shape OpenCode stores in its own auth store for this provider. */
export type StoredAuth =
  | { type: "oauth"; access: string; refresh: string; expires: number }
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | { type: "wellknown"; key: string; token: string }

export interface BobCredentials {
  access: string
  refresh: string
  expires: number
}

interface BobTokenResponse {
  token?: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
}

export interface CallbackServer {
  callbackUri: string
  code: Promise<string>
  close(): void
}

const EXPIRY_SKEW_MS = 5 * 60 * 1000

export function jwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".")
    if (parts.length !== 3 || !parts[1]) return undefined
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function jwtExpiry(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp
  return typeof exp === "number" ? exp * 1000 - EXPIRY_SKEW_MS : undefined
}

export function readInstanceFromJwt(token: string | undefined): string | undefined {
  if (!token) return undefined
  const instances = jwtPayload(token)?.instances
  if (!Array.isArray(instances)) return undefined
  for (const entry of instances) {
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      const id = (entry as { id: string }).id
      if (id) return id
    }
  }
  return undefined
}

/** Bob authenticates SSO tokens as `Bearer` and approved API keys as `Apikey`. */
export function authSchemeFor(token: string): string {
  return jwtPayload(token) ? "Bearer" : apiKeyAuthScheme()
}

/**
 * Bob expects `Authorization: Apikey <key>` for approved API keys and
 * `Authorization: Bearer <jwt>` for SSO tokens. The AI SDK adapters send their
 * own `Authorization` or `x-api-key` header, so those are replaced here.
 */
export function applyBobAuthHeaders(
  headers: Record<string, string | null | undefined>,
  token?: string,
): Record<string, string | null | undefined> {
  let resolved = token
  if (!resolved) {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") continue
      const lower = name.toLowerCase()
      if (lower === "authorization") {
        const match = value.match(/^\s*(?:Bearer|Apikey)\s+(.+?)\s*$/iu)
        if (match?.[1]) resolved = match[1]
      } else if (lower === "x-api-key" && value.trim()) {
        resolved ??= value.trim()
      }
    }
  }
  if (!resolved) return headers

  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower === "authorization" || lower === "x-api-key") delete headers[name]
  }
  headers.Authorization = `${authSchemeFor(resolved)} ${resolved}`
  return headers
}

/**
 * Token sources, in resolution order: the credentials OpenCode stored for the
 * provider (SSO or `opencode auth login` API key), then `IBM_BOB_API_KEY` /
 * `IBM_BOB_KEY`. The auth loader registers `stored` once OpenCode has
 * credentials, which is why both hooks share one instance.
 */
export class BobTokenResolver {
  private stored?: () => Promise<string | undefined>

  registerStored(source: () => Promise<string | undefined>): void {
    this.stored = source
  }

  async resolve(): Promise<string | undefined> {
    if (this.stored) {
      try {
        const token = await this.stored()
        if (token) return token
      } catch (error) {
        log(`stored credentials unavailable: ${errorMessage(error)}`, "warn")
      }
    }
    return configuredApiKey()?.value
  }
}

/** The model a completion request targets, used to attribute its Bobcoin cost. */
function requestedModel(init?: RequestInit): string | undefined {
  if (typeof init?.body !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(init.body)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const model = (parsed as { model?: unknown }).model
    return typeof model === "string" && model ? model : undefined
  } catch {
    return undefined
  }
}

function headersToRecord(init?: HeadersInit): Record<string, string | null | undefined> {
  const record: Record<string, string | null | undefined> = {}
  if (!init) return record
  new Headers(init).forEach((value, key) => {
    record[key] = value
  })
  return record
}

/**
 * Wraps `fetch` so every request to Bob carries a current token, Bob's auth
 * scheme, and the non-secret instance/team routing headers.
 */
export type BobFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function createBobFetch(
  resolver: BobTokenResolver,
  profiles?: BobProfileResolver,
  spend?: BobSpend,
): BobFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = await resolver.resolve()
    // Bob rejects inference with `402 team user not found` when an SSO token
    // carries no team, and the team is only discoverable from `/admin/v1/profile`.
    const discovered = token ? await profiles?.resolve(token, authSchemeFor(token)) : undefined
    const headers: Record<string, string | null | undefined> = {
      ...routingHeaders(undefined, discovered),
      ...headersToRecord(init?.headers),
    }
    applyBobAuthHeaders(headers, token)
    if (!headers["x-instance-id"]) {
      const instance = readInstanceFromJwt(token)
      if (instance) headers["x-instance-id"] = instance
    }

    const final: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") final[name] = value
    }
    const response = await fetch(input, { ...init, headers: final })
    // Bob bills in Bobcoins and reports the amount on the response itself.
    spend?.observe(response, requestedModel(init))
    return response
  }
}

export function credentialsFromTokenResponse(response: BobTokenResponse, previousRefresh?: string): BobCredentials {
  if (!response.token) throw new Error("IBM Bob SSO response did not include an access token.")
  const expires =
    jwtExpiry(response.token) ??
    (typeof response.expires_at === "number"
      ? response.expires_at - EXPIRY_SKEW_MS
      : Date.now() + (response.expires_in ?? 55 * 60) * 1000 - EXPIRY_SKEW_MS)
  return {
    access: response.token,
    refresh: response.refresh_token ?? previousRefresh ?? "",
    expires: Math.max(0, Math.floor(expires)),
  }
}

async function postToken(path: "/authn/v1/auth/token" | "/authn/v1/auth/refresh", body: unknown): Promise<BobCredentials> {
  const controller = new AbortController()
  const timeoutMs = envInt("IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS", DEFAULT_TOKEN_REQUEST_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  log(`token request -> ${bobOrigin()}${path} (timeout=${timeoutMs}ms)`)
  try {
    const response = await fetch(`${bobOrigin()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`IBM Bob SSO token request failed: ${response.status} ${truncateHttpBody(await response.text())}`)
    }
    const previousRefresh =
      typeof body === "object" && body !== null && typeof (body as { refresh_token?: unknown }).refresh_token === "string"
        ? (body as { refresh_token: string }).refresh_token
        : undefined
    return credentialsFromTokenResponse((await response.json()) as BobTokenResponse, previousRefresh)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`IBM Bob SSO token request timed out after ${timeoutMs}ms.`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function exchangeAuthorizationCode(code: string): Promise<BobCredentials> {
  return postToken("/authn/v1/auth/token", { code })
}

export function refreshCredentials(refresh: string): Promise<BobCredentials> {
  if (!refresh) throw new Error("No IBM Bob refresh token is available. Log in to IBM Bob again.")
  return postToken("/authn/v1/auth/refresh", { refresh_token: refresh })
}

async function choosePort(): Promise<number> {
  const configured = envInt("IBM_BOB_SSO_PORT", 0) || envInt("SSO_PORT", 0)
  if (configured) return configured

  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.on("error", reject)
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : undefined
      server.close(() => (port ? resolve(port) : reject(new Error("Failed to allocate a callback port."))))
    })
  })
}

/** Local one-shot HTTP listener for Bob's browser SSO redirect. */
export async function startCallbackServer(state: string): Promise<CallbackServer> {
  const port = await choosePort()
  const server = createServer()

  const code = new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      if (!req.url?.startsWith("/bob-callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("Not Found")
        return
      }

      try {
        const url = new URL(req.url, `http://localhost:${port}`)
        const returnedState = url.searchParams.get("state")
        const authCode = url.searchParams.get("code")
        const error = url.searchParams.get("error")

        if (returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Invalid state parameter")
          reject(new Error("Invalid state parameter from the IBM Bob SSO callback."))
          return
        }
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Authentication failed")
          reject(new Error(`IBM Bob SSO failed: ${error}`))
          return
        }
        if (!authCode) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing authorization code")
          reject(new Error("The IBM Bob SSO callback did not include an authorization code."))
          return
        }

        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(
          [
            "<!doctype html>",
            '<html><body style="font-family: system-ui; margin: 3rem;">',
            "<h1>IBM Bob authentication successful</h1>",
            "<p>You can close this window and return to OpenCode.</p>",
            "<script>setTimeout(() => window.close(), 1000);</script>",
            "</body></html>",
          ].join("\n"),
        )
        resolve(authCode)
        setTimeout(() => server.close(), 500)
      } catch (error) {
        reject(error)
      }
    })
    server.on("error", reject)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, () => {
      server.off("error", reject)
      resolve()
    })
  })

  return {
    callbackUri: `http://localhost:${port}/bob-callback`,
    code,
    close() {
      server.close()
    },
  }
}

export function buildLoginUrl(callbackUri: string, state: string): string {
  const url = new URL(bobWebLoginUrl())
  url.searchParams.set("callback_uri", callbackUri)
  url.searchParams.set("state", state)
  return url.toString()
}

export function newState(): string {
  return randomBytes(16).toString("hex")
}

/** Resolves the SSO authorization code, or rejects once the login window elapses. */
export function awaitAuthorizationCode(server: CallbackServer): Promise<string> {
  const timeoutMs = envInt("IBM_BOB_LOGIN_TIMEOUT_MS", DEFAULT_LOGIN_TIMEOUT_MS)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("IBM Bob SSO timed out.")), timeoutMs)
  })
  return Promise.race([server.code, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
