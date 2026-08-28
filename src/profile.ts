import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isRecord, positiveNumber, readBoundedResponseBody, safeLabel, truncateHttpBody } from "./catalog.ts"
import {
  DEFAULT_PROFILE_DISCOVERY_TIMEOUT_MS,
  DEFAULT_PROFILE_TTL_MS,
  adminBaseUrl,
  bobOrigin,
  env,
  envBool,
  envInt,
  errorMessage,
  log,
  userAgent,
} from "./env.ts"

/**
 * One (instance, team) pair the account can route to.
 *
 * Bob Shell flattens its `/admin/v1/profile` response the same way, then sends
 * the selected pair as the `x-instance-id` / `x-team-id` routing headers.
 */
export interface BobProfile {
  instanceId: string
  instanceName?: string
  region?: string
  teamId?: string
  teamName?: string
}

interface CachedProfiles {
  updated: number
  origin: string
  profiles: BobProfile[]
}

const MAX_PROFILE_ENTRIES = 200

/**
 * Parses Bob's `/admin/v1/profile` payload into one entry per (instance, team).
 *
 * An instance with no team still yields an entry: Bob accepts `x-instance-id`
 * alone for API keys, and only requires the team for SSO tokens.
 */
export function parseBobProfiles(payload: unknown): BobProfile[] {
  if (!isRecord(payload) || !Array.isArray(payload.instances)) {
    throw new Error("IBM Bob profile response did not contain an instances array.")
  }
  if (payload.instances.length > MAX_PROFILE_ENTRIES) {
    throw new Error(`IBM Bob profile response exceeded ${MAX_PROFILE_ENTRIES} instances.`)
  }

  const profiles: BobProfile[] = []
  const seen = new Set<string>()

  for (const entry of payload.instances) {
    if (!isRecord(entry)) continue
    const instanceId = safeLabel(entry.instance_id)
    if (!instanceId) continue

    const instanceName = safeLabel(entry.instance_name)
    const region = safeLabel(entry.region)
    const base: BobProfile = {
      instanceId,
      ...(instanceName ? { instanceName } : {}),
      ...(region ? { region } : {}),
    }

    let added = false
    for (const team of Array.isArray(entry.teams) ? entry.teams : []) {
      if (!isRecord(team)) continue
      const teamId = safeLabel(team.id)
      if (!teamId || seen.has(`${instanceId}/${teamId}`)) continue
      seen.add(`${instanceId}/${teamId}`)
      added = true
      const teamName = safeLabel(team.name)
      profiles.push({ ...base, teamId, ...(teamName ? { teamName } : {}) })
    }

    if (!added && !seen.has(`${instanceId}/`)) {
      seen.add(`${instanceId}/`)
      profiles.push(base)
    }
  }

  if (profiles.length === 0) {
    throw new Error("IBM Bob profile response contained no usable instances.")
  }
  return profiles
}

export function sanitizeProfiles(value: unknown): BobProfile[] | undefined {
  if (!Array.isArray(value)) return undefined
  const profiles: BobProfile[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const instanceId = safeLabel(entry.instanceId)
    if (!instanceId) continue
    const teamId = safeLabel(entry.teamId)
    if (seen.has(`${instanceId}/${teamId}`)) continue
    seen.add(`${instanceId}/${teamId}`)
    const instanceName = safeLabel(entry.instanceName)
    const teamName = safeLabel(entry.teamName)
    const region = safeLabel(entry.region)
    profiles.push({
      instanceId,
      ...(instanceName ? { instanceName } : {}),
      ...(region ? { region } : {}),
      ...(teamId ? { teamId } : {}),
      ...(teamName ? { teamName } : {}),
    })
  }
  return profiles.length > 0 ? profiles : undefined
}

/**
 * Picks the profile to route with, mirroring Bob Shell: an explicit pair wins,
 * then a single explicit id, then the first profile the account exposes.
 */
export function selectProfile(profiles: BobProfile[], instanceId?: string, teamId?: string): BobProfile | undefined {
  if (profiles.length === 0) return undefined
  if (instanceId && teamId) {
    return profiles.find((profile) => profile.instanceId === instanceId && profile.teamId === teamId)
  }
  if (instanceId) return profiles.find((profile) => profile.instanceId === instanceId)
  if (teamId) return profiles.find((profile) => profile.teamId === teamId)
  return profiles[0]
}

