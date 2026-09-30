/**
 * Minimal LLM client for local servers:
 *  - Ollama native API (/api/chat, `format` = JSON schema)
 *  - LM Studio / any OpenAI-compatible server (/v1/chat/completions, response_format json_schema)
 */
import { config, llmBaseUrl } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  json: unknown;
  ms: number;
  model: string;
  usage?: { prompt?: number; completion?: number };
  /** set when generation was cut short (loop / token cap) and the JSON was salvaged */
  truncated?: string;
}

function explainFetchError(e: any, url: string): Error {
  const code = e?.cause?.code ?? e?.code ?? "";
  if (e?.name === "AbortError") return new Error(`LLM request timed out after ${config.llm.timeoutMs / 1000}s (raise LLM_TIMEOUT_MS in .env)`);
  if (code === "ECONNREFUSED")
    return new Error(
      config.llm.provider === "ollama"
        ? `Cannot connect to Ollama at ${url}. Open the Ollama app (or run \`ollama serve\`).`
        : `Cannot connect to LM Studio at ${url}. In LM Studio open the Developer tab and switch "Status: Running" on (or run \`lms server start\`).`,
    );
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET")
    return new Error(`${config.llm.provider} closed the connection (${code}). It may have crashed or run out of memory — check \`ollama ps\` / the Ollama logs, or lower LLM_NUM_CTX.`);
  if (String(code).startsWith("UND_ERR")) return new Error(`Request to ${url} failed: ${code} ${e?.cause?.message ?? ""}`);
  return new Error(`Request to ${url} failed: ${e?.message}${e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? e.cause})` : ""}`);
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`), { status: res.status, body: text });
    return JSON.parse(text);
  } catch (e: any) {
    if (e?.status) throw e;
    throw explainFetchError(e, url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming POST: bytes start flowing immediately, so Node's built-in fetch never hits its
 * 5-minute "headers" timeout while a slow first run (model load + long JSON) is generating.
 * Calls onLine for every non-empty line (NDJSON for Ollama, "data: …" SSE for OpenAI-style servers).
 */
async function postStream(url: string, body: unknown, onLine: (line: string) => void, headers: Record<string, string> = {}): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw Object.assign(new Error(`${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`), { status: res.status, body: text });
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf.trim());
  } catch (e: any) {
    if (e?.status || e instanceof StopGeneration) throw e;
    throw explainFetchError(e, url);
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // closes the stream → LM Studio / Ollama stop generating immediately
  }
}

/** Thrown from inside the stream handler to stop a runaway generation. */
class StopGeneration extends Error {}

/**
 * Watches the streamed output: shows progress, and stops the model when it
 * (a) exceeds LLM_MAX_TOKENS, (b) starts repeating itself (small models loop on list items),
 * or (c) spends too long "thinking" (reasoning models that ignore /no_think).
 */
class StreamGuard {
  content = "";
  reasoningChars = 0;
  chunks = 0;
  constructor(private t0: number) {}
  add(content: string, reasoning = "") {
    this.content += content;
    this.reasoningChars += reasoning.length;
    this.chunks++;
    if (this.chunks % 25 === 0) this.show();
    const approxTokens = Math.round((this.content.length + this.reasoningChars) / 3.5);
    if (approxTokens > config.llm.maxTokens)
      throw new StopGeneration(`stopped after ~${approxTokens} tokens (LLM_MAX_TOKENS=${config.llm.maxTokens})`);
    if (this.reasoningChars > 6000 && this.content.length < 50)
      throw new StopGeneration(`the model spent too long "thinking" — use a non-thinking/instruct model (e.g. Qwen3-4B-Instruct-2507)`);
    if (this.chunks % 40 === 0 && isLooping(this.content)) throw new StopGeneration(`the model started repeating itself`);
  }
  show(done = false) {
    if (!process.stderr.isTTY) return;
    const think = this.reasoningChars ? `, thinking ~${Math.round(this.reasoningChars / 3.5)}` : "";
    process.stderr.write(
      `\r  … LLM generating: ~${Math.round(this.content.length / 3.5)} tokens${think}, ${((Date.now() - this.t0) / 1000).toFixed(0)} s   ${done ? "\n" : ""}`,
    );
  }
}

