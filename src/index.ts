import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  BobTokenResolver,
  authSchemeFor,
  awaitAuthorizationCode,
  buildLoginUrl,
  createBobFetch,
  exchangeAuthorizationCode,
  newState,
  readInstanceFromJwt,
  refreshCredentials,
  startCallbackServer,
  type BobCredentials,
  type StoredAuth,
} from "./auth.ts"
import { fetchBobModelCatalog, readCachedCatalog, writeCachedCatalog, type BobDiscoveredModel } from "./catalog.ts"
import { BobSpend, fetchBobBudget, formatBobcoins, formatDollars, readCachedBudget, writeCachedBudget } from "./cost.ts"
import { BobProfileResolver, type BobProfile } from "./profile.ts"
import {
  DEFAULT_BUDGET_TTL_MS,
  DEFAULT_CATALOG_TTL_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  configuredApiKey,
  envBool,
  envInt,
  errorMessage,
  log,
  npmPackage,
  parseApi,
  readBobShellSettings,
  requestBaseUrl,
  routingHeaders,
} from "./env.ts"
import { buildModels } from "./models.ts"

/**
 * OpenCode plugin that exposes IBM Bob (and IBM-approved Bob-compatible
 * endpoints) as the `ibm-bob` provider.
 *
 * - `config` registers the provider with its model catalog, so the models show
 *   up in `/models` and `opencode models` before any credential is resolved.
 * - `auth` adds Bob's browser SSO flow plus API-key entry to `opencode auth
 *   login`, and injects a current token, Bob's auth scheme, and the non-secret
 *   instance/team routing headers into every request.
 *
 * It never reads Bob Shell's stored SSO secrets: SSO tokens are obtained
 * through Bob's own browser login endpoints and kept in OpenCode's auth store.
 */
