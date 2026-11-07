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

export const config = {
  host: process.env.GATEWAY_HOST || "127.0.0.1",
  port: int("GATEWAY_PORT", 8788),

  freepiBaseUrl: (process.env.FREEPI_BASE_URL || "https://api.freepi.ai").replace(/\/+$/, ""),
  credentialsPath:
    process.env.FREEPI_CREDENTIALS ||
    path.join(os.homedir(), ".free-pi", "agent", "credentials.json"),
  clientVersion: process.env.FREEPI_CLIENT_VERSION || "0.6.14",

  stateDir: process.env.GATEWAY_STATE_DIR || path.join(root, "data"),
  defaultModel: process.env.GATEWAY_DEFAULT_MODEL || "deepseek-v4-flash",

  // Optional. When set, clients must send it as Bearer token or x-api-key.
  apiKey: process.env.GATEWAY_API_KEY || "",

  // free-pi allows one completion at a time per account. Requests are queued.
  maxQueue: int("GATEWAY_MAX_QUEUE", 64),
  queueWaitMs: int("GATEWAY_QUEUE_WAIT_MS", 300_000),

  modelsTtlMs: int("GATEWAY_MODELS_TTL_MS", 60_000),
  requestTimeoutMs: int("GATEWAY_REQUEST_TIMEOUT_MS", 600_000),

  // If another free-pi CLI session holds the account lease, POST /session/reset
  // and retry once. Keep off while a terminal free-pi session is in use.
  autoResetSession: bool("FREEPI_AUTO_RESET", false),

  logRequests: bool("GATEWAY_LOG_REQUESTS", true),
};

export const paths = { root, stateDir: config.stateDir };