/** True when the tail of the output is the same chunk repeated (e.g. the same terms[] item over and over). */
export function isLooping(text: string): boolean {
  if (text.length < 1500) return false;
  const tail = text.slice(-1200);
  for (const size of [40, 80, 160]) {
    const probe = tail.slice(-size);
    let count = 0;
    let idx = tail.indexOf(probe);
    while (idx >= 0) {
      count++;
      idx = tail.indexOf(probe, idx + 1);
    }
    if (count >= Math.max(3, Math.floor(600 / size))) return true;
  }
  return false;
}

/**
 * Salvage a JSON object that was cut off mid-way: keep everything up to the last complete
 * value and close the open brackets. Items after the cut are lost, earlier ones are kept.
 */
export function repairJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  t = t.slice(start);
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1;
  let lastStack: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      lastSafe = i + 1;
      lastStack = [...stack];
      if (!stack.length) return JSON.parse(t.slice(0, i + 1));
    } else if (c === ",") {
      lastSafe = i;
      lastStack = [...stack];
    }
  }
  if (lastSafe < 0) throw new Error("model output too short to salvage");
  const body = t.slice(0, lastSafe).replace(/,\s*$/, "");
  return JSON.parse(body + lastStack.reverse().join(""));
}

/** Parse normally; if the output was cut off, salvage what is complete. */
function finish(text: string, stopped: string | undefined): { json: unknown; truncated?: string } {
  if (!stopped) {
    try {
      return { json: parseJsonLoose(text) };
    } catch {
      stopped = "output was not valid JSON";
    }
  }
  try {
    return { json: repairJson(text), truncated: stopped };
  } catch {
    throw new Error(`LLM ${stopped}, and nothing usable could be recovered. Try a different model (Qwen3-4B-Instruct-2507 is reliable) or a shorter transcript.`);
  }
}

/** Strip <think> blocks / code fences and parse the first JSON object in the text. */
export function parseJsonLoose(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error(`Model did not return JSON. First 300 chars: ${t.slice(0, 300)}`);
  }
}

async function ollamaChat(messages: ChatMessage[], schema: object): Promise<ChatResult> {
  const t0 = Date.now();
  const body: any = {
    model: config.llm.model,
    messages,
    stream: true,
    format: schema,
    keep_alive: "15m",
    options: { temperature: config.llm.temperature, num_ctx: config.llm.numCtx, num_predict: config.llm.maxTokens, repeat_penalty: 1.1 },
  };
  if (config.llm.think === "false") body.think = false;
  if (config.llm.think === "true") body.think = true;
  const url = `${llmBaseUrl()}/api/chat`;
  let guard = new StreamGuard(t0);
  let final: any = {};
  let stopped: string | undefined;
  const run = async () => {
    guard = new StreamGuard(t0);
    stopped = undefined;
    try {
      await postStream(url, body, (line) => {
        const d = JSON.parse(line);
        if (d.error) throw Object.assign(new Error(`Ollama: ${d.error}`), { body: d.error });
        if (d.done) final = d;
        guard.add(d.message?.content ?? "", d.message?.thinking ?? "");
      });
    } catch (e) {
      if (!(e instanceof StopGeneration)) throw e;
      stopped = e.message;
    }
    if (final.done_reason === "length") stopped ??= `hit the ${config.llm.maxTokens}-token cap (LLM_MAX_TOKENS)`;
    guard.show(true);
    if (stopped) console.warn(`  ⚠ LLM ${stopped} — salvaging the complete part of the answer`);
  };
  try {
    try {
      await run();
    } catch (e: any) {
      // non-reasoning models reject the `think` flag → retry without it
      if ("think" in body && /think/i.test(String(e?.body ?? e?.message))) {
        delete body.think;
        await run();
      } else throw e;
    }
  } catch (e: any) {
    if (e?.status === 404 || /model .*not found/i.test(String(e?.body ?? e?.message)))
      throw new Error(`Model "${config.llm.model}" is not available in Ollama. Run: ollama pull ${config.llm.model}   (or set LLM_MODEL in .env to one listed by \`ollama list\`)`);
    throw e;
  }
  const text = guard.content;
  const { json, truncated } = finish(text, stopped);
  return { text, json, truncated, ms: Date.now() - t0, model: final.model ?? config.llm.model, usage: { prompt: final.prompt_eval_count, completion: final.eval_count } };
}

