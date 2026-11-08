import http from "node:http";
import { Readable } from "node:stream";
import { config } from "./config.js";
import {
  GatewayError,
  acquireSlot,
  fetchMe,
  getJwt,
  isKnownModel,
  listModels,
  queueStats,
  resetOtherSession,
  upstreamChat,
} from "./freepi.js";
import { anthropicToOpenAI, createAnthropicStreamWriter, openAIToAnthropic } from "./anthropic.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key, anthropic-version, x-session-id");
  res.setHeader("access-control-max-age", "86400");
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function openaiError(res, status, message, code = null) {
  sendJson(res, status, {
    error: {
      message,
      type: code || "upstream_error",
      code,
      param: null,
    },
  });
}

function anthropicError(res, status, message, type = "api_error") {
  sendJson(res, status, { type: "error", error: { type, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new GatewayError(413, "Request body too large", "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) throw new GatewayError(400, "Empty request body", "invalid_request");
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError(400, "Request body is not valid JSON", "invalid_json");
  }
}

function authorized(req) {
  if (!config.apiKey) return true;
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const apiKey = req.headers["x-api-key"];
  return bearer === config.apiKey || apiKey === config.apiKey;
}

function resolveModel(model) {
  if (typeof model !== "string" || model.length === 0) return config.defaultModel;
  return model.startsWith("freepi/") ? model.slice("freepi/".length) : model;
}

// Agents often hardcode vendor model names (claude-*, gpt-*). If the name is
// not in the free-pi catalog, route it to the default model instead of 400ing.
async function resolveModelForRequest(model) {
  const resolved = resolveModel(model);
  if (resolved === config.defaultModel) return resolved;
  try {
    if (await isKnownModel(resolved)) return resolved;
    if (/^(claude|gpt|gemini|o[134])-/i.test(resolved)) {
      console.log(`[model-alias] "${resolved}" not in free-pi catalog -> ${config.defaultModel}`);
      return config.defaultModel;
    }
  } catch {
    // catalog unavailable; let upstream decide
  }
  return resolved;
}

async function* readSSE(webBody) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Readable.fromWeb(webBody)) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
  if (buffer.trim()) {
    const data = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) yield data;
  }
}

async function upstreamErrorData(res) {
  const text = await res.text().catch(() => "");
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

function errorMessage(data, text, status) {
  return (
    data?.error?.message ||
    data?.message ||
    (text && text.length < 500 ? text : "") ||
    `free-pi upstream returned HTTP ${status}`
  );
}

function errorCode(data) {
  return data?.error?.code || data?.code || null;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function handleModels(req, res) {
  const force = req.url.includes("refresh=1");
  const { models, raw } = await listModels(force);
  const data = models
    .filter((m) => !m.unavailable)
    .map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "free-pi",
      name: m.name || m.id,
      context_length: 200_000,
      max_output_tokens: 32_768,
    }));
  sendJson(res, 200, { object: "list", data, fusion: raw?.fusion ?? null });
}

async function handleOpenAIChat(req, res) {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(400, "messages[] is required", "invalid_request");
  }
  body.model = await resolveModelForRequest(body.model);
  const wantsStream = Boolean(body.stream);

  const release = await acquireSlot();
  let upstream;
  try {
    upstream = await upstreamChat(body);
  } catch (err) {
    release();
    throw err;
  }

  if (!upstream.ok) {
    const { data, text } = await upstreamErrorData(upstream);
    release();
    const message = errorMessage(data, text, upstream.status);
    openaiError(res, upstream.status, message, errorCode(data));
    return;
  }

  if (wantsStream && upstream.body) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const bodyStream = Readable.fromWeb(upstream.body);
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      release();
    };
    bodyStream.on("end", done);
    bodyStream.on("error", done);
    res.on("close", () => {
      done();
      bodyStream.destroy();
    });
    bodyStream.pipe(res);
    return;
  }

  let text;
  try {
    text = await upstream.text();
  } finally {
    release();
  }
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
  });
  res.end(text);
}

