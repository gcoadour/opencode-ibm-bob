// OpenCode V2 entry point (`@opencode/plugin`). Every import from the V2 SDK is
// type-only: OpenCode V1 loads this same module, and has no `@opencode/plugin`
// package to resolve at runtime.
import type { Credential, Model, Plugin, Provider } from "@opencode/plugin"
import {
  BobTokenResolver,
  authSchemeFor,
  awaitAuthorizationCode,
  bobRequestHeaders,
  buildLoginUrl,
  exchangeAuthorizationCode,
  newState,
  readInstanceFromJwt,
  refreshCredentials,
  startCallbackServer,
  type BobCredentials,
} from "./auth.ts"
import { fetchBobModelCatalog, readCachedCatalog, writeCachedCatalog, type BobDiscoveredModel } from "./catalog.ts"
import { BobSpend, fetchBobBudget, readCachedBudget, writeCachedBudget } from "./cost.ts"
import { BobProfileResolver, type BobProfile } from "./profile.ts"
import {
  DEFAULT_BUDGET_TTL_MS,
  DEFAULT_CATALOG_TTL_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  configuredApiKey,
  env,
  envBool,
  envInt,
  errorMessage,
  log,
  parseApi,
  readBobShellSettings,
  requestBaseUrl,
  routingHeaders,
  type BobApi,
} from "./env.ts"
import { buildModels, type ProviderModelConfig } from "./models.ts"
import { bobUsageReport } from "./usage.ts"

/** The integration method id of Bob's browser SSO login, stored on each OAuth credential. */
export const SSO_METHOD_ID = "sso"

/** The env names OpenCode reads an approved API key from. */
export const API_KEY_ENV = ["IBM_BOB_API_KEY", "IBM_BOB_KEY"] as const

/**
 * V2 drives requests through its own `@opencode/ai` provider packages, which
 * honour the session HTTP hooks used below. `IBM_BOB_NPM` still selects an AI
 * SDK package instead (`aisdk:` prefix), or another native package.
 */
const NATIVE_PACKAGE_BY_API: Record<BobApi, string> = {
  "openai-completions": "@opencode/ai/providers/openai-compatible",
  "openai-responses": "@opencode/ai/providers/openai",
  "anthropic-messages": "@opencode/ai/providers/anthropic",
}

export function v2Package(api: BobApi): string {
  const explicit = env("IBM_BOB_NPM")
  if (!explicit) return NATIVE_PACKAGE_BY_API[api]
  if (explicit.startsWith("@opencode/ai/") || explicit.startsWith("aisdk:")) return explicit
  return `aisdk:${explicit}`
}

/** Converts the V1-shaped model entry `buildModels` produces into a V2 `Model.Info`. */
export function toModelInfo(model: ProviderModelConfig): Model.Info {
  return {
    id: model.id as Model.ID,
    modelID: model.id as Model.ID,
    providerID: PROVIDER_ID as Provider.ID,
    name: model.name,
    capabilities: {
      tools: model.tool_call,
      input: [...model.modalities.input],
      output: [...model.modalities.output],
      temperature: model.temperature,
    },
    variants: [],
    time: { released: 0 },
    cost: [
      {
        input: model.cost.input,
        output: model.cost.output,
        cache: { read: model.cost.cache_read, write: model.cost.cache_write },
      } as Model.Cost,
    ],
    status: "active",
    enabled: true,
    limit: { context: model.limit.context, output: model.limit.output },
  }
}

function credentialFrom(credentials: BobCredentials): Credential.OAuth {
  return {
    type: "oauth",
    methodID: SSO_METHOD_ID as Credential.OAuth["methodID"],
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
  }
}

function tokenOf(value: Credential.Value | undefined): string | undefined {
  if (value?.type === "oauth") return value.access || undefined
  if (value?.type === "key") return value.key || undefined
  return undefined
}

function headersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

