# free-pi gateway

Local OpenAI/Anthropic-compatible gateway in front of `free-pi-cli`.
One process, zero npm dependencies, reads the existing free-pi GitHub sign-in.

```
any agent  ->  http://127.0.0.1:8788/v1  ->  https://api.freepi.ai
```

The gateway has no models of its own and does not bypass free-pi. It signs every
request with the free-pi token on this machine and forwards it, so all free-pi
limits (daily credits, one session, ads) still apply.

It speaks two protocols, so **any agent that supports a custom OpenAI base URL
or a custom Anthropic base URL works with it** — no per-agent integration.

| Agent speaks | Use base URL |
|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8788/v1` |
| Anthropic Messages | `http://127.0.0.1:8788` |

---

## Quick start

Five commands, start to finish. Needs Node 22.15+.

```bash
# 1. sign in to free-pi once (GitHub device login), then quit the TUI
npx free-pi-cli@latest

# 2. start the gateway
cd /path/to/freepi-gateway
./run.sh

# 3. in a second terminal: check it is alive
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8788/v1/models
```

Then point any agent at `http://127.0.0.1:8788/v1` with any API key and a model
id from the list. Default port is `8788`, default model is `deepseek-v4-flash`.

Nothing to install, no `npm install`, no build step — the gateway has zero
dependencies and uses only the Node standard library.

---

## Part 1 — install free-pi (one time, per user)

The gateway reads the login that `free-pi-cli` creates. Nothing else works
until this step is done.

### 1.1 Node.js

free-pi needs **Node 22.15 or newer**.

```bash
node -v
# v22.19.0 or newer
```

If Node is missing or older, install it (nvm, distro package, or the official
installer). With nvm:

```bash
nvm install 22
nvm use 22
```

### 1.2 Run free-pi once and sign in

No clone, no checkout. Either run it through npx (nothing stays installed):

```bash
npx free-pi-cli@latest
```

or install it once as a global command:

```bash
npm install -g free-pi-cli
free-pi-cli
```

On the first run it shows the terms, then opens a GitHub device-login flow.
Sign in with the GitHub account you want to use. When the TUI appears, you are
signed in. Quit it (Ctrl+C or `/quit`) before starting the gateway — the free
tier allows one active session at a time.

Where things land:

| What | Path |
|---|---|
| Sign-in token (JWT) | `~/.free-pi/agent/credentials.json` |
| free-pi agent dir | `~/.free-pi/agent/` |
| Sessions | `~/.free-pi/agent/sessions/` |
| npx install cache | `~/.npm/_npx/` |
| global install | `$(npm prefix -g)/lib/node_modules/free-pi-cli` |

The gateway only needs `~/.free-pi/agent/credentials.json`. Keep that file
private (`chmod 600`); never copy it into a repo or another machine.

### 1.3 Check the account

```bash
npx free-pi-cli@latest --version
ls -l ~/.free-pi/agent/credentials.json
```

If free-pi refuses to start because of region restrictions, the gateway cannot
fix that — the account itself is blocked by the service.

---

## Part 2 — start the gateway

```bash
cd /path/to/freepi-gateway
./run.sh
```

You should see:

```
freepi-gateway listening on http://127.0.0.1:8788
  free-pi upstream : https://api.freepi.ai
  credentials      : /home/<you>/.free-pi/agent/credentials.json
```

Verify:

```bash
curl -s http://127.0.0.1:8788/health
# {"ok":true,...,"signedIn":true,"models":26}

curl -s http://127.0.0.1:8788/v1/models
```

### Autostart with systemd (user service)

The unit shipped in this folder is a **template**: `WorkingDirectory` and
`ExecStart` use `%h` (your home) plus one specific nvm node path. Rewrite both
to your real folder and your real `node` binary (`command -v node`):

```bash
mkdir -p ~/.config/systemd/user
sed -e "s#%h/freepi-gateway#$(pwd)#g" \
    -e "s#%h/.nvm/versions/node/v22.19.0/bin/node#$(command -v node)#g" \
    freepi-gateway.service > ~/.config/systemd/user/freepi-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now freepi-gateway
systemctl --user status freepi-gateway
journalctl --user -u freepi-gateway -f
```

Check the generated unit before enabling it if your paths are unusual:

```bash
grep -E 'WorkingDirectory|ExecStart' ~/.config/systemd/user/freepi-gateway.service
```

The service must run as the same user that signed in to free-pi, because it
reads `~/.free-pi/agent/credentials.json` from your real home.

Run the gateway in your normal user environment, not inside a sandboxed app
container — a separate home has no free-pi token.

---

## Part 3 — connect any agent

### Generic settings (works everywhere)

OpenAI-compatible agents:

| Field | Value |
|---|---|
| Provider type | OpenAI compatible / OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8788/v1` |
| API key | any non-empty value (or your `GATEWAY_API_KEY`) |
| Model | an id from `GET /v1/models` |

Anthropic-compatible agents:

| Field | Value |
|---|---|
| Provider type | Anthropic compatible / Anthropic Messages |
| Base URL | `http://127.0.0.1:8788` (root, no `/v1` — the client appends `/v1/messages`) |
| API key / auth token | any non-empty value |
| Model | an id from `GET /v1/models` |

