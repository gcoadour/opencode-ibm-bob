import { isRecord, readBoundedResponseBody, truncateHttpBody } from "./catalog.ts"
import { DEFAULT_BUDGET_TIMEOUT_MS, adminBaseUrl, envInt, errorMessage, log, routingHeaders } from "./env.ts"
import { BOBCOIN_USD } from "./models.ts"
import type { BobProfile } from "./profile.ts"

/**
 * Bob prices usage in Bobcoins rather than per token: `/model/info` reports a
 * zero token price, and each inference response carries the amount actually
 * spent in `usage.credits`. Bob Shell reads the same field.
 */
export interface BobBudget {
  usage: number
  budgetLimit?: number
}

/**
 * Bob Shell's precision ladder, extended with one finer step: a single request
 * can cost less than 0.0001 Bobcoin, which Bob Shell's last rung would print as
 * a flat "0.0000".
 */
export function formatBobcoins(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0000"
  if (value >= 1) return value.toFixed(2)
  if (value >= 0.01) return value.toFixed(3)
  if (value >= 0.0001) return value.toFixed(4)
  return value.toFixed(6)
}

/** What Bob charged for one response, and the tokens it charged for. */
export interface BobUsage {
  credits: number
  inputTokens: number
  outputTokens: number
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

export function extractUsage(payload: unknown): BobUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined
  const credits = payload.usage.credits
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return undefined
  return {
    credits,
    inputTokens: tokenCount(payload.usage.prompt_tokens),
    outputTokens: tokenCount(payload.usage.completion_tokens),
  }
}

/** Bobcoins converted to the money they represent. */
export function formatDollars(bobcoins: number): string {
  if (!Number.isFinite(bobcoins) || bobcoins <= 0) return "$0.00"
  const dollars = bobcoins * BOBCOIN_USD
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`
  // A single request costs a fraction of a cent; rounding it to $0.00 hides it.
  return `$${dollars >= 0.0001 ? dollars.toFixed(4) : dollars.toFixed(6)}`
}

export function extractCredits(payload: unknown): number | undefined {
  return extractUsage(payload)?.credits
}

/**
 * Reads the spend out of a completion response, whether Bob answered with a
 * single JSON object or an SSE stream whose last chunks carry the usage.
 */
export function usageFromBody(body: string): BobUsage | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined

  if (!trimmed.startsWith("data:")) {
    try {
      return extractUsage(JSON.parse(trimmed))
    } catch {
      return undefined
    }
  }

  // Streaming: the usage chunk is emitted last, so the final match wins.
  let usage: BobUsage | undefined
  for (const line of trimmed.split("\n")) {
    const data = line.trim()
    if (!data.startsWith("data:")) continue
    const payload = data.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      usage = extractUsage(JSON.parse(payload)) ?? usage
    } catch {
      // A partial chunk is not an error; the next one may still carry usage.
    }
  }
  return usage
}

export function creditsFromBody(body: string): number | undefined {
  return usageFromBody(body)?.credits
}

/** Bobcoins spent through this OpenCode session. */
export class BobSpend {
  private credits = 0
  private requests = 0

  record(credits: number): void {
    this.credits += credits
    this.requests++
    log(`spent ${formatBobcoins(credits)} Bobcoins (session total ${formatBobcoins(this.credits)})`)
  }

  get total(): number {
    return this.credits
  }

  get count(): number {
    return this.requests
  }

  /**
   * Extracts the spend from a response without disturbing the one OpenCode
   * consumes, and never lets an accounting failure break a request.
   */
  observe(response: Response): void {
    const type = response.headers.get("content-type") ?? ""
    if (!/json|event-stream/i.test(type) || !response.body) return
    let clone: Response
    try {
      clone = response.clone()
    } catch {
      return
    }
    void (async () => {
      try {
        const usage = usageFromBody(await readBoundedResponseBody(clone))
        if (usage) this.record(usage.credits)
      } catch (error) {
        log(`could not read the Bobcoin cost of a response: ${errorMessage(error)}`)
      }
    })()
  }
}

/**
 * Reads the team member's Bobcoin usage from Bob's admin service, the same
 * `GET /admin/v1/teams/{team}/users/{user}` call Bob Shell makes to show a
 * budget.
 */
export async function fetchBobBudget(
  accessToken: string,
  authScheme: string,
  profile: BobProfile & { teamId: string; instanceUserId: string },
): Promise<BobBudget> {
  const { teamId, instanceUserId: userId } = profile
  const controller = new AbortController()
  const timeoutMs = envInt("IBM_BOB_BUDGET_TIMEOUT_MS", DEFAULT_BUDGET_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const url = `${adminBaseUrl()}/teams/${encodeURIComponent(teamId)}/users/${encodeURIComponent(userId)}`

  log(`budget -> ${url} (timeout=${timeoutMs}ms)`)
  try {
    const response = await fetch(url, {
      method: "GET",
      // Unlike `/profile`, this route rejects a request without `x-instance-id`.
      headers: {
        ...routingHeaders(undefined, profile),
        Accept: "application/json",
        Authorization: `${authScheme} ${accessToken}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = truncateHttpBody(await readBoundedResponseBody(response))
      throw new Error(`IBM Bob budget lookup failed: ${response.status} ${body}`.trim())
    }
    const payload: unknown = JSON.parse(await readBoundedResponseBody(response))
    if (!isRecord(payload) || typeof payload.usage !== "number") {
      throw new Error("IBM Bob budget response did not contain a usage figure.")
    }
    return {
      usage: payload.usage,
      ...(typeof payload.budget_limit === "number" ? { budgetLimit: payload.budget_limit } : {}),
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`IBM Bob budget lookup timed out after ${timeoutMs}ms.`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