async function handleAnthropicMessages(req, res) {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(400, "messages[] is required", "invalid_request");
  }
  const requestedModel = await resolveModelForRequest(body.model);
  const wantsStream = Boolean(body.stream);
  const openaiBody = anthropicToOpenAI({ ...body, model: requestedModel });

  const release = await acquireSlot();
  let upstream;
  try {
    upstream = await upstreamChat(openaiBody);
  } catch (err) {
    release();
    throw err;
  }

  if (!upstream.ok) {
    const { data, text } = await upstreamErrorData(upstream);
    release();
    const message = errorMessage(data, text, upstream.status);
    const type =
      upstream.status === 401
        ? "authentication_error"
        : upstream.status === 429
          ? "rate_limit_error"
          : upstream.status === 400
            ? "invalid_request_error"
            : "api_error";
    anthropicError(res, upstream.status, message, type);
    return;
  }

  if (wantsStream && upstream.body) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const writer = createAnthropicStreamWriter(res, requestedModel);
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      release();
    };
    try {
      for await (const data of readSSE(upstream.body)) {
        if (data === "[DONE]") break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        writer.onChunk(chunk);
      }
      writer.finish();
    } catch (err) {
      if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "api_error", message: err?.message || "stream failed" },
          })}\n\n`,
        );
      }
    } finally {
      done();
      if (!res.writableEnded) res.end();
    }
    return;
  }

  let text;
  try {
    text = await upstream.text();
  } finally {
    release();
  }
  let completion;
  try {
    completion = JSON.parse(text);
  } catch {
    anthropicError(res, 502, "free-pi returned a non-JSON response", "api_error");
    return;
  }
  sendJson(res, 200, openAIToAnthropic(completion, requestedModel));
}

// Claude Code and some Anthropic clients call this before a turn.
// The number is an estimate; free-pi does not expose a counting endpoint.
function estimateTokens(body) {
  const text = JSON.stringify(body ?? {});
  return Math.max(1, Math.ceil(text.length / 4));
}

function handleCountTokens(body, res) {
  sendJson(res, 200, { input_tokens: estimateTokens(body) });
}

async function handleUsage(res) {
  const me = await fetchMe();
  sendJson(res, 200, {
    remaining_credits_today: me?.remaining_credits_today ?? null,
    allowance_credits: me?.allowance_credits ?? null,
    refill_at: me?.refill_at ?? me?.credits_refill_at ?? null,
    tier: me?.tier ?? null,
    guest: Boolean(me?.guest),
    raw: me,
  });
}

async function handleHealth(res) {
  let jwt = false;
  let authError = null;
  try {
    await getJwt();
    jwt = true;
  } catch (err) {
    authError = err.message;
  }
  let models = 0;
  let modelsError = null;
  try {
    const catalog = await listModels();
    models = catalog.models.filter((m) => !m.unavailable).length;
  } catch (err) {
    modelsError = err.message;
  }
  sendJson(res, 200, {
    ok: jwt,
    freepiBaseUrl: config.freepiBaseUrl,
    autoResetSession: config.autoResetSession,
    signedIn: jwt,
    authError,
    models,
    modelsError,
    queue: queueStats(),
  });
}

function handleRoot(res) {
  sendJson(res, 200, {
    name: "freepi-gateway",
    endpoints: {
      openai: {
        models: "/v1/models",
        chat: "/v1/chat/completions",
        usage: "/v1/usage",
      },
      anthropic: {
        messages: "/v1/messages",
      },
      admin: {
        resetSession: "POST /admin/reset-session",
      },
      health: "/health",
    },
  });
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathName = url.pathname.replace(/\/+$/, "") || "/";
  // tolerate a base URL that already ends in /v1 when the client appends /v1 again
  pathName = pathName.replace(/^\/v1\/v1(?=\/)/, "/v1");
  const isAnthropicRoute = pathName === "/v1/messages" || pathName === "/messages";

  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (config.logRequests) {
    const label = req.method === "POST" ? `${req.method} ${pathName}` : `${req.method} ${pathName}`;
    res.on("finish", () => {
      console.log(`[${new Date().toISOString()}] ${label} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
  }

  try {
    if (!authorized(req)) {
      throw new GatewayError(401, "Invalid gateway API key", "invalid_api_key");
    }

    if (req.method === "GET" && (pathName === "/health" || pathName === "/healthz")) {
      await handleHealth(res);
      return;
    }

    if (req.method === "GET" && (pathName === "/" || pathName === "/v1")) {
      handleRoot(res);
      return;
    }

    if (req.method === "GET" && (pathName === "/v1/models" || pathName === "/models")) {
      await handleModels(req, res);
      return;
    }

    if (req.method === "GET" && (pathName === "/v1/usage" || pathName === "/usage")) {
      await handleUsage(res);
      return;
    }

    if (req.method === "POST" && (pathName === "/admin/reset-session" || pathName === "/v1/admin/reset-session")) {
      await resetOtherSession();
      sendJson(res, 200, { released: true });
      return;
    }

    if (req.method === "POST" && (pathName === "/v1/chat/completions" || pathName === "/chat/completions")) {
      await handleOpenAIChat(req, res);
      return;
    }

    if (
      req.method === "POST" &&
      (pathName === "/v1/messages/count_tokens" || pathName === "/messages/count_tokens")
    ) {
      const body = await readJsonBody(req);
      handleCountTokens(body, res);
      return;
    }

    if (req.method === "POST" && isAnthropicRoute) {
      await handleAnthropicMessages(req, res);
      return;
    }

    throw new GatewayError(404, `No route for ${req.method} ${pathName}`, "not_found");
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 500;
    const code = err instanceof GatewayError ? err.code : "internal_error";
    const message = err?.message || "Internal error";
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (isAnthropicRoute) {
      anthropicError(res, status, message, status === 429 ? "rate_limit_error" : "api_error");
    } else {
      openaiError(res, status, message, code);
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 120_000;

server.listen(config.port, config.host, () => {
  console.log(`freepi-gateway listening on http://${config.host}:${config.port}`);
  console.log(`  free-pi upstream : ${config.freepiBaseUrl}`);
  console.log(`  credentials      : ${config.credentialsPath}`);
  console.log(`  auto reset lease : ${config.autoResetSession ? "on" : "off"}`);
  console.log(`  gateway api key  : ${config.apiKey ? "required" : "none"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