Duplicated `/v1/v1/...` paths are accepted, so either base URL form works.

### Examples

**opencode** — `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freepi": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "free-pi gateway",
      "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "local" },
      "models": {
        "deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash" },
        "glm-5.3-flash": { "name": "GLM 5.3 Flash" },
        "particle": { "name": "Particle-1" }
      }
    }
  }
}
```

**Claude Code** (Anthropic protocol):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_AUTH_TOKEN=local
export ANTHROPIC_MODEL=deepseek-v4.1-flash
export ANTHROPIC_SMALL_FAST_MODEL=glm-5.3-flash
claude
```

**Cline / Roo / Continue / Aider / any OpenAI-compatible client** — pick
"OpenAI compatible", paste the base URL, paste any key, type a model id.

Unknown `claude-*` / `gpt-*` / `gemini-*` model names are routed to
`GATEWAY_DEFAULT_MODEL`, so set the model explicitly to avoid a silent
downgrade.

### Clients that only speak the OpenAI Responses API

`/v1/responses` is not implemented. Clients that require it will not work;
clients using `/chat/completions` or `/messages` do.

---

## Endpoints

| Protocol | Endpoint | Notes |
|---|---|---|
| OpenAI | `GET /v1/models` | live free-pi catalog, unavailable models filtered |
| OpenAI | `POST /v1/chat/completions` | streaming + non-streaming, tools pass through |
| OpenAI | `GET /v1/usage` | credits left today, refill, tier |
| Anthropic | `POST /v1/messages` | request/response + SSE translated to Anthropic Messages |
| Anthropic | `POST /v1/messages/count_tokens` | approximate token count (estimated) |
| Admin | `POST /admin/reset-session` | clears a stuck free-pi session lease |
| Health | `GET /health` | sign-in state, model count |

Models keep their free-pi ids, e.g. `deepseek-v4-flash`, `deepseek-v4.1-flash`,
`glm-5.3-flash`, `particle`, `gpt-6-luna`, `claude-haiku-5.5`, ...

## Repo layout

```
.
├── src/
│   ├── server.js      HTTP server, routing, auth, model alias fallback
│   ├── freepi.js      JWT loading, session id, FIFO queue, upstream calls
│   ├── anthropic.js   Anthropic <-> OpenAI request/response/SSE translation
│   └── config.js      env config and paths
├── data/              runtime only: session.json (git-ignored)
├── run.sh             manual start
├── freepi-gateway.service   systemd user unit template
└── package.json
```

Nothing in `data/` is needed to run the gateway from scratch — it is created on
first start. Never commit it; it holds a session id.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_HOST` | `127.0.0.1` | bind address |
| `GATEWAY_PORT` | `8788` | port |
| `GATEWAY_API_KEY` | empty | when set, clients must send `Bearer <key>` or `x-api-key` |
| `FREEPI_CREDENTIALS` | `~/.free-pi/agent/credentials.json` | JWT file |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | upstream |
| `FREEPI_CLIENT_VERSION` | `0.6.14` | value of `x-client-version` |
| `FREEPI_AUTO_RESET` | `0` | on `409 concurrent_session`, call `/session/reset` and retry once |
| `GATEWAY_DEFAULT_MODEL` | `deepseek-v4-flash` | used when a request omits `model` |
| `GATEWAY_MAX_QUEUE` | `64` | max waiting requests |
| `GATEWAY_QUEUE_WAIT_MS` | `300000` | max wait in queue |
| `GATEWAY_LOG_REQUESTS` | `1` | one log line per request |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 freepi_not_signed_in` | Free-pi was never signed in, or the token file is gone. Run `npx free-pi-cli@latest`, sign in, restart the gateway. |
| `401 freepi_token_expired` | Token expired. Sign in again with `npx free-pi-cli@latest`. |
| `409 concurrent_session` | A terminal `free-pi-cli` session (or a crashed one) holds the account lease. Close the CLI, or run `curl -X POST http://127.0.0.1:8788/admin/reset-session`, or start the gateway with `FREEPI_AUTO_RESET=1`. |
| `429 daily_cap` / `ads_required` | free-pi allowance or ad requirement. The gateway only forwards the server's answer. |
| systemd `status=203/EXEC` | Wrong `node` path in the unit. Set `ExecStart` to `command -v node`. |
| Agent connects but every call waits | Free tier runs one completion at a time; parallel turns queue. |
| `404` on `/v1/responses` | Not implemented; use a chat-completions or messages client. |

## free-pi facts that shape this gateway

- Free tier allows **one completion at a time per account**. The gateway
  serializes upstream calls with a FIFO queue; a second request waits instead
  of failing.
- A terminal `free-pi-cli` session holds an account lease. While it runs,
  gateway completions get `409 concurrent_session`.
- `x-session-id` is persisted in `data/session.json` and sent on every request.
- Free access is ad/allowance funded; daily credits apply to every agent turn.

## Smoke tests

```bash
# models
curl -s http://127.0.0.1:8788/v1/models

# OpenAI, non-stream
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'

# OpenAI, stream
curl -N http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic, non-stream
curl -s http://127.0.0.1:8788/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5.3-flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```
