// Silt — local recorder for AI-agent calls on this machine.
// Binds to loopback only. Writes captures next to the user profile.
// Never stores Authorization, cookies, or API keys. Non-agent sites are
// tunneled without being opened, and only a byte count is kept.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import forge from "node-forge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILTIN_HOSTS = [
  "api.openai.com",
  "chatgpt.com",
  "ws.chatgpt.com",
  "chat.openai.com",
  "api.anthropic.com",
  "claude.ai",
  "api.x.ai",
  "api.groq.com",
  "api.together.xyz",
  "api.together.ai",
  "openrouter.ai",
  "api.mistral.ai",
  "api.cohere.ai",
  "api.cohere.com",
  "api.perplexity.ai",
  "api.deepseek.com",
  "api.fireworks.ai",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "inference.huggingface.co",
  "router.huggingface.co",
  "api-inference.huggingface.co",
  "api.replicate.com",
  "api.githubcopilot.com",
  "copilot-proxy.githubusercontent.com",
  "api.individual.githubcopilot.com",
  "api2.cursor.sh",
  "api3.cursor.sh",
  "api.cursor.sh",
  "api.cursor.com",
  "gemini.google.com",
  "geminiweb-pa.clients6.google.com",
  "aistudio.google.com",
  "grok.com",
  "grok.x.ai",
  "copilot.microsoft.com",
  "www.perplexity.ai",
  "perplexity.ai",
  // Gemini CLI, Gemini Code Assist and Antigravity
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "aicode.googleapis.com",
  "jetski-webchannel.googleapis.com",
  // Qwen Code, Kimi, opencode, Cline, Lovable, Ollama cloud models
  "portal.qwen.ai",
  "chat.qwen.ai",
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "api.moonshot.ai",
  "api.moonshot.cn",
  "kimi.com",
  "www.kimi.com",
  "opencode.ai",
  "api.cline.bot",
  "api.lovable.dev",
  "ollama.com",
];

// Node defaults to 16 KB; Google replies and ChatGPT sends (cookies + sentinel tokens) exceed it.
const MAX_HEADER = 256 * 1024;

const BUILTIN_SUFFIXES = [".openai.azure.com", ".githubcopilot.com", "-aiplatform.googleapis.com"];

const AI_PATH =
  /\/(?:v1\/chat\/completions|v1\/completions|v1\/responses|v1\/messages|v1\/embeddings|chat\/completions|responses|messages|api\/chat|api\/generate|v1beta\/models\/[^?\s]+:(?:stream)?generateContent|openai\/deployments\/[^/\s]+\/(?:chat\/completions|completions)|v1\/engines\/[^/\s]+\/completions)|:(?:stream)?generateContent\b|ChatService\//i;

const SECRET_KEY =
  /api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret|cookie|credential|session/i;

const HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
]);

export function hostIsAgent(host, extraRules = []) {
  const h = String(host || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (BUILTIN_HOSTS.includes(h)) return true;
  if (BUILTIN_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return true;
  if (/(^|\.)cursor\.sh$/.test(h) && h !== "cursor.sh") return true;
  for (const rule of extraRules) {
    const r = String(rule).trim().toLowerCase();
    if (!r || r.startsWith("#")) continue;
    if (r.startsWith(".")) {
      if (h.endsWith(r) || h === r.slice(1)) return true;
    } else if (h === r) return true;
  }
  return false;
}

export function isAiPath(pathname) {
  return AI_PATH.test(pathname || "");
}

export function scrubText(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_\-]{10,}\b/g, "«redacted»")
    .replace(/\bsk-ant-[A-Za-z0-9_\-]{10,}\b/g, "«redacted»")
    .replace(/\bBearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi, "Bearer «redacted»")
    .replace(
      /(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1«redacted»",
    );
}

export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "«redacted»" : redactValue(v);
    }
    return out;
  }
  if (typeof value === "string") return scrubText(value);
  return value;
}

function inflateNamed(buf, enc) {
  const name = enc.trim().toLowerCase();
  try {
    if (name === "zstd" || name === "zstandard") return zlib.zstdDecompressSync(buf);
    if (name === "br" || name === "brotli") return zlib.brotliDecompressSync(buf);
    if (name === "gzip" || name === "x-gzip") return zlib.gunzipSync(buf);
    if (name === "deflate") {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
  } catch {
    return buf;
  }
  return buf;
}

function looksLikeTextBuf(buf) {
  if (!buf || buf.length === 0) return true;
  const n = Math.min(buf.length, 512);
  let readable = 0;
  let controls = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) readable += 1;
    if (c < 9 || (c > 13 && c < 32)) controls += 1;
  }
  return controls / n < 0.02 && readable / n > 0.9;
}

function looksBinaryString(text) {
  if (!text) return false;
  const n = Math.min(text.length, 400);
  let controls = 0;
  let replacement = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd) replacement += 1;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) controls += 1;
  }
  return controls / n > 0.03 || replacement / n > 0.02;
}

function tryInflate(buf) {
  if (!buf || buf.length < 2) return null;
  const attempts = [
    () => zlib.gunzipSync(buf),
    () => zlib.brotliDecompressSync(buf),
    () => zlib.zstdDecompressSync(buf),
    () => zlib.inflateSync(buf),
    () => zlib.inflateRawSync(buf),
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out && out.length && looksLikeTextBuf(out)) return out;
    } catch {
      /* not this encoding */
    }
  }
  return null;
}

function unwrapConnect(buf) {
  if (!buf || buf.length < 5) return null;
  if (buf[0] === 0x7b || buf[0] === 0x5b || buf[0] === 0x64 || buf[0] === 0x65 || buf[0] === 0x3c) return null;
  let offset = 0;
  const parts = [];
  let frames = 0;
  while (offset + 5 <= buf.length && frames < 500) {
    const flags = buf[offset];
    if (flags > 3) return null;
    const len = buf.readUInt32BE(offset + 1);
    if (len < 1 || offset + 5 + len > buf.length) return null;
    let payload = buf.subarray(offset + 5, offset + 5 + len);
    if (flags & 1) {
      try {
        payload = zlib.gunzipSync(payload);
      } catch {
        const other = tryInflate(payload);
        if (!other) return null;
        payload = other;
      }
    }
    parts.push(payload);
    offset += 5 + len;
    frames += 1;
  }
  if (!frames || offset !== buf.length) return null;
  return Buffer.concat(parts);
}

function decompressBytes(buf) {
  let out = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  for (let pass = 0; pass < 3; pass++) {
    if (looksLikeTextBuf(out)) {
      const text = out.toString("utf8").trim();
      if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length >= 16 && text.replace(/\s/g, "").length % 4 === 0) {
        const raw = Buffer.from(text, "base64");
        const inflated = tryInflate(raw) || unwrapConnect(raw);
        if (inflated && looksLikeTextBuf(inflated)) {
          out = inflated;
          continue;
        }
      }
      const framed = unwrapConnect(out);
      if (framed && framed.length && !framed.equals(out)) {
        out = framed;
        continue;
      }
      return out;
    }
    const inflated = tryInflate(out);
    if (inflated) {
      out = inflated;
      continue;
    }
    const framed = unwrapConnect(out);
    if (framed && looksLikeTextBuf(framed)) {
      out = framed;
      continue;
    }
    return out;
  }
  return out;
}

export function inflateText(text, depth = 0) {
  if (typeof text !== "string") return "";
  if (depth > 2) return looksBinaryString(text) ? "" : text;
  if (!looksBinaryString(text)) {
    const packed = text.trim();
    if (packed.length >= 16 && /^[A-Za-z0-9+/=\r\n]+$/.test(packed) && packed.replace(/\s/g, "").length % 4 === 0) {
      const raw = Buffer.from(packed, "base64");
      const inflated = tryInflate(raw);
      if (inflated) return inflateText(inflated.toString("utf8"), depth + 1);
    }
    return text;
  }
  const inflated = tryInflate(Buffer.from(text, "latin1")) || tryInflate(Buffer.from(text, "utf8"));
  if (!inflated) return "";
  return inflateText(inflated.toString("utf8"), depth + 1);
}

export function encodingHeader(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value == null) return "";
  return String(value);
}

// Content-Encoding is applied left to right, so undo it from the right.
// Bytes stay bytes until this returns; callers convert to text only after.
export function decodeBody(buf, encoding) {
  let out = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (out.length === 0) return out;
  const parts = encodingHeader(encoding)
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== "identity");
  for (let i = parts.length - 1; i >= 0; i--) out = inflateNamed(out, parts[i]);
  return decompressBytes(out);
}

function textFromContent(content) {
  if (typeof content === "string") return inflateText(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        // Tool output fed back to the model is not something the person typed.
        if (/^(tool_result|function_call_output|functionResponse)$/.test(part.type || "") || part.functionResponse) return "";
        if (typeof part.text === "string") return inflateText(part.text);
        if (typeof part.content === "string") return inflateText(part.content);
        if (Array.isArray(part.parts)) return textFromContent({ parts: part.parts });
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return inflateText(content.text);
    if (Array.isArray(content.parts)) {
      return content.parts
        .map((part) => (typeof part === "string" ? inflateText(part) : inflateText(part?.text || "")))
        .filter(Boolean)
        .join("");
    }
    if (typeof content.content === "string") return inflateText(content.content);
  }
  return "";
}

function roleOf(message) {
  if (!message || typeof message !== "object") return "user";
  if (typeof message.role === "string") return message.role;
  if (typeof message.author === "string") return message.author;
  if (typeof message.author?.role === "string") return message.author.role;
  if (typeof message.sender === "string") return message.sender;
  return "user";
}

// Calls tools make on their own: naming the chat, tidying memory. Not something the person asked.
const HELPER_SYSTEM = /\btitle generator\b|\b(generate|create|write) (a |the )?(\w+ ){0,3}title\b/i;
const HELPER_USER = /^Managed memory has TWO directories\b/;

// Context agents inject around what the person typed (Claude Code reminders, Codex environment blocks).
const INJECTED = /<(system-reminder|environment_context|user_instructions|permissions instructions|INSTRUCTIONS|current_datetime)>[\s\S]*?<\/\1>/g;

