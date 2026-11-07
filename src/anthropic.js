import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Anthropic Messages  ->  OpenAI Chat Completions
// ---------------------------------------------------------------------------

function textOfBlocks(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function imagePart(source) {
  if (!source) return null;
  if (source.type === "base64") {
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type || "image/png"};base64,${source.data}` },
    };
  }
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

function mapToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

export function anthropicToOpenAI(body) {
  const messages = [];

  const system = textOfBlocks(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages ?? []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = message?.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const texts = [];
      const toolCalls = [];
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const msg = { role: "assistant", content: texts.length > 0 ? texts.join("\n") : null };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (msg.content === null && toolCalls.length === 0) msg.content = "";
      messages.push(msg);
      continue;
    }

    // user turn: text, images and tool results
    const parts = [];
    const toolMessages = [];
    for (const block of content) {
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const part = imagePart(block.source);
        if (part) parts.push(part);
      } else if (block.type === "tool_result") {
        const resultText = textOfBlocks(block.content);
        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: resultText.length > 0 ? resultText : block.is_error ? "error" : "",
        });
      }
    }

    if (parts.length > 0) {
      const hasImage = parts.some((p) => p.type === "image_url");
      messages.push({
        role: "user",
        content: hasImage ? parts : parts.map((p) => p.text).join("\n"),
      });
    }
    for (const tm of toolMessages) messages.push(tm);
  }

  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: Boolean(body.stream),
  };

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
    const toolChoice = mapToolChoice(body.tool_choice);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (body.tool_choice?.type === "any" && body.tool_choice.disable_parallel_tool_use) {
      out.parallel_tool_calls = false;
    }
  }

  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions  ->  Anthropic Messages
// ---------------------------------------------------------------------------

function parseArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mapStopReason(finish) {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function openAIToAnthropic(completion, requestedModel) {
  const choice = completion?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name: call.function?.name || "tool",
      input: parseArguments(call.function?.arguments),
    });
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: completion?.id || `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: completion?.model || requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion?.usage?.prompt_tokens ?? 0,
      output_tokens: completion?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming translation
// ---------------------------------------------------------------------------

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createAnthropicStreamWriter(res, requestedModel) {
  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  let textBlockOpen = false;
  let textIndex = -1;
  let nextBlockIndex = 0;
  const toolBlocks = new Map(); // openai tool index -> { blockIndex, id, name, started }
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "end_turn";

  function ensureStart() {
    if (started) return;
    started = true;
    writeEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function openTextBlock() {
    ensureStart();
    if (textBlockOpen) return;
    textIndex = nextBlockIndex++;
    textBlockOpen = true;
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: textIndex,
      content_block: { type: "text", text: "" },
    });
  }

  function closeTextBlock() {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    writeEvent(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
  }

  function openToolBlock(delta) {
    ensureStart();
    const key = delta.index ?? 0;
    let block = toolBlocks.get(key);
    if (!block) {
      closeTextBlock();
      block = {
        blockIndex: nextBlockIndex++,
        id: delta.id || `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        name: delta.function?.name || "tool",
        started: false,
      };
      toolBlocks.set(key, block);
    }
    if (delta.id) block.id = delta.id;
    if (delta.function?.name) block.name = delta.function.name;
    if (!block.started) {
      block.started = true;
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index: block.blockIndex,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
    }
    return block;
  }

  return {
    onChunk(chunk) {
      if (!chunk) return;
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
          output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        openTextBlock();
        writeEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const call of delta.tool_calls ?? []) {
        const block = openToolBlock(call);
        const fragment = call.function?.arguments;
        if (typeof fragment === "string" && fragment.length > 0) {
          writeEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: block.blockIndex,
            delta: { type: "input_json_delta", partial_json: fragment },
          });
        }
      }

      if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);
    },

    finish() {
      ensureStart();
      if (!textBlockOpen && toolBlocks.size === 0) openTextBlock();
      closeTextBlock();
      for (const block of toolBlocks.values()) {
        if (block.started) {
          writeEvent(res, "content_block_stop", { type: "content_block_stop", index: block.blockIndex });
        }
      }
      writeEvent(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      });
      writeEvent(res, "message_stop", { type: "message_stop" });
    },
  };
}
