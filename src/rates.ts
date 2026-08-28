import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isRecord, safeLabel } from "./catalog.ts"
import { bobOrigin, env, errorMessage, log } from "./env.ts"

/**
 * Bob publishes no price: every model reports `input_cost_per_token: 0`, and
 * the only figure it ever returns is the Bobcoin amount charged for a given
 * response. Rates are therefore learned from real traffic and cached, so the
 * next OpenCode start can price the models.
 */
export interface BobRate {
  /** Bobcoins per million input tokens. */
  input: number
  /** Bobcoins per million output tokens. */
  output: number
  /** Responses the estimate is based on. */
  samples: number
}

/** Running sums per model, enough to fit input and output rates by least squares. */
interface RateSums {
  n: number
  in: number
  out: number
  credits: number
  inIn: number
  inOut: number
  outOut: number
  inCredits: number
  outCredits: number
}

interface CachedRates {
  version: number
  updated: number
  origin: string
  models: Record<string, RateSums>
}

const CACHE_VERSION = 1
/** Below this the normal equations are ill-conditioned, so a blended rate is used. */
const MIN_DETERMINANT = 1e-6

/** Trims the floating-point dust a least-squares fit leaves on an exact rate. */
function tidy(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function emptySums(): RateSums {
  return { n: 0, in: 0, out: 0, credits: 0, inIn: 0, inOut: 0, outOut: 0, inCredits: 0, outCredits: 0 }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Fits `credits = input * inputTokens + output * outputTokens`.
 *
 * Two unknowns need observations with differing input/output ratios; until the
 * traffic provides that, the fit is degenerate and a single blended rate — the
 * exact answer whenever Bob prices both sides alike, as it does for `premium`
 * and `ultra` — is used instead.
 */
export function solveRate(sums: RateSums): BobRate | undefined {
  if (sums.n === 0) return undefined
  const tokens = sums.in + sums.out
  if (tokens <= 0) return undefined

  const blended = tidy((sums.credits / tokens) * 1e6)
  const determinant = sums.inIn * sums.outOut - sums.inOut * sums.inOut
  if (sums.n < 2 || Math.abs(determinant) < MIN_DETERMINANT * sums.inIn * sums.outOut) {
    return { input: blended, output: blended, samples: sums.n }
  }

  const input = tidy(((sums.inCredits * sums.outOut - sums.outCredits * sums.inOut) / determinant) * 1e6)
  const output = tidy(((sums.inIn * sums.outCredits - sums.inOut * sums.inCredits) / determinant) * 1e6)
  // A negative rate means the fit is being driven by rounding noise in Bob's
  // six-decimal credits, so the blended figure is the trustworthy one.
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return { input: blended, output: blended, samples: sums.n }
  }
  return { input, output, samples: sums.n }
}

/** Learns and remembers what Bob charges per model. */
export class BobRates {
  private models = new Map<string, RateSums>()
  private dirty = false

  constructor() {
    for (const [id, sums] of Object.entries(readCachedRates() ?? {})) this.models.set(id, sums)
  }

  record(modelId: string, inputTokens: number, outputTokens: number, credits: number): void {
    if (!modelId || inputTokens + outputTokens <= 0) return
    const sums = this.models.get(modelId) ?? emptySums()
    sums.n++
    sums.in += inputTokens
    sums.out += outputTokens
    sums.credits += credits
    sums.inIn += inputTokens * inputTokens
    sums.inOut += inputTokens * outputTokens
    sums.outOut += outputTokens * outputTokens
    sums.inCredits += inputTokens * credits
    sums.outCredits += outputTokens * credits
    this.models.set(modelId, sums)
    this.dirty = true

    const rate = solveRate(sums)
    if (rate) {
      log(
        `${modelId}: ${rate.input.toFixed(3)} in / ${rate.output.toFixed(3)} out ` +
          `Bobcoins per million tokens (${rate.samples} sample(s))`,
      )
    }
  }

  rate(modelId: string): BobRate | undefined {
    const sums = this.models.get(modelId)
    return sums ? solveRate(sums) : undefined
  }

  all(): Record<string, BobRate> {
    const rates: Record<string, BobRate> = {}
    for (const [id, sums] of this.models) {
      const rate = solveRate(sums)
      if (rate) rates[id] = rate
    }
    return rates
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    writeCachedRates(Object.fromEntries(this.models))
  }
}

export function rateCacheFile(): string {
  const explicit = env("IBM_BOB_RATE_CACHE")
  if (explicit) return explicit
  const base = env("XDG_CACHE_HOME") ?? join(homedir(), ".cache")
  return join(base, "opencode", "ibm-bob", "rates.json")
}

export function sanitizeRateSums(value: unknown): Record<string, RateSums> | undefined {
  if (!isRecord(value)) return undefined
  const models: Record<string, RateSums> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (!safeLabel(id) || !isRecord(entry)) continue
    const sums = emptySums()
    let usable = true
    for (const key of Object.keys(sums) as (keyof RateSums)[]) {
      const parsed = finiteNumber(entry[key])
      if (parsed === undefined) {
        usable = false
        break
      }
      sums[key] = parsed
    }
    if (usable && sums.n > 0) models[id] = sums
  }
  return Object.keys(models).length > 0 ? models : undefined
}

/** Rates are scoped to the origin that produced them and hold no credentials. */
export function readCachedRates(): Record<string, RateSums> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(rateCacheFile(), "utf8"))
    if (!isRecord(parsed)) return undefined
    if (parsed.version !== CACHE_VERSION) return undefined
    if (safeLabel(parsed.origin) !== bobOrigin()) return undefined
    return sanitizeRateSums(parsed.models)
  } catch {
    return undefined
  }
}

export function writeCachedRates(models: Record<string, RateSums>): void {
  const payload: CachedRates = { version: CACHE_VERSION, updated: Date.now(), origin: bobOrigin(), models }
  try {
    const file = rateCacheFile()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  } catch (error) {
    log(`failed to cache the Bobcoin rates: ${errorMessage(error)}`)
  }
}