function pushMsg(out, role, text) {
  let clean = scrubText(text || "").replace(/[ \t]+\n/g, "\n").trim();
  if ((role || "user") === "user") clean = clean.replace(INJECTED, "").replace(/^# AGENTS\.md instructions for [\s\S]*$|^Current runtime context\. This snapshot supersedes [\s\S]*$/, "").trim();
  if (!clean) return;
  const last = out[out.length - 1];
  if (last && last.role === (role || "user") && last.text === clean) return;
  out.push({ role: role || "user", text: clean.slice(0, 100_000) });
}

// A model's own earlier output in a resent history (Anthropic/OpenAI/Gemini/Responses API shapes).
function isReply(message) {
  return /^(assistant|model)$/.test(message?.role || "") || /^(function_call|reasoning|custom_tool_call|local_shell_call|web_search_call)$/.test(message?.type || "");
}

// sinceReply: agents resend the whole thread every call; keep only what came after the model last spoke.
export function messagesFromJson(json, sinceReply = false) {
  const out = [];
  if (!json || typeof json !== "object") return out;
  // Gemini CLI / Code Assist wrap the generateContent body in { request: ... }.
  if (json.request && typeof json.request === "object" && !json.messages && !json.contents) return messagesFromJson(json.request, sinceReply);
  const lists = [json.messages, json.input, json.chat_history, json.contents].filter(Array.isArray);
  const resumed = sinceReply && lists.some((list) => list.some(isReply));
  if (!resumed) {
    if (typeof json.system === "string") pushMsg(out, "system", json.system);
    if (Array.isArray(json.system)) {
      for (const part of json.system) pushMsg(out, "system", textFromContent(part));
    }
    const si = json.systemInstruction;
    if (si && typeof si === "object") pushMsg(out, "system", textFromContent(si.parts ? { parts: si.parts } : si));
  }
  for (const list of lists) {
    if (list === json.contents) continue;
    for (const message of sinceReply ? list.slice(list.findLastIndex(isReply) + 1) : list) {
      if (typeof message === "string") {
        pushMsg(out, "user", message);
        continue;
      }
      if (!message || typeof message !== "object") continue;
      pushMsg(out, roleOf(message), textFromContent(message.content ?? message.text ?? message.parts));
    }
  }
  if (typeof json.prompt === "string") pushMsg(out, "user", json.prompt);
  if (typeof json.input === "string") pushMsg(out, "user", json.input);
  if (typeof json.query === "string") pushMsg(out, "user", json.query);
  if (typeof json.message === "string") pushMsg(out, "user", json.message);
  if (json.message && typeof json.message === "object") {
    pushMsg(out, roleOf(json.message), textFromContent(json.message.content ?? json.message.text));
  }
  if (Array.isArray(json.contents)) {
    for (const entry of sinceReply ? json.contents.slice(json.contents.findLastIndex(isReply) + 1) : json.contents) {
      const text = textFromContent(entry?.parts ? { parts: entry.parts } : entry?.content);
      const role = entry?.role === "model" ? "assistant" : entry?.role || "user";
      pushMsg(out, role, text);
    }
  }
  if (json.mapping && typeof json.mapping === "object" && !out.length) {
    const nodes = Object.values(json.mapping)
      .map((node) => node?.message)
      .filter(Boolean)
      .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    for (const message of nodes) {
      pushMsg(out, roleOf(message), textFromContent(message.content));
    }
  }
  return out;
}

function responseFromJson(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "";
  const choice = json.choices?.[0];
  if (choice?.message) {
    const text = textFromContent(choice.message.content);
    if (text) return text;
  }
  if (typeof choice?.text === "string" && choice.text) return choice.text;
  if (Array.isArray(json.content)) {
    const text = textFromContent(json.content);
    if (text.trim()) return text;
  }
  if (typeof json.output_text === "string" && json.output_text) return json.output_text;
  if (Array.isArray(json.output)) {
    const text = json.output.map((item) => textFromContent(item?.content) || item?.text || "").join("");
    if (text.trim()) return text;
  }
  const gemini = json.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("");
  if (gemini && gemini.trim()) return gemini;
  if (typeof json.completion === "string" && json.completion) return json.completion;
  const grok = json.result?.modelResponse?.message || json.modelResponse?.message;
  if (typeof grok === "string" && grok) return grok;
  if (json.message && typeof json.message === "object") {
    const text = textFromContent(json.message.content ?? json.message.text);
    if (text) return text;
  }
  if (typeof json.message === "string" && json.choices) return json.message;
  return "";
}

function usageFrom(json) {
  const usage = json?.usage || json?.usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? null;
  const output = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? null;
  if (input == null && output == null) return null;
  return { input, output };
}

function applySnapshot(state, next) {
  if (typeof next !== "string" || next.length < state.text.length) return;
  state.text = next;
}

function applyDelta(state, next) {
  if (typeof next !== "string" || !next) return;
  state.text += next;
}

function absorbEvent(state, json, depth) {
  if (!json || typeof json !== "object" || depth > 8) return;
  if (typeof json.model === "string") state.model = json.model;
  if (typeof json.metadata?.model_slug === "string") state.model = json.metadata.model_slug;
  const usage = usageFrom(json);
  if (usage) state.usage = usage;

  const delta = json.choices?.[0]?.delta;
  if (typeof delta?.content === "string") applyDelta(state, delta.content);
  else if (delta?.content) applyDelta(state, textFromContent(delta.content));
  if (json.choices?.[0]?.message) applySnapshot(state, textFromContent(json.choices[0].message.content));
  if (typeof json.choices?.[0]?.text === "string") applyDelta(state, json.choices[0].text);
  if (typeof json.delta?.text === "string") applyDelta(state, json.delta.text);
  // OpenAI Responses API (Codex): text deltas, then the full response on response.completed.
  if (/output_text\.delta$/.test(json.type || "") && typeof json.delta === "string") applyDelta(state, json.delta);
  if (/^response\./.test(json.type || "") && json.response && typeof json.response === "object") {
    if (typeof json.response.id === "string") state.id = json.response.id;
    const text = responseFromJson(json.response);
    if (text) applySnapshot(state, text);
    if (typeof json.response.model === "string") state.model = json.response.model;
    state.usage = usageFrom(json.response) || state.usage;
  }
  if (typeof json.completion === "string") applySnapshot(state, json.completion);

  if (json.message && typeof json.message === "object") {
    const text = textFromContent(json.message.content);
    if (text) applySnapshot(state, text);
    if (typeof json.message.metadata?.model_slug === "string") state.model = json.message.metadata.model_slug;
  }

  // ChatGPT delta encoding v1: a bare {"v":"..."} repeats the previous op and path.
  let op = json.o;
  let pathHint = json.p;
  if (op === undefined && pathHint === undefined && typeof json.v === "string") {
    op = state.op;
    pathHint = state.p;
  } else if (op !== undefined || pathHint !== undefined) {
    state.op = op;
    state.p = pathHint;
  }
  pathHint = String(pathHint || "");
  const textOp = !pathHint || /parts|content|text|completion/.test(pathHint);
  if (textOp && (op === "append" || op === "add") && typeof json.v === "string") applyDelta(state, json.v);
  if (textOp && op === "replace" && typeof json.v === "string") applySnapshot(state, json.v);
  // A bare string token is a text piece, unless it is a credential (ChatGPT hands off a JWT).
  if (typeof json.token === "string" && !/^eyJ[\w-]*\./.test(json.token)) applyDelta(state, json.token);
  if (typeof json.result?.token === "string") applyDelta(state, json.result.token);
  const grokRes = json.result?.response;
  if (typeof grokRes?.token === "string" && !grokRes.isThinking) applyDelta(state, grokRes.token);
  const grok = json.result?.modelResponse?.message || grokRes?.modelResponse?.message || grokRes?.message;
  if (typeof grok === "string") applySnapshot(state, grok);

  const gemini = json.candidates?.[0]?.content?.parts?.filter((part) => !part?.thought).map((part) => part?.text || "").join("");
  if (gemini) applyDelta(state, gemini);
  // Gemini CLI / Code Assist stream { response: { candidates } }.
  if (json.response?.candidates) absorbEvent(state, json.response, depth + 1);
  if (typeof json.output_text === "string") applyDelta(state, json.output_text);

  if (json.v && typeof json.v === "object") absorbEvent(state, json.v, depth + 1);
  if (Array.isArray(json.v)) {
    for (const item of json.v) {
      if (item && typeof item === "object") absorbEvent(state, item, depth + 1);
    }
  }
}

export function parseSse(text) {
  const state = { text: "", model: null, usage: null, id: null };
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("event:") || trimmed.startsWith("id:") || trimmed.startsWith(":")) continue;
    let data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!data || data === "[DONE]") continue;
    if (!(data.startsWith("{") || data.startsWith("["))) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (Array.isArray(json)) {
      for (const item of json) absorbEvent(state, item, 0);
    } else {
      absorbEvent(state, json, 0);
    }
  }
  return { text: inflateText(scrubText(state.text).trim()), model: state.model, usage: state.usage, id: state.id };
}

