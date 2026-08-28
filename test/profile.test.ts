import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BobProfileResolver,
  fetchBobProfiles,
  parseBobProfiles,
  profileCacheFile,
  readCachedProfiles,
  sanitizeProfiles,
  selectProfile,
  writeCachedProfiles,
} from "../src/profile.ts"
import { resetEnv } from "./helpers.ts"

const originalFetch = globalThis.fetch
let cacheDir: string

/** The shape `GET /admin/v1/profile` returns, as observed on the live endpoint. */
function profilePayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "someone@example.com",
    instances: [
      {
        instance_id: "instance-1",
        instance_name: "bob-001",
        region: "us-east",
        role: "bob-admin",
        teams: [{ id: "team-1", name: "default", usage: 0.11, budget_limit: 40 }],
        ...overrides,
      },
    ],
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  resetEnv()
  cacheDir = mkdtempSync(join(tmpdir(), "ibm-bob-profile-"))
  process.env.IBM_BOB_PROFILE_CACHE = join(cacheDir, "profile.json")
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(cacheDir, { recursive: true, force: true })
})

describe("parseBobProfiles", () => {
  test("flattens instances into one entry per team", () => {
    expect(parseBobProfiles(profilePayload())).toEqual([
      { instanceId: "instance-1", instanceName: "bob-001", region: "us-east", teamId: "team-1", teamName: "default" },
    ])
  })

  test("emits one entry per team of a multi-team instance", () => {
    const profiles = parseBobProfiles(
      profilePayload({ teams: [{ id: "team-1", name: "default" }, { id: "team-2", name: "platform" }] }),
    )
    expect(profiles.map((profile) => profile.teamId)).toEqual(["team-1", "team-2"])
    expect(profiles.every((profile) => profile.instanceId === "instance-1")).toBe(true)
  })

  test("keeps an instance that exposes no team, since API keys route without one", () => {
    expect(parseBobProfiles(profilePayload({ teams: [] }))).toEqual([
      { instanceId: "instance-1", instanceName: "bob-001", region: "us-east" },
    ])
  })

  test("drops malformed entries and de-duplicates repeated pairs", () => {
    const profiles = parseBobProfiles({
      instances: [
        { instance_id: "", teams: [{ id: "team-1" }] },
        "not-an-object",
        { instance_id: "instance-1", teams: [{ id: "team-1" }, { id: "team-1" }, { id: "" }, 42] },
      ],
    })
    expect(profiles).toEqual([{ instanceId: "instance-1", teamId: "team-1" }])
  })

  test("rejects a payload without an instances array", () => {
    expect(() => parseBobProfiles({ instances: "nope" })).toThrow(/instances array/)
    expect(() => parseBobProfiles(null)).toThrow(/instances array/)
  })

  test("rejects a payload with no usable instance", () => {
    expect(() => parseBobProfiles({ instances: [{ instance_name: "unnamed" }] })).toThrow(/no usable instances/)
  })
})

describe("selectProfile", () => {
  const profiles = [
    { instanceId: "instance-1", teamId: "team-1" },
    { instanceId: "instance-1", teamId: "team-2" },
    { instanceId: "instance-2", teamId: "team-3" },
  ]

  test("prefers an exact instance/team pair", () => {
    expect(selectProfile(profiles, "instance-1", "team-2")).toEqual({ instanceId: "instance-1", teamId: "team-2" })
  })

  test("matches on a single configured id", () => {
    expect(selectProfile(profiles, "instance-2")).toEqual({ instanceId: "instance-2", teamId: "team-3" })
    expect(selectProfile(profiles, undefined, "team-2")).toEqual({ instanceId: "instance-1", teamId: "team-2" })
  })

  test("falls back to the first profile when nothing is configured", () => {
    expect(selectProfile(profiles)).toEqual({ instanceId: "instance-1", teamId: "team-1" })
  })

  test("returns nothing when a configured pair does not exist", () => {
    expect(selectProfile(profiles, "instance-9", "team-9")).toBeUndefined()
    expect(selectProfile([])).toBeUndefined()
  })
})

describe("fetchBobProfiles", () => {
  test("calls the admin service and sends the credential's own scheme", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      seenHeaders = init?.headers as Record<string, string>
      return jsonResponse(profilePayload())
    }) as unknown as typeof fetch

    const profiles = await fetchBobProfiles("bob-key", "Apikey")

    expect(seenUrl).toBe("https://api.us-east.bob.ibm.com/admin/v1/profile")
    expect(seenHeaders.Authorization).toBe("Apikey bob-key")
    expect(seenHeaders["User-Agent"]).toContain("opencode-ibm-bob/")
    expect(profiles[0]?.teamId).toBe("team-1")
  })

  test("never sends routing headers, since it is what resolves them", async () => {
    process.env.IBM_BOB_INSTANCE_ID = "configured-instance"
    process.env.IBM_BOB_TEAM_ID = "configured-team"
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>
      return jsonResponse(profilePayload())
    }) as unknown as typeof fetch

    await fetchBobProfiles("token", "Bearer")

    expect(seenHeaders["x-instance-id"]).toBeUndefined()
    expect(seenHeaders["x-team-id"]).toBeUndefined()
  })

  test("follows IBM_BOB_AUTH_BASE_URL", async () => {
    process.env.IBM_BOB_AUTH_BASE_URL = "https://bob.internal.example"
    let seenUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input)
      return jsonResponse(profilePayload())
    }) as unknown as typeof fetch

    await fetchBobProfiles("token", "Bearer")

    expect(seenUrl).toBe("https://bob.internal.example/admin/v1/profile")
  })

  test("reports an HTTP failure with the response body", async () => {
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch
    await expect(fetchBobProfiles("token", "Bearer")).rejects.toThrow(/403 denied/)
  })

  test("reports a timeout", async () => {
    process.env.IBM_BOB_PROFILE_DISCOVERY_TIMEOUT_MS = "10"
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch

    await expect(fetchBobProfiles("token", "Bearer")).rejects.toThrow(/timed out after 10ms/)
  })
})