export const IbmBobPlugin = async ({ client }: PluginInput): Promise<Hooks> => {
  const api = parseApi()
  const settings = readBobShellSettings()
  const resolver = new BobTokenResolver()
  const profiles = new BobProfileResolver()
  const spend = new BobSpend()
  const bobFetch = createBobFetch(resolver, profiles, spend)
  const enabled = envBool("IBM_BOB_ENABLED", true)
  const discoverModels = envBool("IBM_BOB_DISCOVER_MODELS", true)

  const authApi = client as unknown as {
    auth: { set: (options: { path: { id: string }; body: StoredAuth }) => Promise<unknown> }
  }

  let refreshing: Promise<string | undefined> | undefined
  let catalogRefreshed = false
  let budgetRefreshed = false

  /**
   * Resolves the instance/team pair Bob routes with. The catalog and every
   * inference request need it, and for SSO tokens it is only available from
   * `/admin/v1/profile`.
   */
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

  /**
   * Refreshes the cached catalog in the background once per session. The models
   * of the current session are already registered by then, so a fresh catalog
   * takes effect on the next OpenCode start.
   */
  function refreshCatalogInBackground(token: string): void {
    if (!discoverModels || catalogRefreshed) return
    catalogRefreshed = true
    const ttl = envInt("IBM_BOB_CATALOG_TTL_MS", DEFAULT_CATALOG_TTL_MS)
    const cached = readCachedCatalog()
    if (cached && Date.now() - cached.updated < ttl) return
    void discoverCatalog(token)
  }

  /**
   * The TUI sidebar has no credential access of its own (see tui.tsx), so it
   * reads the team budget from this cache instead. Refreshed once per session
   * start, like the catalog above.
   */
  function refreshBudgetInBackground(token: string): void {
    if (budgetRefreshed) return
    budgetRefreshed = true
    const ttl = envInt("IBM_BOB_BUDGET_TTL_MS", DEFAULT_BUDGET_TTL_MS)
    const cached = readCachedBudget()
    if (cached && Date.now() - cached.updated < ttl) return
    void (async () => {
      try {
        const profile = await discoverProfile(token)
        if (!profile?.teamId || !profile.instanceUserId) return
        const budget = await fetchBobBudget(token, authSchemeFor(token), {
          ...profile,
          teamId: profile.teamId,
          instanceUserId: profile.instanceUserId,
        })
        writeCachedBudget(profile.teamName ?? profile.teamId, budget)
      } catch (error) {
        log(`background budget refresh failed: ${errorMessage(error)}`, "warn")
      }
    })()
  }

  async function persist(credentials: BobCredentials): Promise<void> {
    try {
      await authApi.auth.set({ path: { id: PROVIDER_ID }, body: { type: "oauth", ...credentials } })
    } catch (error) {
      log(`failed to store the refreshed IBM Bob token: ${errorMessage(error)}`, "warn")
    }
  }

  async function refreshStored(info: Extract<StoredAuth, { type: "oauth" }>): Promise<string | undefined> {
    refreshing ??= (async () => {
      try {
        const next = await refreshCredentials(info.refresh)
        await persist(next)
        return next.access
      } catch (error) {
        log(`IBM Bob token refresh failed: ${errorMessage(error)}`, "warn")
        return info.access || undefined
      } finally {
        refreshing = undefined
      }
    })()
    return refreshing
  }

  async function storedToken(getAuth: () => Promise<StoredAuth | undefined>): Promise<string | undefined> {
    const info = await getAuth()
    if (!info) return undefined
    if (info.type === "api") return info.key
    if (info.type === "wellknown") return info.token
    if (info.type !== "oauth") return undefined

    const token = info.expires > Date.now() ? info.access : await refreshStored(info)
    if (token) {
      refreshCatalogInBackground(token)
      refreshBudgetInBackground(token)
    }
    return token
  }

  async function resolveCatalog(): Promise<BobDiscoveredModel[] | undefined> {
    const cached = readCachedCatalog()?.models
    if (!discoverModels) return cached
    const key = configuredApiKey()
    if (!key) return cached
    return (await discoverCatalog(key.value)) ?? cached
  }

  return {
    async config(input) {
      if (!enabled) return

      const models = buildModels(await resolveCatalog())
      const providers = (input.provider ??= {})
      const existing = providers[PROVIDER_ID] ?? {}
      const existingOptions = (existing.options ?? {}) as Record<string, unknown>

      providers[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: npmPackage(api),
        env: ["IBM_BOB_API_KEY", "IBM_BOB_KEY"],
        ...existing,
        // User-declared models win, so an `opencode.json` entry can pin or add routes.
        models: { ...models, ...(existing.models ?? {}) },
        options: {
          baseURL: requestBaseUrl(api),
          headers: routingHeaders(settings),
          // Placeholder: the real credential is attached per request by `fetch`,
          // which keeps SSO tokens current without rebuilding the provider.
          apiKey: configuredApiKey()?.value ?? PROVIDER_ID,
          ...existingOptions,
          fetch: bobFetch,
        },
      }
    },

    tool: {
      /**
       * Bob prices usage in Bobcoins, not per token, so OpenCode's own cost
       * column stays at zero. This reports what was actually spent.
       */
      bob_usage: {
        description:
          "Report IBM Bob usage in Bobcoins: what this OpenCode session spent, and the team's total usage against its budget.",
        args: {},
        async execute() {
          // The turn that calls this tool has not been billed yet, so its own
          // cost only appears on the next call.
          const lines = [
            `This session so far: ${formatBobcoins(spend.total)} Bobcoins (${formatDollars(spend.total)}) ` +
              `over ${spend.count} billed response(s).`,
          ]

          const token = await resolver.resolve()
          const profile = token ? await profiles.resolve(token, authSchemeFor(token)) : undefined
          if (!token || !profile) {
            lines.push("Team usage is unavailable: no IBM Bob credential resolved.")
            return { title: "IBM Bob usage", output: lines.join("\n") }
          }

          const team = profile.teamName ?? profile.teamId ?? "unknown"
          // The profile already carries a usage figure; the budget endpoint has
          // the fresher per-member one, so it is preferred when reachable.
          let usage = profile.usage
          let limit = profile.budgetLimit
          if (profile.teamId && profile.instanceUserId) {
            try {
              const budget = await fetchBobBudget(token, authSchemeFor(token), {
                ...profile,
                teamId: profile.teamId,
                instanceUserId: profile.instanceUserId,
              })
              usage = budget.usage
              limit = budget.budgetLimit ?? limit
              writeCachedBudget(team, budget)
            } catch (error) {
              log(`budget lookup failed, using the profile figure: ${errorMessage(error)}`, "warn")
            }
          }

          if (usage === undefined) {
            lines.push(`Team ${team}: IBM Bob did not report a usage figure.`)
          } else if (limit === undefined) {
            lines.push(`Team ${team}: ${formatBobcoins(usage)} Bobcoins used (no published limit).`)
          } else {
            lines.push(
              `Team ${team}: ${formatBobcoins(usage)}/${formatBobcoins(limit)} BOBcoin used ` +
                `(${formatDollars(usage)} of ${formatDollars(limit)}), ` +
                `${formatBobcoins(Math.max(0, limit - usage))} left.`,
            )
          }
          return { title: "IBM Bob usage", output: lines.join("\n") }
        },
      },
    },

    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth) {
        const read = getAuth as unknown as () => Promise<StoredAuth | undefined>
        const info = await read()
        if (!info) return {}

        resolver.registerStored(() => storedToken(read))
        const token = await storedToken(read)

        return {
          baseURL: requestBaseUrl(api),
          headers: routingHeaders(settings),
          apiKey: token ?? PROVIDER_ID,
          fetch: bobFetch,
        }
      },
      methods: [
        {
          type: "oauth",
          label: "IBM Bob SSO (browser)",
          async authorize() {
            const state = newState()
            const server = await startCallbackServer(state)
            return {
              url: buildLoginUrl(server.callbackUri, state),
              method: "auto",
              instructions: `Complete the IBM Bob SSO flow in your browser. OpenCode is listening on ${server.callbackUri}.`,
              async callback() {
                try {
                  const code = await awaitAuthorizationCode(server)
                  const credentials = await exchangeAuthorizationCode(code)
                  if (discoverModels) await discoverCatalog(credentials.access)
                  return { type: "success" as const, ...credentials }
                } catch (error) {
                  log(`IBM Bob SSO login failed: ${errorMessage(error)}`, "warn")
                  return { type: "failed" as const }
                } finally {
                  server.close()
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "IBM Bob API key",
        },
      ],
    },
  }
}