function tryJson(buf) {
  const text = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAccountPayload(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  if (json.messages || json.contents || typeof json.prompt === "string" || json.mapping) return false;
  return Object.keys(json).some((key) =>
    /^(email|phone(_number)?|e164|session(_token)?|access_token|refresh_token|cookie|password|billing|address)$/i.test(key),
  );
}

function asJsonTree(buf) {
  const json = tryJson(buf);
  if (json) return json;
  if (!looksLikeTextBuf(buf)) return null;
  const text = buf.toString("utf8").trim();
  if (!text || looksBinaryString(text) || text.startsWith("{") || text.startsWith("[") || text.startsWith("<") || !text.includes("=")) return null;
  try {
    const params = new URLSearchParams(text);
    const bag = {};
    for (const [key, value] of params) {
      const inner = tryJson(Buffer.from(value));
      bag[key] = inner || value;
    }
    return bag;
  } catch {
    return null;
  }
}

function harvestProse(node, out, depth) {
  if (depth > 8 || node == null || out.length > 40) return;
  if (typeof node === "string") {
    const inner = node.trim();
    if (inner.length > 2 && (inner.startsWith("{") || inner.startsWith("["))) {
      const parsed = tryJson(Buffer.from(inner));
      if (parsed) harvestProse(parsed, out, depth + 1);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) harvestProse(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (/email|phone|token|password|secret|cookie|authorization|session|api[-_]?key|url|uri|avatar|hash|uuid|^id$|model/i.test(key)) {
      continue;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length > 20000 || !/[A-Za-z]/.test(text)) continue;
      if (/^https?:\/\//.test(text)) continue;
      if (!/\s/.test(text) && text.length < 12) continue;
      if (/\s/.test(text) && text.length < 2) continue;
      out.push(text);
    } else {
      harvestProse(value, out, depth + 1);
    }
  }
}

function uniqueTexts(list) {
  const out = [];
  for (const text of list) {
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

export function makeWsTap(onText) {
  let buf = Buffer.alloc(0);
  let frags = [];
  let fragOp = 1;
  return function push(chunk) {
    if (!chunk || !chunk.length) return;
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) {
          buf = Buffer.alloc(0);
          return;
        }
        len = buf.readUInt32BE(6);
        offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      if (buf.length < offset + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      const start = offset + (masked ? 4 : 0);
      const payload = Buffer.from(buf.subarray(start, start + len));
      buf = Buffer.from(buf.subarray(start + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      if (opcode === 0x8 || opcode === 0x9 || opcode === 0xa) continue;
      if (opcode === 1 || opcode === 2) {
        frags = [payload];
        fragOp = opcode;
      } else if (opcode === 0) {
        frags.push(payload);
      } else {
        continue;
      }
      if (!fin) continue;
      const full = Buffer.concat(frags);
      frags = [];
      const textual = fragOp === 1 || mostlyText(full);
      if (!textual) continue;
      const text = full.toString("utf8").replace(/\0/g, "").trim();
      if (text) onText(text);
    }
  };
}

function mostlyText(buf) {
  if (!buf.length) return false;
  let ok = 0;
  const n = Math.min(buf.length, 180);
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) ok += 1;
  }
  return ok / n > 0.8;
}

function providerFor(host) {
  const h = host.toLowerCase();
  if (h.includes("openai") || h.includes("chatgpt")) return "OpenAI";
  if (h.includes("anthropic") || h.includes("claude")) return "Anthropic";
  if (h.endsWith(".x.ai") || h === "x.ai" || h.includes("api.x.ai") || h.includes("grok")) return "xAI";
  if (h.includes("googleapis") || h.includes("gemini") || h.includes("aistudio")) return "Google";
  if (h.includes("groq")) return "Groq";
  if (h.includes("mistral")) return "Mistral";
  if (h.includes("cohere")) return "Cohere";
  if (h.includes("perplexity")) return "Perplexity";
  if (h.includes("deepseek")) return "DeepSeek";
  if (h.includes("openrouter")) return "OpenRouter";
  if (h.includes("together")) return "Together";
  if (h.includes("fireworks")) return "Fireworks";
  if (h.includes("huggingface")) return "Hugging Face";
  if (h.includes("replicate")) return "Replicate";
  if (h.includes("copilot")) return "Copilot";
  if (h.includes("cursor")) return "Cursor";
  if (h.includes("bedrock") || h.includes("amazonaws")) return "Bedrock";
  if (h.includes("azure")) return "Azure OpenAI";
  if (h === "127.0.0.1" || h === "localhost") return "Local";
  return "Agent";
}

function safePath(p) {
  const s = String(p || "/");
  const q = s.indexOf("?");
  return q === -1 ? s : s.slice(0, q);
}

export function extractExchange({
  host,
  method,
  path: reqPath,
  status,
  reqBuf,
  resBuf,
  resType,
  latencyMs,
}) {
  const pathname = safePath(reqPath);
  if (/\/count_tokens$/.test(pathname)) return null;
  const type = String(resType || "").toLowerCase();
  const reqText = (reqBuf || Buffer.alloc(0)).toString("utf8");
  const resTextRaw = (resBuf || Buffer.alloc(0)).toString("utf8");
  if (type.includes("javascript") || type.includes("css") || type.includes("image/") || type.includes("font") || type.includes("video/") || type.includes("audio/")) {
    return null;
  }
  const chatty = /chat|message|completion|conversation|generate|prompt|response|infer|model|agent|grok/i.test(pathname);
  const textual =
    !type ||
    /json|text|event-stream|eventstream|ndjson|xml|grpc|proto|octet-stream|form|plain/.test(type);
  if (!textual && !chatty) return null;
  const resIsHtml = type.includes("text/html") || /^\s*</.test(resTextRaw.slice(0, 64));
  if (resIsHtml && !reqText.trim()) return null;

  const reqJson =
    asJsonTree(reqBuf || Buffer.alloc(0)) ||
    reqText.split("\n").map((line) => tryJson(Buffer.from(line))).filter(Boolean).at(-1) ||
    null;
  const streaming =
    type.includes("event-stream") ||
    type.includes("eventstream") ||
    type.includes("ndjson") ||
    /^\s*(?:event:|data:)/.test(resTextRaw);
  // A stream is read event by event below; parsed as a form it only yields tokens and ids.
  const resJson = resIsHtml || streaming ? null : asJsonTree(resBuf || Buffer.alloc(0));
  if ((isAccountPayload(reqJson) || isAccountPayload(resJson)) && !reqJson?.messages && !reqJson?.prompt && !reqJson?.contents) {
    const probe = [];
    harvestProse(reqJson, probe, 0);
    harvestProse(resJson, probe, 0);
    if (!probe.length) return null;
  }

  // Codex labels each call: thread_source "user" is a turn someone typed; titles, memory
  // consolidation and the command reviewer are its own background work.
  let codexTurn = {};
  try {
    codexTurn = JSON.parse(reqJson?.client_metadata?.["x-codex-turn-metadata"] || "{}") || {};
  } catch {
    /* not Codex */
  }
  if (reqJson?.client_metadata?.["x-openai-subagent"] || (codexTurn.thread_source && codexTurn.thread_source !== "user")) return null;

  const redactedReq = reqJson && typeof reqJson === "object" ? redactValue(reqJson) : null;
  let requestMessages = redactedReq ? messagesFromJson(redactedReq, true) : [];
  if (requestMessages.some((m) => (m.role === "system" || m.role === "developer" ? HELPER_SYSTEM : HELPER_USER).test(m.text.slice(0, 300)))) return null;
  // "developer" is harness instruction by definition. With tools attached the system prompt is too.
  const harness = (Array.isArray(redactedReq?.tools) && redactedReq.tools.length) || redactedReq?.tool_choice;
  requestMessages = requestMessages.filter((m) => m.role !== "developer" && !(harness && m.role === "system"));
  // The thread's first message names the conversation across calls that each resend it.
  const thread = redactedReq ? messagesFromJson(redactedReq).find((m) => m.role === "user")?.text || "" : "";
  let responseId = null;
  let responseText = "";
  let model = (redactedReq && (redactedReq.model || redactedReq.modelId || redactedReq.modelName)) || null;
  if (model && typeof model === "object") model = null;
  let usage = null;
  let guessed = false;

  if (!resIsHtml && (streaming || !resJson)) {
    const sse = parseSse(resTextRaw);
    responseText = sse.text;
    if (sse.model) model = sse.model;
    if (sse.usage) usage = sse.usage;
    responseId = sse.id;
  }
  if (!responseText && resJson) {
    const clean = redactValue(resJson);
    responseText = scrubText(responseFromJson(clean)).trim();
    const found = messagesFromJson(clean).filter((message) => message.role === "assistant" || message.role === "model");
    if (!responseText && found.length) responseText = found.map((message) => message.text).join("\n\n");
    if (clean.model && !model) model = clean.model;
    if (!usage) usage = usageFrom(clean);
  }

  // Last resort: any prose at all. Settings pages and telemetry read this way too, so such
  // rows are kept only on chat endpoints. Agent threads (anything resent with a reply) never guess.
  const known = requestMessages.length > 0 || Boolean(responseText) || Boolean(thread);
  if (!requestMessages.length && !thread && redactedReq?.type !== "response.create") {
    const prose = [];
    harvestProse(redactedReq, prose, 0);
    const texts = uniqueTexts(prose);
    if (texts.length) requestMessages = [{ role: "user", text: texts.join("\n\n").slice(0, 100_000) }];
  }
  if (!responseText && resJson) {
    const prose = [];
    harvestProse(redactValue(resJson), prose, 0);
    const texts = uniqueTexts(prose).filter((text) => !requestMessages.some((message) => message.text === text));
    if (texts.length) responseText = texts.join("\n\n");
  }
  guessed = !known;
  if (guessed && !isChat({ path: pathname })) return null;

  if (!requestMessages.length && !responseText && !thread) return null;
  responseText = inflateText(responseText).trim();
  if (looksBinaryString(responseText)) responseText = "";
  requestMessages = requestMessages
    .map((message) => ({ ...message, text: inflateText(message.text).trim() }))
    .filter((message) => message.text && !looksBinaryString(message.text));
  if (!requestMessages.length && !responseText) return null;
  if (!chatty && !requestMessages.some((message) => message.role !== "raw") && responseText.length < 12 && requestMessages.every((message) => message.text.length < 12)) {
    return null;
  }
  // Off the chat endpoints only a clean question-and-answer pair counts; settings, lists and telemetry read like prose too.
  if (!isChat({ path: pathname }) && !(requestMessages.some((m) => m.role === "user") && responseText)) return null;

  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    provider: providerFor(host),
    host,
    method: method || "POST",
    path: pathname,
    status: status || 0,
    model: model ? String(model) : null,
    latencyMs: latencyMs ?? 0,
    streaming,
    requestMessages,
    responseText: responseText.slice(0, 100_000),
    usage,
    bytesIn: reqBuf?.length || 0,
    bytesOut: resBuf?.length || 0,
    secretsStripped: true,
    thread: thread ? crypto.createHash("sha1").update(thread).digest("hex").slice(0, 16) : null,
    responseId,
    previousId: typeof redactedReq?.previous_response_id === "string" ? redactedReq.previous_response_id : null,
    turnKey: String(codexTurn.turn_id || reqJson?.client_metadata?.turn_id || "") || null,
  };
}

// Length-delimited fields of one protobuf message, as [fieldNumber, bytes]. [] if it doesn't parse.
function protoFields(buf) {
  const out = [];
  let o = 0;
  const varint = () => {
    let r = 0;
    let s = 0;
    let x;
    do {
      if (o >= buf.length) throw new Error("eof");
      x = buf[o++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r;
  };
  try {
    while (o < buf.length) {
      const tag = varint();
      const w = tag % 8;
      if (w === 0) varint();
      else if (w === 1) o += 8;
      else if (w === 5) o += 4;
      else if (w === 2) {
        const len = varint();
        if (o + len > buf.length) return [];
        out.push([Math.floor(tag / 8), buf.subarray(o, o + len)]);
        o += len;
      } else return [];
      if (o > buf.length) return [];
    }
  } catch {
    return [];
  }
  return out;
}

// Every value at a field-number path, e.g. [2, 3] = field 3 inside field 2.
export function protoAll(buf, fieldPath) {
  let nodes = [buf];
  for (const f of fieldPath) nodes = nodes.flatMap((n) => protoFields(n).filter(([k]) => k === f).map(([, v]) => v));
  return nodes;
}

// Connect/gRPC-web stream: 1 flag byte + 4-byte length per message. Null if not framed.
function connectFrames(buf) {
  const out = [];
  let o = 0;
  while (o + 5 <= buf.length) {
    const flags = buf[o];
    const len = buf.readUInt32BE(o + 1);
    if (flags > 3 || o + 5 + len > buf.length) return null;
    let payload = buf.subarray(o + 5, o + 5 + len);
    if (flags & 1) payload = tryInflate(payload) || payload;
    if (!(flags & 2)) out.push(payload);
    o += 5 + len;
  }
  return o === buf.length && out.length ? out : null;
}

// Web chats send the message and stream the reply on separate requests. Each reader returns
// { conv, user, msg? } for a send, { conv, replies: [{ msg, part, text }] } for reply snapshots
// (msg = which answer, part = which piece of it; the longest snapshot of a part wins), or
// { skip: true } for the channel's other traffic.

// claude.ai (anthropic.bard ConversationService, protobuf). Field numbers read off live traffic:
// PerformAction request: 2.2 = conversation id, 2.3 = the message typed.
// StreamTimeline frames: 1.1.4.2 = conversation id, 1.1.5 = content block
// (1 = block id, 2 = its display group, 9 = full text so far).
export function claudeRpc(pathname, reqBuf, resBuf) {
  const str = (b) => (b ? b.toString("utf8") : "");
  if (/\/PerformAction$/.test(pathname)) {
    const user = str(protoAll(reqBuf, [2, 3])[0]).trim();
    return user ? { conv: str(protoAll(reqBuf, [2, 2])[0]), user } : { skip: true };
  }
  if (/\/StreamTimeline$/.test(pathname)) {
    let conv = "";
    const replies = [];
    for (const frame of connectFrames(resBuf) || [resBuf]) {
      conv = str(protoAll(frame, [1, 1, 4, 2])[0]) || conv;
      for (const block of protoAll(frame, [1, 1, 5])) {
        const part = str(protoAll(block, [1])[0]);
        const text = str(protoAll(block, [9])[0]);
        if (part && text) replies.push({ msg: str(protoAll(block, [2])[0]) || part, part, text });
      }
    }
    return replies.length ? { conv, replies } : { skip: true };
  }
  return { skip: true };
}

// Gemini reply candidates anywhere in a protobuf tree: { 1: "rc_<id>", 2: { 1: text so far } }.
function geminiCandidates(buf, out, depth) {
  const fields = protoFields(buf);
  const id = fields.find(([k]) => k === 1)?.[1].toString("latin1");
  if (id && /^rc_[0-9a-f]+$/.test(id)) {
    const text = (protoAll(buf, [2, 1])[0] || Buffer.alloc(0)).toString("utf8");
    if (text.trim()) out.push({ msg: id, part: id, text });
    return out;
  }
  if (depth < 16) for (const [, v] of fields) geminiCandidates(v, out, depth + 1);
  return out;
}

// gemini.google.com WebChannel (geminiweb-pa /v1/processSession). Sends are form posts whose
// reqN___data__ values are base64 protobuf; the typed message sits at field 2.9.1. Replies arrive
// on the channel's long-poll GETs as `len\n[[n,["<base64 protobuf>"]]]` chunks, each carrying the
// whole reply so far, often split across several GETs.
export function geminiChannel(method, reqBuf, resBuf) {
  if (method === "POST") {
    const users = [];
    for (const [key, value] of new URLSearchParams(reqBuf.toString("utf8"))) {
      if (!/^req\d+___data__$/.test(key)) continue;
      const text = (protoAll(Buffer.from(value, "base64"), [2, 9, 1])[0] || Buffer.alloc(0)).toString("utf8").trim();
      if (text) users.push(text);
    }
    return users.length ? { conv: "gemini", user: users.join("\n\n") } : { skip: true };
  }
  const replies = [];
  for (const [, b64] of resBuf.toString("utf8").matchAll(/"([A-Za-z0-9+/_-]{16,}={0,2})"/g)) {
    geminiCandidates(Buffer.from(b64, "base64"), replies, 0);
  }
  return replies.length ? { conv: "gemini", replies } : { skip: true };
}

// chatgpt.com web. The send carries the typed message and its id; the reply streams over a
// separate channel, then the page fetches the conversation, where the newest assistant messages
// hang under that message id.
export function chatgptWeb(method, pathname, reqBuf, resBuf) {
  if (method === "POST" && /^\/backend-api\/(f\/)?conversation$/.test(pathname)) {
    const sent = tryJson(reqBuf)?.messages?.findLast?.((m) => roleOf(m) === "user");
    const user = sent ? scrubText(textFromContent(sent.content)).trim() : "";
    if (!user) return { skip: true };
    const msg = String(sent.id || crypto.randomUUID());
    const sse = parseSse(resBuf.toString("utf8"));
    return { conv: "chatgpt", user, msg, replies: sse.text ? [{ msg, part: "stream", text: sse.text, model: sse.model }] : [] };
  }
  if (method === "GET" && /^\/backend-api\/conversations?\/[0-9a-f-]{20,}$/.test(pathname)) {
    const json = tryJson(resBuf);
    const map = json?.mapping;
    if (!map || typeof map !== "object") return { skip: true };
    const found = [];
    let node = map[json.current_node];
    for (let hops = 0; node && hops < 1000; hops++, node = map[node.parent]) {
      const m = node.message;
      if (!m || m.metadata?.is_visually_hidden_from_conversation) continue;
      if (m.author?.role === "user") {
        if (!found.length) break;
        const ask = scrubText(textFromContent(m.content)).trim();
        // The page re-fetches whole conversations: these replies replace the turn's, never add to it.
        return { conv: "chatgpt", replies: found.reverse().map((r) => ({ ...r, msg: String(m.id), ask, replace: true })) };
      }
      const text = m.author?.role === "assistant" && m.content?.content_type === "text" ? textFromContent(m.content).trim() : "";
      if (text) found.push({ part: String(m.id), text, model: m.metadata?.model_slug || null });
    }
    return { skip: true };
  }
  return null;
}

// grok.com Build (/ws/mgw/): a realtime-style socket. Message items carry text in x_grok chunks;
// an answer names its question in parent_response_id. Items come on history loads and live, so
// the question's item id keys the row.
export function grokBuild(reqBuf, resBuf) {
  const turns = new Map();
  const turn = (id) => turns.get(id) || turns.set(id, { id }).get(id);
  // Message items, wherever an event carries them (history loads, live updates).
  const items = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (v.x_grok && v.id && (v.role === "user" || v.role === "assistant")) return void items.push(v);
    for (const k in v) walk(v[k], depth + 1);
  };
  let unread = false;
  for (const line of `${reqBuf}\n${resBuf}`.split("\n")) {
    const json = tryJson(Buffer.from(line));
    if (!json) continue;
    if (!/^(ping|pong|presence\.update|conversation\.history\.(item|done))$/.test(json.event?.type || json.type || "")) unread = true;
    walk(json, 0);
  }
  for (const item of items) {
    const x = item.x_grok;
    if (item.role === "user") {
      const text = (x.input_chunks || []).map((c) => c.text?.text).filter(Boolean).join("\n") || textFromContent(item.content);
      if (text.trim()) turn(item.id).user = text;
    } else if (item.role === "assistant" && x.parent_response_id) {
      const t = turn(x.parent_response_id);
      // Progress notes and the final answer; the thinking headers are left out.
      const text = (x.output_chunks || []).filter((c) => c.text?.channel === "CHANNEL_ASSISTANT_RESPONSE").map((c) => c.text.text.trim()).filter(Boolean).join("\n\n");
      if (text) t.reply = text;
      if (x.thinking_start_time_ms) t.at = new Date(Number(x.thinking_start_time_ms)).toISOString();
    }
  }
  // unread: events besides history and keep-alives, kept in raw\ so new live formats can be checked.
  return turns.size ? { conv: "grok-build", turns: [...turns.values()], unread } : { skip: true, unread };
}

// Grok Bot desktop app (api2.cursor.sh GrokBotService, protobuf). Each transcript poll returns the
// agent's latest entries: field 1 = entry { 2 = kind, 3 = JSON }. Ids name the turn: "t39u" is the
// question, "t39s241", "t39s242"... are the agent's messages in that turn.
export function grokBot(reqBuf, resBuf) {
  const agent = String(protoAll(reqBuf, [1])[0] || "");
  const turns = new Map();
  for (const entry of protoAll(resBuf, [1])) {
    let j;
    try { j = JSON.parse(String(protoAll(entry, [3])[0] || "")); } catch { continue; }
    const m = /^t(\d+)(?:u|s(\d+))$/.exec(j?.id || "");
    if (!m) continue;
    const t = turns.get(m[1]) || turns.set(m[1], { id: `t${m[1]}`, parts: [] }).get(m[1]);
    // Messages other agents send in are not the person's.
    if (!m[2] && j.kind === "message" && j.role === "user" && !j.fromAgent && typeof j.content === "string") {
      t.user = j.content;
      if (j.timestampMs) t.at = new Date(Number(j.timestampMs)).toISOString();
    } else if (m[2] && j.kind === "send-message" && j.message?.type === "text" && j.message.content) {
      t.parts.push([Number(m[2]), String(j.message.content).trim()]);
    }
  }
  // Only turns whose question is in this poll: an older turn cut off by the window would lose replies.
  const out = [...turns.values()].filter((t) => t.user).map(({ parts, ...t }) => ({ ...t, reply: parts.sort((a, b) => a[0] - b[0]).map((p) => p[1]).join("\n\n") }));
  return out.length ? { conv: `grok-bot-${agent}`, turns: out } : { skip: true };
}

// Claude app Code sessions. Opening a session fetches its log (GET .../sessions/<id>/events: one page
// of events, either order); the socket (.../sessions/ws/<id>/subscribe) streams new ones, a long turn
// over several flushes (id null = more of the newest turn); POST .../events carries what is typed.
const NOT_TYPED = /^(<(task-notification|agent-message|bash-std(out|err)|local-command-[\w-]+|command-[\w-]+)>|\[Request interrupted)/;
export function claudeCode(pathname, reqBuf, resBuf) {
  const sid = /\/(?:cse|session)_(\w+)\//.exec(pathname)?.[1];
  if (!sid) return null;
  const turns = [];
  let cur = null;
  const page = tryJson(resBuf);
  const docs = Array.isArray(page?.data) ? [page] : `${reqBuf}\n${resBuf}`.split("\n").map((l) => tryJson(Buffer.from(l)));
  for (const j of docs) {
    const events = Array.isArray(j?.data)
      ? j.data.slice().sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num)).map((x) => x?.payload && { timestamp: x.created_at, ...x.payload })
      : Array.isArray(j?.events) ? j.events.map((x) => x?.payload) : [j];
    for (const e of events) {
      if (!e || e.parent_tool_use_id) continue; // a subagent's own messages
      const content = e.message?.content;
      if (e.type === "user") {
        const blocks = typeof content === "string" ? [{ text: content }] : Array.isArray(content) && !content.some((b) => b.type === "tool_result") ? content : [];
        const text = blocks.map((b) => b.text).filter(Boolean).join("\n").replace(INJECTED, "").trim();
        // Tool results, other agents and Claude Code's own notices belong to the turn already running.
        if (!text || e.isMeta || e.isSynthetic || (e.origin?.kind && e.origin.kind !== "human") || NOT_TYPED.test(text)) continue;
        turns.push((cur = { id: e.uuid, user: text, parts: [], ...(e.timestamp ? { at: e.timestamp } : {}) }));
      } else if (e.type === "assistant" && Array.isArray(content)) {
        const text = content.filter((b) => b.type === "text" && b.text).map((b) => b.text.trim()).join("\n\n");
        if (!text) continue;
        // A newest-first page is history and can start mid-turn; an oldest-first page is what's new since
        // the last fetch (like the socket), so its leading reply continues the newest turn.
        if (!cur && j === page && Number(page.data[0]?.sequence_num) > Number(page.data.at(-1)?.sequence_num)) continue;
        if (!cur) turns.push((cur = { id: null, parts: [] }));
        cur.parts.push([e.uuid || e.message.id, text]);
      }
    }
  }
  return turns.length ? { conv: `claude-code-${sid}`, turns } : { skip: true };
}

function webChat(host, method, pathname, reqBuf, resBuf) {
  if (host === "claude.ai" && /^\/v1\/(code\/)?sessions\/(ws\/)?(cse|session)_\w+\/(events|subscribe)\b/.test(pathname)) {
    return claudeCode(pathname, reqBuf, resBuf);
  }
  if (/\/aiserver\.v1\.GrokBotService\/ListGrokBotTranscriptEntries$/.test(pathname)) return grokBot(reqBuf, resBuf);
  if (host === "grok.com" && pathname === "/ws/bot/") return { skip: true }; // Grok Bot's control link: agent lists, pings

  if (host === "grok.com" && /^\/ws\/mgw\b/.test(pathname)) return grokBuild(reqBuf, resBuf);
  if (/^\/claudeai-rpc\//.test(pathname)) return claudeRpc(pathname, reqBuf, resBuf);
  if (/^geminiweb-pa\./.test(host) && /\/processSession$/.test(pathname)) return geminiChannel(method, reqBuf, resBuf);
  if (/^(chatgpt\.com|chat\.openai\.com)$/.test(host)) return chatgptWeb(method, pathname, reqBuf, resBuf);
  return null;
}

function addUsage(a, b) {
  if (!a || !b) return a || b || null;
  return { input: (a.input || 0) + (b.input || 0), output: (a.output || 0) + (b.output || 0) };
}

// One row per conversation turn. An exchange either opens a turn (something was typed) or adds
// reply to one (a streamed snapshot, a tool round-trip, a reconnected stream). Every change
// re-appends the whole row under the same id; readers keep the newest copy.
export function makeRecorder({ write, dump = () => {}, seenRefs = new Set(), onSkip = () => {} }) {
  const latest = new Map(); // conversation key -> newest turn
  const waiting = new Map(); // conversation key -> turns with no reply yet, oldest first
  const owner = new Map(); // answer / response id -> turn
  // Answers seen before their question's request finished (ChatGPT fetches the reply while the
  // send is still open). Held two minutes for the send to claim.
  const early = new Map(); // message id -> { at, ask, replies }
  const sweep = () => {
    for (const [k, e] of early) if (e.at < Date.now() - 120_000) early.delete(k);
    const cutoff = Date.now() - 30 * 60_000;
    for (const map of [latest, owner]) for (const [k, t] of map) if (t.seen < cutoff) map.delete(k);
    for (const [k, list] of waiting) {
      const live = list.filter((t) => t.seen >= cutoff);
      if (live.length) waiting.set(k, live);
      else waiting.delete(k);
    }
  };
  const save = (turn) => {
    turn.seen = Date.now();
    turn.row.responseText = scrubText([...turn.parts.values()].filter(Boolean).join("\n\n")).trim().slice(0, 100_000);
    write({ ...turn.row, requestMessages: turn.row.requestMessages.slice() });
  };
  const open = (key, row) => {
    sweep();
    const turn = { key, row, parts: new Map(), seen: Date.now() };
    latest.set(key, turn);
    waiting.set(key, (waiting.get(key) || []).concat(turn));
    return turn;
  };
  // An answer also closes every older unanswered question: its reply was lost, not late.
  const answered = (turn) => {
    const list = waiting.get(turn.key);
    if (list) waiting.set(turn.key, list.slice(list.indexOf(turn) + 1));
  };
  const rowFor = (meta, extra) => ({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    provider: providerFor(meta.host),
    host: meta.host,
    method: "POST",
    path: safePath(meta.path),
    status: meta.status || 0,
    model: null,
    latencyMs: meta.latencyMs ?? 0,
    streaming: true,
    requestMessages: [],
    responseText: "",
    usage: null,
    bytesIn: 0,
    bytesOut: 0,
    secretsStripped: true,
    ...extra,
  });

  function webTurn(meta, rpc, reqBuf, resBuf) {
    const key = `${meta.host}|${rpc.conv}`;
    // Complete question/answer pairs with the service's own ids: the same id is the same row,
    // also when a history reload sends it again.
    for (const t of rpc.turns || []) {
      const id = `${rpc.conv}-${t.id}`;
      // No id: more of the conversation's newest turn (a long reply arriving in pieces).
      let turn = t.id ? owner.get(id) : latest.get(key);
      if (!turn) {
        if (!t.id) continue;
        turn = { key, row: rowFor(meta, { id, ...(t.at ? { at: t.at } : {}) }), parts: new Map(), seen: Date.now() };
        owner.set(id, turn);
      }
      // A history page fetched later is older: the newest turn stays the one the socket continues.
      if (!latest.get(key) || latest.get(key).row.at <= turn.row.at) latest.set(key, turn);
      const before = JSON.stringify([turn.row.requestMessages, [...turn.parts]]);
      if (t.user) turn.row.requestMessages = [{ role: "user", text: scrubText(t.user).trim() }];
      if (t.reply) turn.parts.set("reply", t.reply);
      for (const [part, text] of t.parts || []) turn.parts.set(part, text);
      if (turn.row.requestMessages.length && JSON.stringify([turn.row.requestMessages, [...turn.parts]]) !== before) save(turn);
    }
    if (rpc.turns) return;
    let replies = rpc.replies || [];
    if (rpc.user) {
      const text = scrubText(rpc.user).trim();
      const prev = latest.get(key);
      let turn = prev;
      // The same send retried before any reply is still one turn.
      if (!(prev && !prev.parts.size && prev.row.requestMessages.at(-1)?.text === text)) {
        turn = open(key, rowFor(meta, { requestMessages: [{ role: "user", text }], bytesIn: reqBuf.length }));
        save(turn);
      }
      if (rpc.msg) owner.set(rpc.msg, turn);
      for (const [id, e] of early) {
        if (id !== rpc.msg && e.ask !== text) continue;
        early.delete(id);
        replies = replies.concat(e.replies);
      }
    }
    const touched = new Set();
    const cleared = new Set();
    for (const r of replies) {
      let turn = owner.get(r.msg);
      if (!turn && r.ask !== undefined) {
        // An answer to something not sent this session yet: the exact question still waiting, or hold it.
        turn = (waiting.get(key) || []).find((t) => t.row.requestMessages.at(-1)?.text === r.ask);
        if (!turn) {
          early.set(r.msg, { at: Date.now(), ask: r.ask, replies: [r] });
          continue;
        }
      }
      if (!turn) {
        // ponytail: an unclaimed answer goes to the newest question (web UIs block sending mid-reply, and
        // lost replies happen). Two questions really in flight would cross; key by a turn id if one shows up.
        turn = (waiting.get(key) || []).at(-1) || latest.get(key) || open(key, rowFor(meta, {}));
      }
      owner.set(r.msg, turn);
      if (r.replace && !cleared.has(turn)) {
        turn.parts.clear();
        cleared.add(turn);
      }
      if (r.text.length >= (turn.parts.get(r.part)?.length || 0)) turn.parts.set(r.part, r.text);
      if (r.model) turn.row.model = r.model;
      answered(turn);
      touched.add(turn);
    }
    for (const turn of touched) {
      turn.row.bytesOut += resBuf.length;
      save(turn);
    }
  }

  function apiTurn(meta, record) {
    const { responseId, previousId, turnKey, ...row } = record;
    const key = `${meta.host}|${turnKey || row.thread || row.id}`;
    const typed = row.requestMessages.some((m) => m.role === "user");
    // The client's own turn id is exact. Without one: a new message opens a turn, anything else
    // (tool output, a continuation) belongs to the response it follows or the thread's latest turn.
    const linked = turnKey ? owner.get(turnKey) : null;
    let turn = linked || (typed ? null : (previousId && owner.get(previousId)) || (row.thread && latest.get(key)) || null);
    // A reply with no question and nothing it continues is a client's own background job.
    if (!turn && !row.requestMessages.length && !row.thread && !previousId && !turnKey) return;
    if (!turn) {
      turn = open(key, { ...row, responseText: "" });
    } else {
      // A tool round-trip or follow-up call inside the same turn: more reply, same row.
      const t = turn.row;
      t.model = row.model || t.model;
      t.latencyMs += row.latencyMs;
      t.bytesIn += row.bytesIn;
      t.bytesOut += row.bytesOut;
      t.usage = addUsage(t.usage, row.usage);
      // Typed mid-turn (a steer): add it, once.
      for (const m of row.requestMessages) if (linked && !t.requestMessages.some((x) => x.text === m.text)) t.requestMessages.push(m);
    }
    if (row.responseText) {
      turn.parts.set(row.id, row.responseText);
      answered(turn);
    }
    if (responseId) owner.set(responseId, turn);
    if (turnKey) owner.set(turnKey, turn);
    save(turn);
  }

  return function consider(meta) {
    const cap = 8 * 1024 * 1024;
    const reqBuf = decodeBody(meta.reqBuf, meta.reqEncoding).subarray(0, cap);
    const resBuf = decodeBody(meta.resBuf, meta.resEncoding).subarray(0, cap);
    const rpc = webChat(meta.host, meta.method, safePath(meta.path), reqBuf, resBuf);
    if (rpc) {
      if (rpc.user && !rpc.replies?.length) dump(meta, reqBuf, resBuf, "reply comes later");
      else if (rpc.unread) dump(meta, reqBuf, resBuf, "unread events");
      if (!rpc.skip) webTurn(meta, rpc, reqBuf, resBuf);
      return;
    }
    const record = extractExchange({
      host: meta.host,
      method: meta.method,
      path: meta.path,
      status: meta.status,
      reqBuf,
      resBuf,
      resType: meta.resType,
      latencyMs: meta.latencyMs,
    });
    const card = referenceFrom(asJsonTree(resBuf), meta) || referenceFrom(asJsonTree(reqBuf), meta);
    if (card) {
      const k = String(card.email || card.accountId || `${card.name}|${card.host}`).toLowerCase();
      if (!seenRefs.has(k)) {
        seenRefs.add(k);
        write(card);
      }
    }
    if (meta.method !== "GET" && (!record || !record.responseText)) dump(meta, reqBuf, resBuf, record ? "no reply text" : "skipped");
    if (!record) return onSkip();
    // Codex's reviewer re-reads the session to vet commands; it is not a turn anyone typed.
    if (/auto-review/i.test(record.model || "")) return;
    apiTurn(meta, record);
  };
}

function firstString(bag, keys) {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === "string" && value.trim()) return scrubText(value).trim();
  }
  return null;
}

export function referenceFrom(json, meta) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const bag = {};
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 4) return;
    for (const [key, value] of Object.entries(node)) {
      if (
        typeof value === "string" &&
        /^(email|user_email|email_address|phone|phone_number|e164|name|display_name|full_name|account_name|plan|subscription|account_type|org_name|account_id|accountId|user_id|org_id)$/i.test(key) &&
        !/^(assistant|user|system|model|tool|function)$/i.test(value)
      ) {
        if (!bag[key]) bag[key] = value;
      } else if (value && typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(json, 0);
  const email = firstString(bag, ["email", "user_email", "email_address"]);
  const name = firstString(bag, ["name", "display_name", "full_name", "account_name"]);
  const phone = firstString(bag, ["phone", "phone_number", "e164"]);
  const plan = firstString(bag, ["plan", "subscription", "account_type", "org_name"]);
  const accountId = firstString(bag, ["account_id", "accountId", "user_id", "org_id"]);
  if (!email && !name && !phone && !plan) return null;
  if (/token|secret|password|cookie|session/i.test(`${email} ${name} ${phone}`)) return null;
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind: "reference",
    provider: providerFor(meta.host || ""),
    host: meta.host || "",
    path: safePath(meta.path || "/"),
    email,
    name,
    phone,
    plan,
    accountId,
  };
}

