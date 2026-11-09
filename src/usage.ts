import { authSchemeFor, type BobTokenResolver } from "./auth.ts"
import { fetchBobBudget, formatBobcoins, formatDollars, writeCachedBudget, type BobSpend } from "./cost.ts"
import { errorMessage, log } from "./env.ts"
import type { BobProfileResolver } from "./profile.ts"

/**
 * The `bob_usage` tool's report, shared by the V1 and V2 entry points. Bob
 * prices usage in Bobcoins, not per token, so this reports what was actually
 * spent: this session, and the team against its budget.
 */
export async function bobUsageReport(
  resolver: BobTokenResolver,
  profiles: BobProfileResolver,
  spend: BobSpend,
): Promise<string> {
  // The turn that calls this tool has not been billed yet, so its own cost
  // only appears on the next call.
  const lines = [
    `This session so far: ${formatBobcoins(spend.total)} Bobcoins (${formatDollars(spend.total)}) ` +
      `over ${spend.count} billed response(s).`,
  ]

  const token = await resolver.resolve()
  const profile = token ? await profiles.resolve(token, authSchemeFor(token)) : undefined
  if (!token || !profile) {
    lines.push("Team usage is unavailable: no IBM Bob credential resolved.")
    return lines.join("\n")
  }

  const team = profile.teamName ?? profile.teamId ?? "unknown"
  // The profile already carries a usage figure; the budget endpoint has the
  // fresher per-member one, so it is preferred when reachable.
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
  return lines.join("\n")
}
