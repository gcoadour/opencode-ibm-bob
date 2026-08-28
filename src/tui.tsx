import type { Message } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { formatBobcoins, readCachedBudget, type CachedBudget } from "./cost.ts"

const SIDEBAR_CONTEXT_PLUGIN_ID = "internal:sidebar-context"

// bob.ibm.com/pricing pairs "N Bobcoins" with Lucide's generic "coins" icon
// (aria-label "Bobcoin", two overlapping discs). OpenTUI has no image
// component at all (verified against its compiled component catalogue), so
// this uses plain Unicode draughts-piece glyphs instead of an emoji: they
// render as two overlapping coin-like discs without depending on an emoji
// font being installed.
const BOBCOIN_ICON = "⛀⛁"

// The team budget only changes server-side; polling the cache file the
// server writes to is simpler than wiring a live cross-process event.
const BUDGET_POLL_MS = 15_000

function lastAssistantWithOutput(messages: readonly Message[]): Extract<Message, { role: "assistant" }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === "assistant" && message.tokens.output > 0) return message
  }
  return undefined
}

/**
 * Only the server process resolves an IBM Bob credential (the TUI has no
 * auth access at all), so it periodically writes the team's Bobcoin budget
 * to a cache file; this reads it back and re-polls it on an interval since
 * there is no push channel between the two processes.
 */
function useCachedBudget() {
  const [budget, setBudget] = createSignal<CachedBudget | undefined>(readCachedBudget())
  const interval = setInterval(() => setBudget(readCachedBudget()), BUDGET_POLL_MS)
  onCleanup(() => clearInterval(interval))
  return budget
}

function SidebarBobcoins(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const messages = () => props.api.state.session.messages(props.session_id)
  const budget = useCachedBudget()

  const usage = () => {
    const last = lastAssistantWithOutput(messages())
    if (!last) return { tokens: 0, percent: null as number | null }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((provider) => provider.id === last.providerID)?.models[last.modelID]
    return { tokens, percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null }
  }

  const planLine = () => {
    const cached = budget()
    if (!cached) return "usage unavailable"
    const { usage, budgetLimit } = cached.budget
    if (budgetLimit === undefined) return `${formatBobcoins(usage)} Bobcoins used`
    return `${formatBobcoins(usage)} / ${formatBobcoins(budgetLimit)} Bobcoins`
  }

  return (
    <box>
      <text>
        <b style={{ fg: theme().text }}>Context</b>
        <span style={{ fg: theme().textMuted }}> {usage().tokens.toLocaleString()} tokens</span>
        <span style={{ fg: theme().textMuted }}> {usage().percent ?? 0}% used</span>
      </text>
      <text>
        <b style={{ fg: theme().text }}>{BOBCOIN_ICON}</b>
        <span style={{ fg: theme().textMuted }}> {planLine()}</span>
      </text>
    </box>
  )
}

const tui = async (api: TuiPluginApi) => {
  try {
    await api.plugins.deactivate(SIDEBAR_CONTEXT_PLUGIN_ID)
  } catch {
    // Already disabled, or this OpenCode build doesn't ship it; either way
    // there's nothing to replace and the slot registration below still runs.
  }

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content: (_context: TuiSlotContext, props: { session_id: string }) => (
        <SidebarBobcoins api={api} session_id={props.session_id} />
      ),
    },
  })
}

export default { id: "ibm-bob-sidebar", tui } satisfies TuiPluginModule