// AI programs whose HTTPS goes straight out instead of through Silt: started before Silt, or ignoring
// the proxy. Reads `netstat -ano` and `tasklist /fo csv /nh`; no driver, no admin. The state column
// is never read, so a translated Windows parses the same.
const AI_APPS = /^(claude|chatgpt|grok bot|cursor|code|codex|antigravity|windsurf|node|bun)\.exe$/i;
export function directApps(netstatText, tasklistText, selfPid, proxyPort) {
  const names = new Map([...tasklistText.matchAll(/^"([^"]+)","(\d+)"/gm)].map((m) => [m[2], m[1]]));
  const loopback = (a) => /^(127\.|::1$|::ffff:127\.)/.test(a);
  const apps = new Map();
  for (const line of netstatText.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const pid = cols.at(-1);
    if (cols[0] !== "TCP" || cols.length < 5 || pid === "0" || Number(pid) === selfPid || !AI_APPS.test(names.get(pid) || "")) continue;
    const at = cols[2].lastIndexOf(":");
    const addr = cols[2].slice(0, at).replace(/^\[|\]$/g, "");
    const port = Number(cols[2].slice(at + 1));
    const app = apps.get(pid) || apps.set(pid, { name: names.get(pid), pid: Number(pid), direct: 0, via: 0 }).get(pid);
    if (port === proxyPort && loopback(addr)) app.via++;
    else if (port === 443 && !loopback(addr)) app.direct++;
  }
  return [...apps.values()].filter((a) => a.direct).sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
}

function defaultDataDir() {
  if (process.env.SILT_DATA_DIR) return process.env.SILT_DATA_DIR;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Silt");
  }
  return path.join(os.homedir(), ".silt");
}