describe("profile cache", () => {
  test("round-trips through the cache file", () => {
    const profiles = [{ instanceId: "instance-1", instanceName: "bob-001", teamId: "team-1", teamName: "default" }]
    writeCachedProfiles(profiles)

    expect(readCachedProfiles()?.profiles).toEqual(profiles)
    expect(JSON.parse(readFileSync(profileCacheFile(), "utf8")).origin).toBe("https://api.us-east.bob.ibm.com")
  })

  test("holds no credential", () => {
    writeCachedProfiles([{ instanceId: "instance-1", teamId: "team-1" }])
    const raw = readFileSync(profileCacheFile(), "utf8")
    expect(raw).not.toContain("Bearer")
    expect(raw).not.toContain("Apikey")
  })

  test("ignores a cache written for another origin", () => {
    writeCachedProfiles([{ instanceId: "instance-1", teamId: "team-1" }])
    process.env.IBM_BOB_BASE_URL = "https://bob.internal.example/inference/v1"
    expect(readCachedProfiles()).toBeUndefined()
  })

  test("ignores a corrupt cache", () => {
    writeFileSync(profileCacheFile(), "{not json")
    expect(readCachedProfiles()).toBeUndefined()
  })

  test("sanitizes entries read back from disk", () => {
    expect(sanitizeProfiles([{ instanceId: "instance-1" }, { teamId: "orphan" }, 7])).toEqual([
      { instanceId: "instance-1" },
    ])
    expect(sanitizeProfiles("nope")).toBeUndefined()
    expect(sanitizeProfiles([])).toBeUndefined()
  })
})

describe("BobProfileResolver", () => {
  test("fetches once, then serves the memo", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse(profilePayload())
    }) as unknown as typeof fetch

    const resolver = new BobProfileResolver()
    expect((await resolver.resolve("token", "Bearer"))?.teamId).toBe("team-1")
    expect((await resolver.resolve("token", "Bearer"))?.teamId).toBe("team-1")
    expect(calls).toBe(1)
  })

  test("serves a fresh disk cache without any request", async () => {
    writeCachedProfiles([{ instanceId: "cached-instance", teamId: "cached-team" }])
    globalThis.fetch = (async () => {
      throw new Error("should not be called")
    }) as unknown as typeof fetch

    expect((await new BobProfileResolver().resolve("token", "Bearer"))?.teamId).toBe("cached-team")
  })

  test("refetches once the cache is older than the TTL", async () => {
    writeCachedProfiles([{ instanceId: "stale-instance", teamId: "stale-team" }])
    process.env.IBM_BOB_PROFILE_TTL_MS = "1"
    await Bun.sleep(5)
    globalThis.fetch = (async () => jsonResponse(profilePayload())) as unknown as typeof fetch

    expect((await new BobProfileResolver().resolve("token", "Bearer"))?.teamId).toBe("team-1")
  })

  test("falls back to the stale cache when discovery fails", async () => {
    writeCachedProfiles([{ instanceId: "stale-instance", teamId: "stale-team" }])
    process.env.IBM_BOB_PROFILE_TTL_MS = "1"
    await Bun.sleep(5)
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch

    expect((await new BobProfileResolver().resolve("token", "Bearer"))?.teamId).toBe("stale-team")
  })

  test("stays quiet when discovery is disabled", async () => {
    process.env.IBM_BOB_DISCOVER_PROFILE = "false"
    globalThis.fetch = (async () => {
      throw new Error("should not be called")
    }) as unknown as typeof fetch

    expect(await new BobProfileResolver().resolve("token", "Bearer")).toBeUndefined()
  })

  test("makes no request without a credential", async () => {
    globalThis.fetch = (async () => {
      throw new Error("should not be called")
    }) as unknown as typeof fetch

    expect(await new BobProfileResolver().resolve(undefined, "Bearer")).toBeUndefined()
  })

  test("shares one in-flight request between concurrent callers", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      await Bun.sleep(5)
      return jsonResponse(profilePayload())
    }) as unknown as typeof fetch

    const resolver = new BobProfileResolver()
    const [a, b] = await Promise.all([resolver.resolve("token", "Bearer"), resolver.resolve("token", "Bearer")])

    expect(calls).toBe(1)
    expect(a?.teamId).toBe("team-1")
    expect(b?.teamId).toBe("team-1")
  })
})