export async function fetchBobProfiles(accessToken: string, authScheme: string): Promise<BobProfile[]> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeoutMs = envInt("IBM_BOB_PROFILE_DISCOVERY_TIMEOUT_MS", DEFAULT_PROFILE_DISCOVERY_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const url = `${adminBaseUrl()}/profile`

  log(`profile discovery -> ${url} (timeout=${timeoutMs}ms)`)
  try {
    const response = await fetch(url, {
      method: "GET",
      // Routing headers are what this call resolves, so only the User-Agent is sent.
      headers: {
        "User-Agent": userAgent(),
        Accept: "application/json",
        Authorization: `${authScheme} ${accessToken}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = truncateHttpBody(await readBoundedResponseBody(response))
      throw new Error(`IBM Bob profile discovery failed: ${response.status} ${body}`.trim())
    }
    const profiles = parseBobProfiles(JSON.parse(await readBoundedResponseBody(response)))
    log(`profile discovery ok: ${profiles.length} profiles in ${Date.now() - startedAt}ms`)
    return profiles
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`IBM Bob profile discovery timed out after ${timeoutMs}ms.`)
    log(`profile discovery failed in ${Date.now() - startedAt}ms: ${errorMessage(error)}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function profileCacheFile(): string {
  const explicit = env("IBM_BOB_PROFILE_CACHE")
  if (explicit) return explicit
  const base = env("XDG_CACHE_HOME") ?? join(homedir(), ".cache")
  return join(base, "opencode", "ibm-bob", "profile.json")
}

/** Cached profiles are scoped to the origin that produced them and hold no credentials. */
export function readCachedProfiles(): { profiles: BobProfile[]; updated: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(profileCacheFile(), "utf8"))
    if (!isRecord(parsed)) return undefined
    if (safeLabel(parsed.origin) !== bobOrigin()) return undefined
    const profiles = sanitizeProfiles(parsed.profiles)
    if (!profiles) return undefined
    return { profiles, updated: positiveNumber(parsed.updated) ?? 0 }
  } catch {
    return undefined
  }
}

export function writeCachedProfiles(profiles: BobProfile[]): void {
  const payload: CachedProfiles = { updated: Date.now(), origin: bobOrigin(), profiles }
  try {
    const file = profileCacheFile()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    log(`cached ${profiles.length} profiles in ${file}`)
  } catch (error) {
    log(`failed to cache the profile: ${errorMessage(error)}`)
  }
}

/**
 * Resolves the instance/team routing pair once per session.
 *
 * Bob requires `x-instance-id` for SSO tokens and rejects inference with
 * `402 team user not found` when the matching `x-team-id` is missing, so this
 * is what makes an SSO login usable without Bob Shell present.
 */
export class BobProfileResolver {
  private profiles?: BobProfile[]
  private inflight?: Promise<BobProfile[] | undefined>

  async load(accessToken: string | undefined, authScheme: string): Promise<BobProfile[] | undefined> {
    if (this.profiles) return this.profiles
    if (!envBool("IBM_BOB_DISCOVER_PROFILE", true)) return undefined

    const cached = readCachedProfiles()
    if (cached && Date.now() - cached.updated < envInt("IBM_BOB_PROFILE_TTL_MS", DEFAULT_PROFILE_TTL_MS)) {
      this.profiles = cached.profiles
      return this.profiles
    }
    if (!accessToken) return cached?.profiles

    this.inflight ??= (async () => {
      try {
        const profiles = await fetchBobProfiles(accessToken, authScheme)
        writeCachedProfiles(profiles)
        this.profiles = profiles
        return profiles
      } catch (error) {
        log(`${errorMessage(error)} Falling back to the cached or configured routing headers.`, "warn")
        this.profiles = cached?.profiles
        return this.profiles
      } finally {
        this.inflight = undefined
      }
    })()
    return this.inflight
  }

  /** Clears the memo so the next call re-reads the cache or refetches. */
  reset(): void {
    this.profiles = undefined
  }

  async resolve(
    accessToken: string | undefined,
    authScheme: string,
    instanceId?: string,
    teamId?: string,
  ): Promise<BobProfile | undefined> {
    const profiles = await this.load(accessToken, authScheme)
    return profiles ? selectProfile(profiles, instanceId, teamId) : undefined
  }
}