export async function setup(ctx: Plugin.Context): Promise<void> {
  if (!envBool("IBM_BOB_ENABLED", true)) return

  const api = parseApi()
  const settings = readBobShellSettings()
  const resolver = new BobTokenResolver()
  const profiles = new BobProfileResolver()
  const spend = new BobSpend()
  const discoverModels = envBool("IBM_BOB_DISCOVER_MODELS", true)
  let budgetRefreshed = false

  // V2 resolves the active connection (stored SSO login, stored key, or one of
  // the env names) and refreshes expiring OAuth tokens through `refresh` below.
  resolver.registerStored(async () => {
    const connection = await ctx.integration.connection.active(PROVIDER_ID)
    return connection ? tokenOf(await ctx.integration.connection.resolve(connection)) : undefined
  })

  async function discoverProfile(token: string): Promise<BobProfile | undefined> {
    const profile = await profiles.resolve(token, authSchemeFor(token))
    if (profile) return profile
    const instanceId = readInstanceFromJwt(token)
    return instanceId ? { instanceId } : undefined
  }

  async function discoverCatalog(token: string): Promise<BobDiscoveredModel[] | undefined> {
    try {
      const catalog = await fetchBobModelCatalog(token, authSchemeFor(token), await discoverProfile(token))
      writeCachedCatalog(catalog)
      return catalog
    } catch (error) {
      log(`${errorMessage(error)} Falling back to the cached or configured models.`, "warn")
      return undefined
    }
  }

  // The provider transform is synchronous, so the catalog is loaded first and
  // swapped in through `ctx.provider.reload()` when a fresher one arrives.
  const state = { models: buildModels(await initialCatalog()) }

  async function initialCatalog(): Promise<BobDiscoveredModel[] | undefined> {
    const cached = readCachedCatalog()?.models
    if (!discoverModels) return cached
    const key = configuredApiKey()
    if (!key) return cached
    return (await discoverCatalog(key.value)) ?? cached
  }

  /**
   * Unlike V1, V2 can re-run the provider transform, so a catalog discovered
   * with the stored credential takes effect without restarting OpenCode.
   */
  async function refreshCatalog(token: string, force = false): Promise<void> {
    if (!discoverModels) return
    const cached = readCachedCatalog()
    const ttl = envInt("IBM_BOB_CATALOG_TTL_MS", DEFAULT_CATALOG_TTL_MS)
    if (!force && cached && Date.now() - cached.updated < ttl) return
    const catalog = await discoverCatalog(token)
    if (!catalog) return
    const next = buildModels(catalog)
    if (JSON.stringify(next) === JSON.stringify(state.models)) return
    state.models = next
    await ctx.provider.reload()
  }

  /** The TUI sidebar reads the team budget from this cache (see tui.tsx). */
  async function refreshBudget(token: string): Promise<void> {
    if (budgetRefreshed) return
    budgetRefreshed = true
    const ttl = envInt("IBM_BOB_BUDGET_TTL_MS", DEFAULT_BUDGET_TTL_MS)
    const cached = readCachedBudget()
    if (cached && Date.now() - cached.updated < ttl) return
    const profile = await discoverProfile(token)
    if (!profile?.teamId || !profile.instanceUserId) return
    const budget = await fetchBobBudget(token, authSchemeFor(token), {
      ...profile,
      teamId: profile.teamId,
      instanceUserId: profile.instanceUserId,
    })
    writeCachedBudget(profile.teamName ?? profile.teamId, budget)
  }

  await ctx.integration.transform((editor) => {
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: SSO_METHOD_ID, type: "oauth", label: "IBM Bob SSO (browser)" },
      async authorize() {
        const state = newState()
        const server = await startCallbackServer(state)
        const callback = (async () => {
          try {
            const credentials = await exchangeAuthorizationCode(await awaitAuthorizationCode(server))
            void refreshCatalog(credentials.access, true).catch((error) =>
              log(`catalog refresh after login failed: ${errorMessage(error)}`, "warn"),
            )
            return credentialFrom(credentials)
          } catch (error) {
            log(`IBM Bob SSO login failed: ${errorMessage(error)}`, "warn")
            throw error
          } finally {
            server.close()
          }
        })()
        return {
          url: buildLoginUrl(server.callbackUri, state),
          mode: "auto",
          instructions: `Complete the IBM Bob SSO flow in your browser. OpenCode is listening on ${server.callbackUri}.`,
          callback,
        }
      },
      // OpenCode calls this when the stored token is about to expire and
      // persists what it returns, so the plugin no longer writes the auth store.
      async refresh(credential) {
        return credentialFrom(await refreshCredentials(credential.refresh))
      },
    })
    editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "IBM Bob API key" } })
    editor.method.update({ integrationID: PROVIDER_ID, method: { type: "env", names: [...API_KEY_ENV] } })
    editor.update(PROVIDER_ID, (integration) => {
      integration.name = PROVIDER_NAME
    })
  })

  await ctx.provider.transform((editor) => {
    const models = Object.values(state.models).map(toModelInfo)
    const defaults = {
      baseURL: requestBaseUrl(api),
      headers: routingHeaders(settings),
      package: v2Package(api),
    }
    const current = editor.get(PROVIDER_ID)
    if (!current) {
      editor.add({
        info: {
          id: PROVIDER_ID as Provider.ID,
          integrationID: PROVIDER_ID as NonNullable<Provider.Info["integrationID"]>,
          name: PROVIDER_NAME,
          activation: "auto",
          package: defaults.package,
          settings: { baseURL: defaults.baseURL },
          headers: defaults.headers,
        },
        models,
      })
      return
    }

    // `opencode.json` declared `providers.ibm-bob` (or `provider.ibm-bob`)
    // before this ran: fill in only what it left unset, so a corporate
    // endpoint or a pinned model stays in place.
    editor.update(PROVIDER_ID, (provider) => {
      provider.integrationID ??= PROVIDER_ID as NonNullable<Provider.Info["integrationID"]>
      if (!provider.name || provider.name === PROVIDER_ID) provider.name = PROVIDER_NAME
      if (!provider.package) provider.package = defaults.package
      provider.settings = { baseURL: defaults.baseURL, ...provider.settings }
      provider.headers = { ...defaults.headers, ...provider.headers }
    })
    for (const model of models) {
      if (current.models.has(model.id)) continue
      editor.models.update(PROVIDER_ID, model.id, (target) => {
        Object.assign(target, structuredClone(model))
      })
    }
  })

  // Bob wants `Apikey <key>` (not `Bearer`) for API keys, plus the
  // instance/team routing pair, on every inference request.
  await ctx.session.hook(
    "http.request",
    async (event) => {
      const current = event.request.headers
      const headers = await bobRequestHeaders(headersRecord(current), undefined, profiles)
      // Edited in place: replacing the Request would make OpenCode copy the body.
      for (const name of Object.keys(headersRecord(current))) current.delete(name)
      for (const [name, value] of Object.entries(headers)) current.set(name, value)
      const token = headers.Authorization?.replace(/^\S+\s+/u, "")
      if (token) {
        void refreshBudget(token).catch((error) =>
          log(`background budget refresh failed: ${errorMessage(error)}`, "warn"),
        )
      }
    },
    { providerID: PROVIDER_ID },
  )

  // Bob bills in Bobcoins and reports the amount on the response itself.
  await ctx.session.hook(
    "http.response",
    (event) => {
      spend.observe(event.response)
    },
    { providerID: PROVIDER_ID },
  )

  await ctx.tool.transform((tools) => {
    tools.add({
      name: "bob_usage",
      description:
        "Report IBM Bob usage in Bobcoins: what this OpenCode session spent, and the team's total usage against its budget.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      async execute() {
        return { content: await bobUsageReport(resolver, profiles, spend) }
      },
    })
  })

  // A stored SSO login or API key is only reachable once setup has run, so the
  // catalog and budget refreshes start here, in the background.
  void (async () => {
    const token = await resolver.resolve()
    if (!token) return
    await refreshCatalog(token)
    await refreshBudget(token)
  })().catch((error) => log(`background IBM Bob refresh failed: ${errorMessage(error)}`, "warn"))
}

export const v2Plugin: Plugin.Plugin = { id: "opencode-ibm-bob", setup }
