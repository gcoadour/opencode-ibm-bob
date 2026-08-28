# opencode-ibm-bob

OpenCode plugin for IBM Bob / IBM-approved enterprise model endpoints.

It is the [OpenCode](https://opencode.ai) counterpart of the Pi extension
[`pi-bob`](https://github.com/songlining/pi-bob): it registers Bob as the
`ibm-bob` provider, discovers the model catalog Bob exposes to your account, and
adds Bob's browser SSO to `opencode auth login`.

The plugin does not scrape Bob, does not read Bob Shell's stored SSO secrets, and
does not bypass IBM-approved access paths. SSO tokens are obtained through Bob's
own browser login endpoints and stored in OpenCode's auth store.

## What it does

| Hook | Effect |
| --- | --- |
| `config` | Registers the `ibm-bob` provider (name, adapter package, base URL, models, routing headers) so Bob models show up in `/models`, `opencode models` and `--model ibm-bob/premium`. |
| `auth` | Adds **IBM Bob SSO (browser)** and **IBM Bob API key** to `opencode auth login`, refreshes expired SSO tokens, and attaches the credential, Bob's auth scheme and the instance/team routing headers to every request. |

Bob requires an `x-instance-id` header and, for SSO tokens, a matching
`x-team-id`; without the team it answers `402 team user not found or has been
deleted`. Neither the SSO callback nor the JWT carries a team, so the plugin
resolves the pair from Bob's own `GET /admin/v1/profile`, exactly as Bob Shell
does. See [Instance and team routing](#instance-and-team-routing).

Bob authenticates approved API keys with `Authorization: Apikey <key>` (Bob
Shell's own scheme) and SSO tokens with `Authorization: Bearer <jwt>`, while the
AI SDK adapters send `Bearer` or `x-api-key` for whatever credential they are
given. The plugin therefore rewrites that header per request; use
`IBM_BOB_AUTH_SCHEME` if your endpoint expects a different scheme.

## Install

From npm, in the OpenCode config (`opencode.json` in the project, or
`~/.config/opencode/opencode.json` globally):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ibm-bob"]
}
```

From a checkout, point the same entry at the repository directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-ibm-bob"]
}
```

`opencode.example.json` in this package is a ready-to-copy configuration.

## Quick start

### Bob SSO

```bash
opencode auth login       # pick "IBM Bob", then "IBM Bob SSO (browser)"
opencode models | grep ibm-bob
opencode run -m ibm-bob/premium "say hi"
```

The browser opens Bob's login page with a `callback_uri` pointing at a local
one-shot listener; the returned code is exchanged at
`POST /authn/v1/auth/token`, and OpenCode stores the access/refresh pair in its
own auth store (`~/.local/share/opencode/auth.json`). Expired tokens are
refreshed at `POST /authn/v1/auth/refresh` and written back through OpenCode's
auth API.

Do **not** copy a token out of Bob's local credential store unless IBM policy
explicitly permits it — use the SSO login.

### Approved API key

```bash
export IBM_BOB_API_KEY="..."   # IBM_BOB_KEY is also accepted; do not commit either
opencode models | grep ibm-bob
opencode run -m ibm-bob/premium "say hi"
```

`opencode auth login` → **IBM Bob API key** stores the same credential in the
auth store instead of the environment.

Resolution order for the credential is: what OpenCode stored for the provider
(SSO or API key), then `IBM_BOB_API_KEY`, then `IBM_BOB_KEY`. Run
`opencode auth logout` for `ibm-bob` before switching from SSO back to an
environment key.

## Model discovery

Discovery is on by default and reads Bob's authenticated
`GET /inference/v1/model/info`:

- With `IBM_BOB_API_KEY` / `IBM_BOB_KEY` set, the catalog is fetched while the
  config is built, so the models are registered for the current session.
- After an SSO login, the catalog is fetched once the token is exchanged and
  cached on disk. OpenCode has already registered the provider's models by the
  time the auth loader runs, so **an SSO-discovered catalog is applied at the
  next OpenCode start**; until then the fallback models are used.
- The cache is refreshed in the background (once per session) when it is older
  than `IBM_BOB_CATALOG_TTL_MS`.

Only `model_name` and `model_info` are required, because Bob's API-key view of
the endpoint reports just those; other views also carry `litellm_params.model`
(the backend route behind the alias) and an `exposed` flag. Routes marked
`exposed: false` or `completion_only: true` are dropped, everything else is
kept, and Bob still enforces route access during inference. Failures, timeouts,
malformed payloads and empty catalogs fall back to the cached catalog, then to
`IBM_BOB_MODELS`.

Discovered context limits, output limits, vision support, reasoning support,
backend identifiers and token prices are mapped into OpenCode model entries. Bob
reports prices per token; OpenCode displays them per million tokens, and the
plugin performs that conversion.

The cache lives in `${XDG_CACHE_HOME:-~/.cache}/opencode/ibm-bob/catalog.json`,
is scoped to the base URL that produced it, and holds no credentials.

## Instance and team routing

Bob routes every request with an instance and, for SSO credentials, a team.
The plugin resolves them in this order:

1. `IBM_BOB_INSTANCE_ID` / `IBM_BOB_TEAM_ID`
2. Bob Shell's non-secret `ibm.instanceId` / `ibm.teamId` in `~/.bob/settings.json`
3. Bob's authenticated `GET /admin/v1/profile`, cached on disk
4. the first instance in the SSO token, as a last resort for `x-instance-id`

Step 3 is what makes an SSO login work on its own. `/admin/v1/profile` returns
the instances the account belongs to and the teams inside each one; the plugin
flattens that into (instance, team) pairs and picks the pair matching whatever
is configured, or the first one — the same selection Bob Shell performs. An
instance with no team still yields a usable entry, because API keys route
without a team.

Bob Shell 2.x no longer writes `ibm.instanceId` / `ibm.teamId` anywhere: it
resolves them from the same endpoint on every start, so step 2 only applies to
Bob Shell 1.x installations.

The cache lives in `${XDG_CACHE_HOME:-~/.cache}/opencode/ibm-bob/profile.json`,
is scoped to the origin that produced it, and holds no credentials.

## Configuration

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_ENABLED` | `true` | Set to `false` to leave the provider unregistered. |
| `IBM_BOB_BASE_URL` | `https://api.us-east.bob.ibm.com/inference/v1` | Approved Bob/IBM endpoint. The AI SDK adapters append their own route (`/chat/completions`, `/responses`, `/messages`). |
| `IBM_BOB_API_KEY` | unset | Approved API key/token. Keep it out of repo files. |
| `IBM_BOB_KEY` | unset | Alias for `IBM_BOB_API_KEY`, matching Bob Shell configuration. |
| `IBM_BOB_MODELS` | `premium` | Comma-separated fallback model IDs used when no catalog is available. |
| `IBM_BOB_DISCOVER_MODELS` | `true` | Discover visible models from `/model/info`. |
| `IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS` | `5000` | Discovery timeout. |
| `IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS` | `10000` | SSO token exchange/refresh timeout. |
| `IBM_BOB_LOGIN_TIMEOUT_MS` | `180000` | How long the SSO callback listener waits. |
| `IBM_BOB_SSO_PORT` | random free port | Fixed port for the local SSO callback listener. |
| `IBM_BOB_CATALOG_CACHE` | `${XDG_CACHE_HOME:-~/.cache}/opencode/ibm-bob/catalog.json` | Catalog cache file. |
| `IBM_BOB_CATALOG_TTL_MS` | `86400000` | Age after which the cached catalog is refreshed in the background. |
| `IBM_BOB_DISCOVER_PROFILE` | `true` | Resolve the instance/team pair from `/admin/v1/profile`. |
| `IBM_BOB_PROFILE_DISCOVERY_TIMEOUT_MS` | `5000` | Profile discovery timeout. |
| `IBM_BOB_PROFILE_CACHE` | `${XDG_CACHE_HOME:-~/.cache}/opencode/ibm-bob/profile.json` | Profile cache file. |
| `IBM_BOB_PROFILE_TTL_MS` | `86400000` | Age after which the cached profile is refetched. |
| `IBM_BOB_DEBUG` | `false` | Log discovery, token and login steps. |

### Adapter

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_API` | `openai-completions` | `openai-completions` (`@ai-sdk/openai-compatible`), `openai-responses` (`@ai-sdk/openai`) or `anthropic-messages` (`@ai-sdk/anthropic`). |
| `IBM_BOB_NPM` | adapter default | Override the AI SDK package used for the provider. |

Bob's documented route is the OpenAI-compatible one; the other two are for
IBM-approved endpoints that expose those APIs.

### Bob routing headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_READ_BOBSHELL_SETTINGS` | `true` | Read the non-secret `ibm.instanceId` / `ibm.teamId` from `~/.bob/settings.json` (Bob Shell 1.x only). Stored SSO secrets in that file are never read. |
| `IBM_BOB_INSTANCE_ID` | Bob Shell setting, else the discovered profile, else the SSO token's first instance | Override `x-instance-id`. |
| `IBM_BOB_TEAM_ID` | Bob Shell setting, else the discovered profile | Override `x-team-id`. |
| `IBM_BOB_USER_AGENT` | `opencode-ibm-bob/<version>` | User-Agent sent to Bob. |
| `IBM_BOB_HEADERS_JSON` | unset | JSON object of extra headers, e.g. `{"x-trace":"1"}`. |

### Auth header

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_AUTH_SCHEME` | `Apikey` | Scheme used for non-JWT credentials. SSO tokens always use `Bearer`. |
| `IBM_BOB_AUTH_BASE_URL` | origin of `IBM_BOB_BASE_URL` | Origin used for the `/authn/v1/auth/*` endpoints. |
| `IBM_BOB_WEB_LOGIN_URL` | `https://bob.ibm.com/login` (`public-dev` / `qa` hosts are mapped automatically) | Bob web login page used for SSO. |

### Model metadata

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_CONTEXT_WINDOW` | discovered; fallback `200000` | Context window for every Bob model. Keep it at or below the backend limit so OpenCode compacts before Bob rejects the request. |
| `IBM_BOB_MAX_TOKENS` | discovered; fallback `8192` | Maximum output tokens. |
| `IBM_BOB_INPUT` | discovered; fallback `text` | `text` or `text,image`. |
| `IBM_BOB_REASONING` | discovered; fallback `false` | Force reasoning support on or off. |
| `IBM_BOB_REASONING_MODELS` | empty | Comma-separated model IDs to mark as reasoning-capable. |

### Config overrides

Anything declared under `provider.ibm-bob` in your OpenCode config wins over what
the plugin generates, so a corporate endpoint or a pinned model list stays in
place:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ibm-bob"],
  "provider": {
    "ibm-bob": {
      "options": { "baseURL": "https://bob.internal.example/inference/v1" },
      "models": { "premium": { "limit": { "context": 150000, "output": 8192 } } }
    }
  }
}
```

## Development

```bash
bun install
bun test        # 88 tests
bun run typecheck
```

## Validation performed

Against the live `https://api.us-east.bob.ibm.com` endpoint with an approved API
key:

- `GET /inference/v1/model/info` returns `200`; the plugin registered the 13
  routes the account exposes (`premium`, `premium-ide`, `premium-shell`,
  `sonnet-4.5`, `fast`, `ultra`, `explorer`, `wxO-model`, `granite-8b-code-instruct`,
  `gpt-oss-20b`, …) and cached them.
- `opencode run -m ibm-bob/premium "Reply with exactly: bob-ok"` → `bob-ok`.
- `opencode run -m ibm-bob/fast …` → answered, so non-default aliases route too.
- A prompt requiring a tool call went through: the model invoked OpenCode's read
  tool and answered from its result.

Also verified locally:

- `bun test` — 88 tests covering catalog parsing (including the API-key payload
  shape, the `exposed` and `completion_only` filters), per-million price
  conversion, catalog cache round-trip and base-URL scoping, fallback and
  override model building, the `Apikey`/`Bearer` header rules, credential
  resolution order, SSO expiry/refresh/persistence, profile parsing and
  selection, profile cache round-trip and origin scoping, the routing-header
  precedence, and the `config`/`auth` hooks.
- `tsc --noEmit` — clean.
- Against a local stub of the Bob API, OpenCode issued
  `GET /inference/v1/model/info` and then `POST /inference/v1/chat/completions`
  with `Authorization: Apikey <key>`, `x-instance-id`, `x-team-id` and the
  plugin's User-Agent, and no `x-api-key` header.

The browser SSO round-trip was then verified end to end against the same live
endpoint, with no `IBM_BOB_*` variable set and no `~/.bob/settings.json`:

- `opencode auth login` → **IBM Bob SSO (browser)** stored an access/refresh
  pair, and `POST /authn/v1/auth/refresh` returned a rotated pair.
- Before profile discovery existed, inference failed with
  `402 team user not found or has been deleted`: Bob rejects an SSO token that
  carries no `x-team-id`, and neither the callback nor the JWT provides one.
- `GET /admin/v1/profile` returns `200` with the account's instance and its
  teams; the plugin now resolves the pair from it and caches it.
- `opencode run -m ibm-bob/premium "Reply with exactly: bob-ok"` → `bob-ok`,
  `-m ibm-bob/fast` answered, and a tool-calling prompt went through — all over
  SSO alone.

Not verified: multi-instance and multi-team accounts, which were exercised only
against parsed payloads and not a live account exposing more than one pair.

## License

MIT
