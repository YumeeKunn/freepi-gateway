import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function semverParts(v) {
  return String(v)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

function compareSemver(a, b) {
  const A = semverParts(a);
  const B = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (A[i] !== B[i]) return A[i] - B[i];
  }
  return 0;
}

// free-pi rejects requests when x-client-version is below its minimum. Use the
// newest free-pi-cli found in the npx cache, so a `npx free-pi-cli@latest` run
// also updates what the gateway reports.
function detectClientVersion(fallback) {
  if (process.env.FREEPI_CLIENT_VERSION) return process.env.FREEPI_CLIENT_VERSION;

  let best = null;
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  try {
    for (const dir of fs.readdirSync(npxRoot)) {
      const pkg = path.join(npxRoot, dir, "node_modules", "free-pi-cli", "package.json");
      try {
        const version = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
        if (typeof version === "string" && (best === null || compareSemver(version, best) > 0)) {
          best = version;
        }
      } catch {
        // no free-pi-cli in this cache dir
      }
    }
  } catch {
    // no npx cache
  }
  return best || fallback;
}

export const config = {
  host: process.env.GATEWAY_HOST || "127.0.0.1",
  port: int("GATEWAY_PORT", 8788),

  freepiBaseUrl: (process.env.FREEPI_BASE_URL || "https://api.freepi.ai").replace(/\/+$/, ""),
  credentialsPath:
    process.env.FREEPI_CREDENTIALS ||
    path.join(os.homedir(), ".free-pi", "agent", "credentials.json"),
  clientVersion: detectClientVersion("0.6.19"),

  stateDir: process.env.GATEWAY_STATE_DIR || path.join(root, "data"),
  defaultModel: process.env.GATEWAY_DEFAULT_MODEL || "deepseek-v4-flash",

  // Optional. When set, clients must send it as Bearer token or x-api-key.
  apiKey: process.env.GATEWAY_API_KEY || "",

  // free-pi allows one completion at a time per account. Requests are queued.
  maxQueue: int("GATEWAY_MAX_QUEUE", 64),
  queueWaitMs: int("GATEWAY_QUEUE_WAIT_MS", 300_000),

  modelsTtlMs: int("GATEWAY_MODELS_TTL_MS", 60_000),
  requestTimeoutMs: int("GATEWAY_REQUEST_TIMEOUT_MS", 600_000),

  // A slot held longer than this is force-released so one stuck request cannot
  // wedge the queue forever. Keep above requestTimeoutMs.
  slotHardLimitMs: int("GATEWAY_SLOT_HARD_LIMIT_MS", 720_000),

  // If another free-pi CLI session holds the account lease, POST /session/reset
  // and retry once. Keep off while a terminal free-pi session is in use.
  autoResetSession: bool("FREEPI_AUTO_RESET", false),

  logRequests: bool("GATEWAY_LOG_REQUESTS", true),
};

export const paths = { root, stateDir: config.stateDir };