function loadRules(dataDir) {
  const rules = (process.env.SILT_EXTRA_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const file = path.join(dataDir, "hosts.txt");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) rules.push(t);
    }
  }
  return rules;
}

function loadOrCreateCa(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, "silt-ca.key.pem");
  const certPath = path.join(dataDir, "silt-ca.crt");
  const cerPath = path.join(dataDir, "silt-ca.cer");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      keyPem: fs.readFileSync(keyPath, "utf8"),
      certPem: fs.readFileSync(certPath, "utf8"),
      certPath,
      cerPath,
    };
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "a1" + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: "commonName", value: "Silt Local Recorder" },
    { name: "organizationName", value: "Silt" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certPem);
  fs.writeFileSync(cerPath, Buffer.from(der, "binary"));
  return { keyPem, certPem, certPath, cerPath };
}

const leafCache = new Map();

function leafFor(host, ca) {
  const cached = leafCache.get(host);
  if (cached) return cached;
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "b2" + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: "commonName", value: host }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames = net.isIP(host)
    ? [{ type: 7, ip: host }]
    : [{ type: 2, value: host }];
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  const material = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert) + ca.certPem,
  };
  leafCache.set(host, material);
  return material;
}

function stripHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// A turn is re-appended each time its reply grows: keep its first position and `at`, newest content.
export function parseTape(text) {
  const byId = new Map();
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn line
    }
    const first = byId.get(row.id);
    byId.set(row.id ?? Symbol(), first ? { ...row, at: first.at } : row);
  }
  return [...byId.values()];
}