interface LmModel {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

/** LM Studio's REST API (/api/v0/models) says which models are loaded and with what context. */
async function lmStudioModels(): Promise<LmModel[]> {
  const root = llmBaseUrl().replace(/\/v1\/?$/, "");
  try {
    const r = await fetch(`${root}/api/v0/models`);
    if (r.ok) return ((await r.json()) as any).data ?? [];
  } catch {
    /* not LM Studio, or older version */
  }
  const r = await fetch(`${llmBaseUrl()}/models`, { headers: { authorization: `Bearer ${config.llm.apiKey}` } }).catch((e) => {
    throw explainFetchError(e, `${llmBaseUrl()}/models`);
  });
  return (((await r.json()) as any).data ?? []).map((m: any) => ({ id: m.id }));
}

let lastLogged: string | null = null;
/**
 * LLM_MODEL=<id> → always that model.
 * LLM_MODEL=auto (or empty) → asked fresh on every request (no caching, so switching models in
 * LM Studio takes effect without restarting the server):
 *   1. a loaded text model (type "llm") — preferred over vision models ("vlm", e.g. qwen3-vl-4b)
 *   2. any loaded model
 *   3. the first downloaded text model (LM Studio loads it on first request)
 */
export async function resolveModel(): Promise<string> {
  const want = config.llm.model.trim();
  if (config.llm.provider === "ollama" || config.llm.provider === "bedrock") return want;
  if (want && want !== "auto") return want;
  const models = (await lmStudioModels()).filter((m) => !/embed/i.test(m.id) && m.type !== "embeddings");
  const loaded = models.filter((m) => m.state === "loaded");
  const isText = (m: LmModel) => m.type === "llm" || (!m.type && !/[-_]vl[-_]/i.test(m.id));
  const pick = loaded.find(isText) ?? loaded[0] ?? models.find(isText) ?? models[0];
  if (!pick) throw new Error(`No models found in LM Studio. Download one (e.g. Qwen3-4B-Instruct-2507) and load it, then retry.`);
  if (pick.id !== lastLogged) {
    lastLogged = pick.id;
    if (loaded.length > 1)
      console.warn(`⚠ ${loaded.length} models are loaded in LM Studio (${loaded.map((m) => m.id).join(", ")}); unload the ones you don't use to free memory.`);
    if (pick.state === "loaded" && pick.loaded_context_length && pick.loaded_context_length < Math.min(config.llm.numCtx, 8192))
      console.warn(
        `⚠ "${pick.id}" is loaded with a ${pick.loaded_context_length}-token context; this app needs ${config.llm.numCtx} (LLM_NUM_CTX). ` +
          `Reload it with that Context Length (LM Studio → model settings, or: lms load ${pick.id} --context-length ${config.llm.numCtx}).`,
      );
    console.error(`  using LM Studio model: ${pick.id}${pick.state ? ` (${pick.state})` : ""}`);
  }
  return pick.id;
}

async function openaiChat(messages: ChatMessage[], schema: object): Promise<ChatResult> {
  const t0 = Date.now();
  const model = await resolveModel();
  const msgs = messages.map((m) => ({ ...m }));
  // Qwen3-family soft switch to skip the reasoning phase (LM Studio has no API flag for it)
  if (config.llm.think === "false" && /qwen3/i.test(model)) {
    const last = msgs[msgs.length - 1];
    last.content += "\n/no_think";
  }
  const body: any = {
    model,
    messages: msgs,
    temperature: config.llm.temperature,
    max_tokens: config.llm.maxTokens,
    frequency_penalty: 0.2,
    stream: true,
    response_format: { type: "json_schema", json_schema: { name: "prescription", strict: true, schema } },
  };
  const headers = { authorization: `Bearer ${config.llm.apiKey}` };
  const url = `${llmBaseUrl()}/chat/completions`;
  let guard = new StreamGuard(t0);
  const data: any = {};
  let stopped: string | undefined;
  const run = async () => {
    guard = new StreamGuard(t0);
    stopped = undefined;
    try {
      await postStream(
        url,
        body,
        (line) => {
          if (!line.startsWith("data:")) return;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          const d = JSON.parse(payload);
          if (d.model) data.model = d.model;
          if (d.usage) data.usage = d.usage;
          const ch = d.choices?.[0];
          if (ch?.finish_reason === "length") data.lengthCut = true;
          guard.add(ch?.delta?.content ?? ch?.message?.content ?? "", ch?.delta?.reasoning_content ?? ch?.delta?.reasoning ?? "");
        },
        headers,
      );
    } catch (e) {
      if (!(e instanceof StopGeneration)) throw e;
      stopped = e.message;
    }
    if (data.lengthCut) stopped ??= `hit the ${config.llm.maxTokens}-token cap (LLM_MAX_TOKENS)`;
    guard.show(true);
    if (stopped) console.warn(`  ⚠ LLM ${stopped} — salvaging the complete part of the answer`);
  };
  try {
    await run();
  } catch (e: any) {
    if (/context|n_ctx|too long|exceeds/i.test(String(e?.body ?? e?.message)))
      throw new Error(
        `The prompt is larger than the model's context window in LM Studio. Reload "${model}" with Context Length ${config.llm.numCtx} ` +
          `(LM Studio → My Models → gear icon, or: lms load ${model} --context-length ${config.llm.numCtx}), or lower MAX_CANDIDATES in .env. Details: ${String(e?.body ?? e?.message).slice(0, 300)}`,
      );
    if (e?.status === 404 || /model.*not (found|exist)/i.test(String(e?.body)))
      throw new Error(`LM Studio has no model "${model}". Set LLM_MODEL=auto in .env, or copy an id from: curl ${llmBaseUrl()}/models`);
    if (e?.status === 400 && /response_format|json_schema|schema/i.test(String(e?.body))) {
      body.response_format = { type: "json_object" };
      try {
        await run();
      } catch {
        delete body.response_format;
        await run();
      }
    } else throw e;
  }
  const text = guard.content;
  const { json, truncated } = finish(text, stopped);
  return { text, json, truncated, ms: Date.now() - t0, model: data?.model ?? model, usage: { prompt: data?.usage?.prompt_tokens, completion: data?.usage?.completion_tokens } };
}

// ---------------- Amazon Bedrock (production) ----------------
const BEDROCK_PKG = "@aws-sdk/client-bedrock-runtime";
let bedrockClient: any = null;
async function bedrockSdk(): Promise<any> {
  try {
    return await import(BEDROCK_PKG as string);
  } catch {
    throw new Error(`LLM_PROVIDER=bedrock needs the AWS SDK. Run:  npm install ${BEDROCK_PKG}`);
  }
}

/** Pull the model text out of an InvokeModel response, whatever shape the imported model returns. */
function invokeText(d: any): string {
  return (
    d?.choices?.[0]?.message?.content ??
    d?.choices?.[0]?.text ??
    d?.generation ??
    d?.outputs?.[0]?.text ??
    d?.completion ??
    d?.output?.message?.content?.[0]?.text ??
    ""
  );
}

/**
 * LLM_PROVIDER=bedrock. Credentials come from the normal AWS chain (instance/task role, AWS_PROFILE,
 * or AWS_ACCESS_KEY_ID/SECRET). LLM_MODEL = the Bedrock model id / inference profile, or the imported model ARN.
 *   BEDROCK_API=converse (default) — models Bedrock serves itself. The prescription schema is sent as a
 *     forced tool, so the answer comes back as schema-shaped JSON; falls back to a plain JSON prompt
 *     when the model does not support tool use.
 *   BEDROCK_API=invoke — Custom Model Import (e.g. Qwen3-4B-Instruct-2507); OpenAI-style messages body.
 */
async function bedrockChat(messages: ChatMessage[], schema: object): Promise<ChatResult> {
  const t0 = Date.now();
  const sdk = await bedrockSdk();
  bedrockClient ??= new sdk.BedrockRuntimeClient({ region: config.llm.bedrock.region });
  const modelId = config.llm.model;
  const explain = (e: any) =>
    new Error(
      e?.name === "AccessDeniedException"
        ? `Bedrock denied access to ${modelId}: enable the model in the Bedrock console (Model access) and allow bedrock:InvokeModel for this role. (${e.message})`
        : e?.name === "ResourceNotFoundException" || e?.name === "ValidationException"
          ? `Bedrock rejected model "${modelId}" in ${config.llm.bedrock.region}: ${e.message}`
          : `Bedrock call failed: ${e?.message ?? e}`,
    );

  if (config.llm.bedrock.api === "invoke") {
    const body = { messages, max_tokens: config.llm.maxTokens, temperature: config.llm.temperature };
    const out = await bedrockClient
      .send(new sdk.InvokeModelCommand({ modelId, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) }))
      .catch((e: any) => {
        throw explain(e);
      });
    const d = JSON.parse(new TextDecoder().decode(out.body));
    const text = String(invokeText(d));
    const { json, truncated } = finish(text, isLooping(text) ? "the model started repeating itself" : undefined);
    return { text, json, truncated, ms: Date.now() - t0, model: modelId, usage: { prompt: d?.usage?.prompt_tokens, completion: d?.usage?.completion_tokens } };
  }

