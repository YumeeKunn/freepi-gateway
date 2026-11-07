import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";

export class GatewayError extends Error {
  constructor(status, message, code = "gateway_error", extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Credentials (free-pi JWT)
// ---------------------------------------------------------------------------

let jwtCache = { token: null, mtimeMs: 0, at: 0 };

export async function getJwt() {
  const now = Date.now();
  if (jwtCache.token && now - jwtCache.at < 10_000) return jwtCache.token;

  let raw;
  let stat;
  try {
    stat = await fs.stat(config.credentialsPath);
    raw = await fs.readFile(config.credentialsPath, "utf8");
  } catch {
    throw new GatewayError(
      503,
      `free-pi sign-in not found at ${config.credentialsPath}. Run "npx free-pi-cli@latest" once and sign in with GitHub.`,
      "freepi_not_signed_in",
    );
  }

  let token = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && parsed.token.length > 0) token = parsed.token;
  } catch {
    token = null;
  }
  if (!token) {
    throw new GatewayError(
      503,
      `free-pi credentials at ${config.credentialsPath} have no token. Sign in again with "npx free-pi-cli@latest".`,
      "freepi_not_signed_in",
    );
  }

  const exp = jwtExpiry(token);
  if (exp && exp * 1000 < now) {
    throw new GatewayError(
      401,
      "free-pi sign-in token expired. Run \"npx free-pi-cli@latest\" and sign in again.",
      "freepi_token_expired",
    );
  }

  jwtCache = { token, mtimeMs: stat.mtimeMs, at: now };
  return token;
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session id (free-pi ties server state to x-session-id)
// ---------------------------------------------------------------------------

let sessionPromise = null;

export function getSessionId() {
  sessionPromise ??= loadSessionId().catch(() => randomUUID());
  return sessionPromise;
}

async function loadSessionId() {
  await fs.mkdir(paths.stateDir, { recursive: true });
  const file = path.join(paths.stateDir, "session.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed?.sessionId === "string" && parsed.sessionId.length >= 8) {
      return parsed.sessionId;
    }
  } catch {
    // fall through and create
  }
  const sessionId = randomUUID();
  await fs.writeFile(file, JSON.stringify({ sessionId }, null, 2), { mode: 0o600 });
  return sessionId;
}

// ---------------------------------------------------------------------------
// Single-flight queue: free-pi free tier allows one completion at a time.
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }

  acquire(timeoutMs) {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }

    if (this.waiters.length >= config.maxQueue) {
      return Promise.reject(
        new GatewayError(503, "Gateway queue is full. Retry shortly.", "queue_full"),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(
          new GatewayError(
            429,
            `Queued too long: another free-pi request is still running.`,
            "queue_timeout",
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  #releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      this.#drain();
    };
  }

  #drain() {
    while (this.active < this.max && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      this.active += 1;
      waiter.resolve(this.#releaser());
    }
  }
}

const queue = new Semaphore(1);

export function acquireSlot() {
  return queue.acquire(config.queueWaitMs);
}

// ---------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------

function baseHeaders(jwt, sessionId) {
  return {
    authorization: `Bearer ${jwt}`,
    "x-session-id": sessionId,
    "x-client-version": config.clientVersion,
  };
}

async function rawFetch(pathname, { method = "GET", body, extraHeaders } = {}) {
  const jwt = await getJwt();
  const sessionId = await getSessionId();
  const headers = {
    ...baseHeaders(jwt, sessionId),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...extraHeaders,
  };
  return fetch(`${config.freepiBaseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
}

let lastResetAt = 0;

async function resetSession() {
  if (Date.now() - lastResetAt < 15_000) return;
  lastResetAt = Date.now();
  const jwt = await getJwt();
  await fetch(`${config.freepiBaseUrl}/session/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
}

function isConcurrentSession(data) {
  return data?.code === "concurrent_session" || data?.error?.code === "concurrent_session";
}

// Returns the upstream Response. For streaming callers the queue slot must be
// held until the body is finished; use acquireSlot() before calling this.
export async function upstreamChat(openaiBody) {
  let res = await rawFetch("/v1/chat/completions", {
    method: "POST",
    body: openaiBody,
  });

  if (res.status === 409) {
    const probe = await res.clone().json().catch(() => null);
    if (isConcurrentSession(probe) && config.autoResetSession) {
      await resetSession();
      res = await rawFetch("/v1/chat/completions", {
        method: "POST",
        body: openaiBody,
      });
    }
  }
  return res;
}

export async function fetchCatalog() {
  const res = await rawFetch("/client-version");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new GatewayError(
      res.status === 401 ? 401 : 502,
      data?.message || `free-pi catalog request failed (HTTP ${res.status})`,
      data?.code || "catalog_error",
    );
  }
  return res.json();
}

export async function fetchMe() {
  const res = await rawFetch("/me");
  const data = res.ok ? await res.json().catch(() => null) : await res.json().catch(() => null);
  if (!res.ok) {
    throw new GatewayError(
      res.status,
      data?.message || `free-pi /me failed (HTTP ${res.status})`,
      data?.code || "usage_error",
    );
  }
  return data;
}

export async function resetOtherSession() {
  lastResetAt = 0;
  await resetSession();
  return true;
}

// ---------------------------------------------------------------------------
// Model catalog cache
// ---------------------------------------------------------------------------

let catalogCache = { at: 0, models: [], raw: null };

export async function listModels(force = false) {
  const fresh = Date.now() - catalogCache.at < config.modelsTtlMs;
  if (!force && fresh && catalogCache.models.length > 0) return catalogCache;

  const data = await fetchCatalog();
  const models = Array.isArray(data?.models) ? data.models : [];
  catalogCache = { at: Date.now(), models, raw: data };
  return catalogCache;
}

export async function isKnownModel(id) {
  try {
    const { models } = await listModels();
    return models.some((m) => m.id === id);
  } catch {
    return false;
  }
}
