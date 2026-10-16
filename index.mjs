const PROVIDER = "synthetic"
const BASE = "https://api.synthetic.new/openai/v1"
const QUOTAS_URL = "https://api.synthetic.new/v2/quotas"

const HOUR = 3600
const DAY = 24 * HOUR

// Models shown before anyone signs in; the provider.models hook replaces
// this list with the account's real one once an API key is stored.
const DEFAULT_MODELS = {
  "syn:large:text": { name: "Synthetic Large (text)", limit: { context: 256000, output: 32768 }, tool_call: true },
  "syn:small:text": { name: "Synthetic Small (text)", limit: { context: 256000, output: 32768 }, tool_call: true },
  "syn:large:vision": { name: "Synthetic Large (vision)", limit: { context: 256000, output: 32768 }, tool_call: true },
  "syn:small:vision": { name: "Synthetic Small (vision)", limit: { context: 256000, output: 32768 }, tool_call: true },
}

const quotaBody = (body) => (body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body) || {}

const pct = (used, max) => Math.round((used / max) * 100)

// GET /v2/quotas -> magpie usage result.
// Response shape (all sections optional):
//   subscription:        { limit, requests, renewsAt }              legacy per-billing-period counter
//   search.hourly:       { limit, requests, renewsAt }              search quota, separate lane
//   freeToolCalls:       { limit, requests, renewsAt }              free tool-call lane, when granted
//   weeklyTokenLimit:    { percentRemaining, nextRegenAt, maxCredits, remainingCredits }
//   rollingFiveHourLimit:{ remaining, max, limited, nextTickAt }    burst request limit
function quotasToUsage(body) {
  const q = quotaBody(body)
  const windows = []

  const five = q.rollingFiveHourLimit
  if (five && typeof five.max === "number" && five.max > 0) {
    const usedReqs = Math.max(0, five.max - (typeof five.remaining === "number" ? five.remaining : five.max))
    windows.push({
      name: "5 hours",
      used: pct(usedReqs, five.max),
      resetsAt: five.nextTickAt,
      span: 5 * HOUR,
      display: `${usedReqs} / ${five.max} requests`,
    })
  }

  const weekly = q.weeklyTokenLimit
  if (weekly && typeof weekly.percentRemaining === "number") {
    const usedPct = Math.min(100, Math.max(0, 100 - weekly.percentRemaining))
    windows.push({
      name: "weekly",
      used: Math.round(usedPct),
      resetsAt: weekly.nextRegenAt,
      span: 7 * DAY,
      display:
        weekly.remainingCredits && weekly.maxCredits
          ? `${weekly.remainingCredits} / ${weekly.maxCredits} credits`
          : `${Math.round(weekly.percentRemaining)}% credits remaining`,
    })
  }

  const tools = q.freeToolCalls
  if (tools && typeof tools.limit === "number" && tools.limit > 0) {
    windows.push({
      name: "tool calls",
      used: pct(tools.requests ?? 0, tools.limit),
      resetsAt: tools.renewsAt,
      span: DAY,
      display: `${tools.requests ?? 0} / ${tools.limit} tool calls`,
      aside: true,
    })
  }

  const hourly = q.search?.hourly
  if (hourly && typeof hourly.limit === "number" && hourly.limit > 0) {
    windows.push({
      name: "search / hour",
      used: pct(hourly.requests ?? 0, hourly.limit),
      resetsAt: hourly.renewsAt,
      span: HOUR,
      display: `${hourly.requests ?? 0} / ${hourly.limit} searches`,
      aside: true, // the search lane never blocks chat
    })
  }

  const sub = q.subscription
  if (sub && typeof sub.limit === "number" && sub.limit > 0) {
    windows.push({
      name: "billing period",
      used: pct(sub.requests ?? 0, sub.limit),
      resetsAt: sub.renewsAt,
      display: `${sub.requests ?? 0} / ${sub.limit} requests`,
      aside: true, // legacy counter; the 5h and weekly lanes above are authoritative
    })
  }

  return { windows }
}

async function readQuotas(key) {
  const res = await fetch(QUOTAS_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  })
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("Synthetic refused the sign-in; sign in again"), { signIn: "expired" })
  }
  if (!res.ok) return { error: `Synthetic answered ${res.status}`, windows: [] }
  return quotasToUsage(await res.json())
}

export const SyntheticPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Synthetic",
      npm: "@ai-sdk/openai-compatible", // chat completions
      api: BASE,
      models: DEFAULT_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "Synthetic API key", placeholder: "syn_…" }],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      return {
        baseURL: BASE,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${auth.key}`)
          return fetch(input, { ...init, headers })
        },
      }
    },

    // magpie's own hook: how much of the subscription is used
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return { error: "No Synthetic API key", windows: [] }
      return readQuotas(auth.key)
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api") return provider.models
      const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${auth.key}` } })
      if (!res.ok) return provider.models // magpie keeps the list it had
      const { data } = await res.json()
      if (!Array.isArray(data) || data.length === 0) return provider.models
      const base = provider.models["syn:large:text"] ?? Object.values(provider.models)[0] ?? {}
      return Object.fromEntries(
        data.map((m) => [
          m.id,
          {
            ...base,
            id: m.id,
            name: m.name ?? m.id,
            ...(m.context_length ? { limit: { context: m.context_length, output: m.context_length } } : {}),
          },
        ]),
      )
    },
  },
})

export const _internal = { quotasToUsage, quotaBody }