  const system = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
  const msgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: [{ text: m.content }] }));
  const base = { modelId, system, messages: msgs, inferenceConfig: { maxTokens: config.llm.maxTokens, temperature: config.llm.temperature } };
  let out: any;
  let viaTool = true;
  try {
    out = await bedrockClient.send(
      new sdk.ConverseCommand({
        ...base,
        toolConfig: {
          tools: [{ toolSpec: { name: "prescription", description: "Return the structured result.", inputSchema: { json: schema } } }],
          toolChoice: { tool: { name: "prescription" } },
        },
      }),
    );
  } catch (e: any) {
    if (e?.name !== "ValidationException") throw explain(e);
    viaTool = false; // model without (forced) tool use → plain JSON prompt
    const last = msgs[msgs.length - 1];
    last.content = [{ text: `${last.content[0].text}\n\nReturn ONLY a JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}` }];
    out = await bedrockClient.send(new sdk.ConverseCommand(base)).catch((e2: any) => {
      throw explain(e2);
    });
  }
  const content: any[] = out?.output?.message?.content ?? [];
  const tool = viaTool ? content.find((c) => c.toolUse)?.toolUse?.input : undefined;
  const text = tool ? JSON.stringify(tool) : content.map((c) => c.text ?? "").join("");
  const stopped = out?.stopReason === "max_tokens" ? "the answer hit LLM_MAX_TOKENS" : isLooping(text) ? "the model started repeating itself" : undefined;
  const { json, truncated } = tool && !stopped ? { json: tool, truncated: undefined } : finish(text, stopped);
  return { text, json, truncated, ms: Date.now() - t0, model: modelId, usage: { prompt: out?.usage?.inputTokens, completion: out?.usage?.outputTokens } };
}

export function chatJson(messages: ChatMessage[], schema: object): Promise<ChatResult> {
  if (config.llm.provider === "bedrock") return bedrockChat(messages, schema);
  return config.llm.provider === "ollama" ? ollamaChat(messages, schema) : openaiChat(messages, schema);
}

/** List models on the configured server (for `npm run check`). */
export async function listModels(): Promise<string[]> {
  const base = llmBaseUrl();
  if (config.llm.provider === "bedrock") return [`${config.llm.model} (Bedrock, ${config.llm.bedrock.region}, ${config.llm.bedrock.api})`];
  if (config.llm.provider === "ollama") {
    const r = await fetch(`${base}/api/tags`);
    const d: any = await r.json();
    return (d.models ?? []).map((m: any) => m.name);
  }
  return (await lmStudioModels()).map((m) => (m.state ? `${m.id} [${m.type ?? "?"}, ${m.state}${m.loaded_context_length ? `, ctx ${m.loaded_context_length}` : ""}]` : m.id));
}