// Folds repeated copies at startup so the file stays one line per turn.
function compactTape(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const rows = parseTape(text);
  if (rows.length < text.split("\n").filter((l) => l.trim()).length) {
    fs.writeFileSync(file + ".tmp", rows.map((r) => JSON.stringify(r) + "\n").join(""));
    fs.renameSync(file + ".tmp", file);
  }
  return rows;
}

function readCaptures(file, limit, query = "", chatsOnly = false) {
  if (!fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  let text;
  if (!query.trim() && stat.size > 2_000_000) {
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, stat.size - 1_500_000);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    if (nl !== -1) text = text.slice(nl + 1);
  } else {
    text = fs.readFileSync(file, "utf8");
  }
  const rows = parseTape(text);
  const refs = rows.filter((row) => row.kind === "reference");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const keep = (row) => {
    if (row.kind === "reference") return false;
    if (chatsOnly && !isChat(row)) return false;
    if (!words.length) return true;
    const hay = [row.provider, row.model, row.host, row.responseText, ...(row.requestMessages || []).map((m) => m.text)]
      .join("\n")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return refs.concat(rows.filter(keep).slice(-limit));
}

// A conversation turn, as opposed to settings/account pages the apps also fetch.
function isChat(row) {
  const p = row.path || "";
  return (
    isAiPath(p) ||
    /^\/claudeai-rpc\/|^\/ws\/mgw\b|ListGrokBotTranscriptEntries$|^\/v1\/code\/sessions\/cse_\w+\/events$|\/sessions\/ws\/session_\w+\/subscribe$|\/processSession$|\/backend-api\/(f\/)?conversation$|\/app-chat\/conversations\/(new|[^/]+\/responses)$|\/completion(\/stream)?$|perplexity_ask|GetChatMessage/.test(p)
  );
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Silt</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0c0b0a; color: #eceae4; font-family: "Segoe UI", sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; padding: 20px 24px; border-bottom: 1px solid #2e2a26; }
  h1 { font-family: Georgia, serif; font-weight: 500; font-size: 32px; margin: 0; letter-spacing: -0.03em; }
  p { margin: 4px 0 0; color: #8d877e; font-size: 14px; }
  button, a.btn { background: #eceae4; color: #0c0b0a; border: 0; border-radius: 6px; padding: 10px 14px; font: inherit; cursor: pointer; text-decoration: none; }
  button.ghost, button.tab { background: transparent; color: #c9c2b6; border: 1px solid #2e2a26; }
  button.tab.on { background: #eceae4; color: #0c0b0a; border-color: #eceae4; }
  nav.areas { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 24px; border-bottom: 1px solid #2e2a26; }
  input[type=search] { flex: 1; min-width: 200px; background: #171513; color: #eceae4; border: 1px solid #2e2a26; border-radius: 6px; padding: 10px 12px; font: inherit; }
  input[type=search]:focus { outline: 2px solid #b5523a; outline-offset: -1px; }
  label { color: #c9c2b6; font-size: 14px; display: flex; gap: 6px; align-items: center; cursor: pointer; }
  main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(240px, 360px) 1fr; }
  ul { list-style: none; margin: 0; padding: 8px; overflow: auto; border-right: 1px solid #2e2a26; }
  li { padding: 12px; border-radius: 8px; cursor: pointer; }
  li:hover { background: #171513; }
  li.on { background: #1f1c19; }
  .meta { color: #8d877e; font-size: 12px; }
  .warn { color: #e0a458; }
  .warn:empty { display: none; }
  article { padding: 24px; overflow: auto; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: Georgia, serif; font-size: 17px; line-height: 1.5; }
  mark { background: #b5523a; color: #fff; border-radius: 2px; }
  .role { color: #b5523a; font-family: "Segoe UI", sans-serif; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 18px; }
  #newer { display: none; margin: 0 0 8px; width: 100%; }
  dl { display: grid; grid-template-columns: 8rem 1fr; gap: 8px 16px; margin: 16px 0 0; }
  dt { color: #8d877e; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } ul { max-height: 40vh; border-right: 0; border-bottom: 1px solid #2e2a26; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>Silt</h1>
    <p id="stats">Reading this machine. Keys are stripped before anything is written.</p>
    <p id="direct" class="warn"></p>
  </div>
  <div style="display:flex;gap:8px">
    <a class="btn" href="/api/export">Export</a>
    <button class="ghost" id="clear" type="button">Clear tape</button>
  </div>
</header>
<nav class="areas">
  <button class="tab on" id="tab-messages" type="button">Messages</button>
  <button class="tab" id="tab-reference" type="button">Reference</button>
  <input type="search" id="q" placeholder="Search all history (words, app, model)…" autocomplete="off"/>
  <label><input type="checkbox" id="chats" checked/> Chats only</label>
</nav>
<main>
  <ul id="list"></ul>
  <article id="read"><p class="meta">No agent messages yet. Use a proxied app, then come back.</p></article>
</main>
<script>
const list = document.getElementById("list");
const read = document.getElementById("read");
const qBox = document.getElementById("q");
const chats = document.getElementById("chats");
let rows = [];
let current = null;
let shown = null;
let shownContent = "";
let area = "messages";
let sig = "";
function esc(s){return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function mark(s){
  const html = esc(s);
  const words = qBox.value.trim().split(/\\s+/).filter(Boolean).map(w => esc(w).replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"));
  return words.length ? html.replace(new RegExp("(" + words.join("|") + ")", "gi"), "<mark>$1</mark>") : html;
}
function when(at){ const d = new Date(at); return isNaN(d) ? "" : d.toLocaleString(); }
function messages(){ return rows.filter(r => r.kind !== "reference"); }
function references(){ return rows.filter(r => r.kind === "reference"); }
function drawList(){
  const pool = area === "reference" ? references() : messages();
  document.getElementById("tab-messages").className = "tab" + (area === "messages" ? " on" : "");
  document.getElementById("tab-reference").className = "tab" + (area === "reference" ? " on" : "");
  // Newest first. Keep the reader where they are when rows arrive.
  const top = list.scrollTop;
  const anchor = [...list.children].find(li => li.offsetTop >= top);
  const anchorId = anchor?.dataset.id;
  const anchorOffset = anchor ? anchor.offsetTop - top : 0;
  list.innerHTML = pool.slice().reverse().map(r => {
    if (r.kind === "reference") {
      const title = r.email || r.name || r.accountId || r.host;
      return '<li data-id="'+esc(r.id)+'" class="'+(r.id===current?'on':'')+'"><div class="meta">'+esc(r.provider)+'</div><div>'+esc(title)+'</div></li>';
    }
    const preview = (r.requestMessages||[]).slice().reverse().find(m => m.role === "user") || (r.requestMessages||[])[0];
    const text = preview ? preview.text : (r.responseText || r.path);
    return '<li data-id="'+esc(r.id)+'" class="'+(r.id===current?'on':'')+'"><div class="meta">'+esc(r.provider)+' · '+esc(r.model||"model unknown")+' · '+esc(when(r.at))+'</div><div>'+mark(text.replace(/\\s+/g," ").slice(0,140))+'</div></li>';
  }).join("") || '<li class="meta">'+(qBox.value.trim() ? "No matches." : area === "reference" ? "No account reference yet." : "Nothing recorded yet.")+'</li>';
  const again = anchorId && [...list.children].find(li => li.dataset.id === anchorId);
  list.scrollTop = top > 0 && again ? again.offsetTop - anchorOffset : top;
  return pool;
}
function drawRead(pool){
  const row = pool.find(r => r.id === current) || pool[pool.length-1];
  if (!row) {
    shown = null;
    read.innerHTML = '<p class="meta">'+(area === "reference" ? "Account pages show up here, once each." : "No agent messages yet.")+'</p>';
    return;
  }
  current = row.id;
  // Same row whose reply grew: redraw in place. A different row or search: start at the top.
  const key = row.id + "|" + qBox.value;
  const content = (row.responseText||"").length + "|" + (row.requestMessages||[]).length;
  if (shown === key && shownContent === content) return;
  const sameRow = shown === key;
  shown = key;
  shownContent = content;
  const keepTop = read.scrollTop;
  if (row.kind === "reference") {
    const facts = [["Email", row.email], ["Name", row.name], ["Phone", row.phone], ["Plan", row.plan], ["Account", row.accountId], ["Host", row.host], ["Path", row.path]];
    read.innerHTML = '<div class="meta">Saved once for reference</div><h2 style="font-family:Georgia,serif;font-weight:500;margin:8px 0 0">'+esc(row.email || row.name || "Account")+'</h2><dl>'+facts.filter(f => f[1]).map(f => '<dt>'+esc(f[0])+'</dt><dd>'+esc(f[1])+'</dd>').join("")+'</dl>';
    return;
  }
  const msgs = (row.requestMessages||[]).map(m => '<div class="role">'+esc(m.role)+'</div><pre>'+mark(m.text)+'</pre>').join("");
  read.innerHTML = '<div class="meta">'+esc(when(row.at))+' · '+esc(row.method)+' '+esc(row.host)+esc(row.path)+' · '+esc(row.status)+' · '+esc(row.latencyMs)+' ms</div>'+msgs+'<div class="role">Agent</div><pre>'+mark(row.responseText||"(empty)")+'</pre>';
  if (sameRow) { read.scrollTop = keepTop; return; }
  read.scrollTop = 0;
  read.querySelector("mark")?.scrollIntoView({ block: "center" });
}
function draw(){
  const pool = drawList();
  drawRead(pool);
}
async function refresh(force){
  const params = new URLSearchParams({ q: qBox.value.trim(), all: chats.checked ? "0" : "1" });
  const [cap, stats] = await Promise.all([fetch("/api/captures?" + params), fetch("/api/stats")]);
  const next = await cap.json();
  const s = await stats.json();
  document.getElementById("stats").textContent = (qBox.value.trim() ? messages().length+" matches · " : s.aiCaptures+" saved · ")+references().length+" reference cards · "+s.otherConnections+" other connections counted, not opened"+(s.refused && s.refused.length ? " · passed through unread (app refused the certificate): "+s.refused.join(", ") : "");
  const by = {};
  for (const a of s.direct || []) (by[a.name.replace(/\\.exe$/i, "")] ||= []).push(a.pid + (a.via ? " (partly)" : ""));
  document.getElementById("direct").textContent = Object.keys(by).length ? "Not recorded, connecting around Silt: " + Object.entries(by).map(([n, p]) => n + " " + p.join(", ")).join(" · ") + ". Quit and reopen these; for command-line tools open a new terminal. One that keeps showing up ignores the proxy." : "";
  const nextSig = next.length + "|" + (next.at(-1)?.id || "") + "|" + next.reduce((n, r) => n + (r.responseText||"").length + (r.requestMessages||[]).length, 0);
  if (!force && nextSig === sig) return;
  sig = nextSig;
  rows = next;
  draw();
}
list.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li || !li.dataset.id) return;
  current = li.dataset.id;
  draw();
});
let typing = null;
qBox.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { current = null; list.scrollTop = 0; refresh(true); }, 250); });
chats.addEventListener("change", () => { current = null; list.scrollTop = 0; refresh(true); });
document.getElementById("tab-messages").addEventListener("click", () => { area = "messages"; current = null; list.scrollTop = 0; draw(); });
document.getElementById("tab-reference").addEventListener("click", () => { area = "reference"; current = null; list.scrollTop = 0; draw(); });
document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Delete every saved message?")) return;
  await fetch("/api/clear", { method: "POST", headers: { "x-silt-action": "clear" } });
  current = null;
  refresh(true);
});
refresh(true);
setInterval(() => { if (!document.hidden) refresh(false); }, 2000);
</script>
</body>
</html>`;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

function main() {
  const dataDir = defaultDataDir();
  const initOnly = process.argv.includes("--init");
  const ca = loadOrCreateCa(dataDir);
  if (initOnly) {
    // Node, Bun and Python tools ignore the Windows store. One file of the public roots, any CA file
    // the user already pointed them at, and Silt's: Start-Silt points NODE_EXTRA_CA_CERTS,
    // SSL_CERT_FILE and REQUESTS_CA_BUNDLE at it.
    const bundle = path.join(dataDir, "ca-bundle.pem");
    const prior = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]
      .map((name) => process.env[name])
      .filter((file) => file && path.resolve(file) !== path.resolve(bundle) && fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"));
    const silt = fs.readFileSync(path.join(dataDir, "silt-ca.crt"), "utf8");
    fs.writeFileSync(bundle, [...tls.rootCertificates, ...prior, silt].map((pem) => pem.trim()).join("\n") + "\n");
    console.log(ca.cerPath);
    return;
  }

  const rules = loadRules(dataDir);
  const proxyPort = Number(process.env.SILT_PROXY_PORT || 8877);
  const uiPort = Number(process.env.SILT_UI_PORT || 8878);
  const captureFile = path.join(dataDir, "captures.jsonl");
  const rawDir = path.join(dataDir, "raw");
  const rawOn = fs.existsSync(rawDir);
  const seenTunnels = new Set();
  // Hosts whose client refused Silt's certificate this session; passed through unread from then on.
  const refused = new Set();
  // AI programs connecting around Silt, for the desk warning. Refreshed at most every 15 s while the desk polls.
  let direct = [];
  let directAt = 0;
  function checkDirect() {
    if (process.platform !== "win32" || Date.now() - directAt < 15000) return;
    directAt = Date.now();
    const opts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
    execFile("netstat", ["-ano"], opts, (err, ns) => {
      if (err) return;
      execFile("tasklist", ["/fo", "csv", "/nh"], opts, (err2, tl) => {
        if (!err2) direct = directApps(ns, tl, process.pid, proxyPort);
      });
    });
  }

  // Debug: create %LOCALAPPDATA%\Silt\raw to dump exchanges Silt could not read. Delete it to stop.
  function dumpRaw(meta, reqBuf, resBuf, note) {
    if (!rawOn) return;
    const name = `${Date.now()}-${meta.host}${safePath(meta.path)}`.replace(/[^\w.-]+/g, "_").slice(0, 150);
    const head = `${meta.method} ${meta.host}${meta.path} ${meta.status}\ncontent-type: ${meta.resType}\ncontent-encoding: ${meta.resEncoding}\nrecord: ${note}\n`;
    for (const [ext, data] of [[".txt", head], [".req", reqBuf], [".res", resBuf]]) {
      fs.promises.writeFile(path.join(rawDir, name + ext), data).catch(() => {});
    }
  }
  const insecure = process.env.SILT_INSECURE_UPSTREAM === "1";
  const stats = {
    startedAt: new Date().toISOString(),
    otherConnections: 0,
    otherBytes: 0,
    aiCaptures: 0,
    skipped: 0,
  };
  const savedIds = new Set();
  const seenRefs = new Set();
  for (const row of compactTape(captureFile)) {
    savedIds.add(row.id);
    if (row.kind === "reference") seenRefs.add(String(row.email || row.accountId || `${row.name}|${row.host}`).toLowerCase());
  }
  stats.aiCaptures = savedIds.size;

  let writeChain = Promise.resolve();
  function appendCapture(record) {
    const line = JSON.stringify(record) + "\n";
    writeChain = writeChain
      .then(() => fs.promises.appendFile(captureFile, line))
      .then(() => {
        savedIds.add(record.id);
        stats.aiCaptures = savedIds.size;
      })
      .catch((err) => {
        console.error("silt write failed", err.message);
      });
  }

  const destBySocket = new WeakMap();

  const consider = makeRecorder({
    write: appendCapture,
    dump: dumpRaw,
    seenRefs,
    onSkip: () => {
      stats.skipped += 1;
    },
  });

  function forward({ protocol, hostname, port, method, path: reqPath, headers, body, res }) {
    return new Promise((resolve) => {
      const started = Date.now();
      const lib = protocol === "http:" ? http : https;
      const reqHeaders = stripHop(headers);
      reqHeaders.host = port && port !== 80 && port !== 443 ? `${hostname}:${port}` : hostname;
      const upstream = lib.request(
        {
          protocol,
          hostname,
          port,
          method,
          path: reqPath,
          headers: reqHeaders,
          servername: hostname,
          rejectUnauthorized: !insecure,
          timeout: 300000,
          maxHeaderSize: MAX_HEADER,
        },
        (up) => {
          const chunks = [];
          let size = 0;
          const outHeaders = stripHop(up.headers);
          res.writeHead(up.statusCode || 502, outHeaders);
          up.on("data", (c) => {
            size += c.length;
            if (size <= 2_000_000) chunks.push(c);
            res.write(c);
          });
          up.on("end", () => {
            res.end();
            resolve({
              status: up.statusCode || 0,
              headers: up.headers,
              body: Buffer.concat(chunks),
              latencyMs: Date.now() - started,
            });
          });
        },
      );
      upstream.on("error", (err) => {
        const message = Buffer.from("Silt could not reach " + hostname + ": " + err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(message);
        } else {
          res.end();
        }
        resolve({
          status: 502,
          headers: { "content-type": "text/plain" },
          body: message,
          latencyMs: Date.now() - started,
          error: true,
        });
      });
      upstream.end(body || Buffer.alloc(0));
    });
  }

  async function handleAgentRequest(req, res, dest) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8_000_000) {
        res.writeHead(413);
        res.end("Silt refused an oversized body");
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const protocol = dest.protocol || "https:";
    const result = await forward({
      protocol,
      hostname: dest.hostname,
      port: dest.port,
      method: req.method || "GET",
      path: dest.path || req.url || "/",
      headers: req.headers,
      body,
      res,
    });

    const pathname = safePath(dest.path || req.url || "/");
    const host = dest.hostname;
    if (hostIsAgent(host, rules) || isAiPath(pathname)) {
      consider({
        host,
        method: req.method,
        path: pathname,
        status: result.status,
        reqBuf: body,
        reqEncoding: encodingHeader(req.headers["content-encoding"]),
        resBuf: result.body,
        resType: result.headers["content-type"],
        resEncoding: encodingHeader(result.headers["content-encoding"]),
        latencyMs: result.latencyMs,
      });
    }
  }

  const mitmHttp = http.createServer({ maxHeaderSize: MAX_HEADER }, (req, res) => {
    const dest = destBySocket.get(req.socket) || {
      hostname: (req.headers.host || "").split(":")[0],
      port: 443,
      protocol: "https:",
      path: req.url,
    };
    handleAgentRequest(req, res, { ...dest, path: req.url }).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(err.message);
    });
  });

  mitmHttp.on("upgrade", (req, socket, head) => {
    const dest = destBySocket.get(socket) || {
      hostname: (req.headers.host || "").split(":")[0],
      port: 443,
      protocol: "https:",
    };
    tunnelWebSocket(req, socket, head, dest);
  });

  function tunnelWebSocket(req, clientSocket, head, dest) {
    const started = Date.now();
    const upstream = tls.connect({
      host: dest.hostname,
      port: dest.port || 443,
      servername: net.isIP(dest.hostname) ? undefined : dest.hostname,
      ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: !insecure,
    });
    // Client messages still waiting for their answer, oldest first. Responses API clients
    // (Codex) pipeline: a warm-up and the real request can both be sent before either answer.
    const queue = [];
    let resText = "";
    let timer = null;
    let opened = false;
    let accepted = false;
    let headerBuf = Buffer.alloc(0);
    const early = [];
    const flush = (finished = false) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const request = finished ? queue.shift() || "" : queue.splice(0).join("\n");
      const response = resText;
      resText = "";
      if (!request.trim() && !response.trim()) return;
      consider({
        host: dest.hostname,
        method: "WS",
        path: safePath(req.url || "/"),
        status: 101,
        reqBuf: Buffer.from(request),
        resBuf: Buffer.from(response),
        resType: "application/x-ndjson",
        latencyMs: Date.now() - started,
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 30_000);
    };
    const clientTap = makeWsTap((text) => {
      // Other protocols: a new message after a reply closes the previous exchange.
      if (!/"type"\s*:\s*"response\.create"/.test(text) && resText.trim()) flush();
      queue.push(text);
      schedule();
    });
    const serverTap = makeWsTap((text) => {
      resText += (resText ? "\n" : "") + text;
      // One end-of-response event answers the oldest request; models can go quiet for seconds mid-reply.
      if (/"type"\s*:\s*"response\.(completed|done|failed|incomplete)"/.test(text)) flush(true);
      else schedule();
    });
    const fail = () => {
      flush();
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on("secureConnect", () => {
      opened = true;
      const lines = [`${req.method || "GET"} ${req.url || "/"} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers || {})) {
        if (key.toLowerCase() === "sec-websocket-extensions") continue;
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (item != null) lines.push(`${key}: ${item}`);
        }
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) {
        upstream.write(head);
        clientTap(head);
      }
      for (const chunk of early) upstream.write(chunk);
      early.length = 0;
    });
    upstream.on("data", (chunk) => {
      if (!accepted) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const split = headerBuf.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = headerBuf.subarray(0, split).toString("utf8");
        const rest = headerBuf.subarray(split + 4);
        clientSocket.write(headerBuf.subarray(0, split + 4));
        accepted = /^HTTP\/1\.[01] 101\b/.test(header);
        headerBuf = Buffer.alloc(0);
        if (rest.length) {
          clientSocket.write(rest);
          if (accepted) serverTap(rest);
        }
        return;
      }
      clientSocket.write(chunk);
      if (accepted) serverTap(chunk);
    });
    clientSocket.on("data", (chunk) => {
      clientTap(chunk);
      if (!opened) early.push(chunk);
      else upstream.write(chunk);
    });
    upstream.on("error", fail);
    clientSocket.on("error", fail);
    upstream.on("close", () => flush());
    clientSocket.on("close", () => {
      flush();
      upstream.destroy();
    });
  }

  function mitm(clientSocket, host, port, head) {
    let creds;
    try {
      creds = leafFor(host, ca);
    } catch (err) {
      console.error("cert", err.message);
      clientSocket.destroy();
      return;
    }
    const tlsServer = tls.createServer({
      key: creds.key,
      cert: creds.cert,
      ALPNProtocols: ["http/1.1"],
    });
    tlsServer.on("secureConnection", (clear) => {
      destBySocket.set(clear, { hostname: host, port, protocol: "https:" });
      clear.on("error", () => clear.destroy());
      mitmHttp.emit("connection", clear);
    });
    tlsServer.on("tlsClientError", (err) => {
      // The app keeps its own certificate list. Let it through unread rather than break it.
      if (/UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN/.test(err?.code || err?.message || "") && !refused.has(host)) {
        refused.add(host);
        console.log(`An app refused Silt's certificate for ${host}; its traffic to that host now passes through unread.`);
      }
      try {
        clientSocket.destroy();
      } catch {
        /* gone */
      }
    });
    clientSocket.on("error", () => {
      try {
        tlsServer.close();
      } catch {
        /* gone */
      }
    });
    clientSocket.on("close", () => {
      try {
        tlsServer.close();
      } catch {
        /* gone */
      }
    });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) clientSocket.unshift(head);
    tlsServer.emit("connection", clientSocket);
  }

  function blindTunnel(clientSocket, host, port, head) {
    let counted = false;
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const count = () => {
      if (counted) return;
      counted = true;
      stats.otherConnections += 1;
      stats.otherBytes += (clientSocket.bytesRead || 0) + (upstream.bytesRead || 0);
    };
    upstream.on("error", () => {
      count();
      clientSocket.destroy();
    });
    clientSocket.on("error", () => {
      count();
      upstream.destroy();
    });
    clientSocket.on("close", count);
  }

  const proxy = http.createServer({ maxHeaderSize: MAX_HEADER }, (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end("Silt expected a proxy-form URL");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const fake = {
        method: req.method,
        url: url.pathname + url.search,
        headers: req.headers,
        async *[Symbol.asyncIterator]() {
          if (body.length) yield body;
        },
      };
      handleAgentRequest(fake, res, {
        protocol: url.protocol,
        hostname: url.hostname,
        port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
      }).catch((err) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(err.message);
      });
    });
  });

  proxy.on("connect", (req, clientSocket, head) => {
    const target = req.url || "";
    const splitAt = target.lastIndexOf(":");
    const host = splitAt === -1 ? target : target.slice(0, splitAt);
    const port = Number(splitAt === -1 ? 443 : target.slice(splitAt + 1)) || 443;
    clientSocket.on("error", () => clientSocket.destroy());
    if (hostIsAgent(host, rules) && !refused.has(host)) mitm(clientSocket, host, port, head);
    else {
      if (rawOn && !seenTunnels.has(host)) {
        seenTunnels.add(host);
        fs.appendFile(path.join(rawDir, "tunnels.txt"), host + "\n", () => {});
      }
      blindTunnel(clientSocket, host, port, head);
    }
  });

  proxy.on("clientError", (_err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* gone */
    }
  });

  const ui = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, proxyPort, uiPort }));
      return;
    }
    if (url.pathname === "/api/stats") {
      checkDirect();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...stats,
          refused: [...refused],
          direct,
          proxyPort,
          uiPort,
          dataDir,
        }),
      );
      return;
    }
    if (url.pathname === "/api/export") {
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "content-disposition": "attachment; filename=silt-captures.jsonl",
      });
      if (!fs.existsSync(captureFile)) {
        res.end("");
        return;
      }
      const stream = fs.createReadStream(captureFile);
      stream.on("error", () => {
        if (!res.writableEnded) res.end();
      });
      stream.pipe(res);
      return;
    }
    if (url.pathname === "/api/captures") {
      const rows = readCaptures(captureFile, 300, url.searchParams.get("q") || "", url.searchParams.get("all") !== "1");
      if (url.searchParams.get("download")) {
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "content-disposition": "attachment; filename=silt-captures.jsonl",
        });
        res.end(rows.map((r) => JSON.stringify(r)).join("\n"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === "/api/clear" && req.method === "POST") {
      if (req.headers["x-silt-action"] !== "clear") {
        res.writeHead(400);
        res.end("missing confirmation header");
        return;
      }
      fs.writeFileSync(captureFile, "");
      savedIds.clear();
      seenRefs.clear();
      stats.aiCaptures = 0;
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml());
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const pidFile = path.join(dataDir, "silt.pid");
  const pidMeta = {
    pid: process.pid,
    startedAtMs: Math.round(Date.now() - process.uptime() * 1000),
    execPath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
  };
  fs.writeFileSync(pidFile, JSON.stringify(pidMeta));
  const shutdown = () => {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  proxy.on("error", (err) => {
    console.error("Silt proxy failed: " + err.message);
    process.exit(1);
  });
  ui.on("error", (err) => {
    console.error("Silt desk failed: " + err.message);
    process.exit(1);
  });

  proxy.listen(proxyPort, "127.0.0.1", () => {
    console.log("Silt proxy on 127.0.0.1:" + proxyPort);
  });
  ui.listen(uiPort, "127.0.0.1", () => {
    console.log("Silt desk on http://127.0.0.1:" + uiPort);
    console.log("Captures in " + captureFile);
  });
}

if (isDirectRun()) main();
