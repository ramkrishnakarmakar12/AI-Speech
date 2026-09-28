import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env if present (Node >= 20.12 has process.loadEnvFile)
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  try {
    (process as any).loadEnvFile?.(envFile);
  } catch {
    /* ignore */
  }
}

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
/** Relative paths in .env are relative to the project folder, not wherever the command was started */
const envPath = (k: string, d: string) => {
  const v = env(k, d);
  return v && !path.isAbsolute(v) && !v.startsWith("~") ? path.join(ROOT, v) : v.replace(/^~(?=\/)/, process.env.HOME ?? "~");
};
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== "" && process.env[k] !== undefined ? v : d;
};

export type AsrBackend = "indic" | "qwen3-mlx" | "whisper-cli" | "whisper-server" | "openai" | "none";
export type LlmProvider = "ollama" | "lmstudio" | "openai";

export const config = {
  paths: {
    xlsx: path.resolve(ROOT, env("KB_XLSX", "data/Ophthalmology_Vocabulary_Report.xlsx")),
    kb: path.join(ROOT, "data/kb.json"),
    hotwords: path.join(ROOT, "data/hotwords.txt"),
    outDir: path.join(ROOT, "output"),
  },
  asr: {
    backend: env("ASR_BACKEND", "whisper-cli") as AsrBackend,
    /** "" / auto = detect per recording; or en / hi / bn */
    language: env("ASR_LANGUAGE", ""),
    /** auto = also produce an English translation when the audio is Hindi/Bengali (Whisper only); off = never */
    translate: env("ASR_TRANSLATE", "auto") as "auto" | "off",
    // qwen3-mlx (python helper)
    python: env("PYTHON", "python3"),
    qwen3Model: env("QWEN3_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B"),
    qwen3ContextChars: num("QWEN3_CONTEXT_CHARS", 2500),
    // whisper.cpp CLI
    whisperCli: env("WHISPER_CLI", "whisper-cli"),
    whisperModel: envPath("WHISPER_MODEL", "models/ggml-large-v3.bin"),
    // whisper.cpp server
    whisperServerUrl: env("WHISPER_SERVER_URL", "http://127.0.0.1:8080"),
    // OpenAI-compatible /v1/audio/transcriptions (mlx-audio server, speaches, LocalAI …)
    openaiBaseUrl: env("ASR_OPENAI_BASE_URL", "http://127.0.0.1:8000/v1"),
    openaiModel: env("ASR_OPENAI_MODEL", "whisper-large-v3"),
    openaiApiKey: env("ASR_OPENAI_API_KEY", "local"),
    /** Whisper prompts are capped at ~224 tokens; keep it short */
    whisperPromptChars: num("WHISPER_PROMPT_CHARS", 500),
    /** also send the English vocabulary prompt on native Hindi/Bengali passes (may push output toward English) */
    whisperPromptNative: env("WHISPER_PROMPT_NATIVE", "false") === "true",
    whisperThreads: num("WHISPER_THREADS", 0),
    // ASR_BACKEND=indic: which Hugging Face model transcribes each language (English stays on whisper.cpp)
    indicModels: {
      hi: env("INDIC_MODEL_HI", "ARTPARK-IISc/whisper-large-v3-vaani-hindi"),
      bn: env("INDIC_MODEL_BN", "ARTPARK-IISc/whisper-medium-vaani-bengali"),
    } as Record<string, string>,
    /** IndicConformer decoding: rnnt (more accurate) or ctc (faster) */
    indicDecoding: env("INDIC_DECODING", "rnnt"),
    ffmpeg: env("FFMPEG", "ffmpeg"),
  },
  llm: {
    provider: env("LLM_PROVIDER", "ollama") as LlmProvider,
    baseUrl: env("LLM_BASE_URL", ""), // defaults per provider below
    model: env("LLM_MODEL", "qwen3:8b"),
    apiKey: env("LLM_API_KEY", "local"),
    temperature: num("LLM_TEMPERATURE", 0),
    numCtx: num("LLM_NUM_CTX", 12288),
    /** "false" disables thinking for reasoning models (faster, cleaner JSON). "" = model default */
    think: env("LLM_THINK", "false"),
    timeoutMs: num("LLM_TIMEOUT_MS", 600_000),
    /** Hard cap on generated tokens; a full prescription is ~800–1500. Stops runaway/looping models. */
    maxTokens: num("LLM_MAX_TOKENS", 3000),
    /** How many KB candidates (full detail) to give the LLM */
    maxCandidates: num("MAX_CANDIDATES", 60),
    /** Number of similar "Conversation Scenarios" rows shown to the LLM as a style example (0 = off) */
    scenarioExamples: num("SCENARIO_EXAMPLES", 1),
    /** Also give the LLM a compact name index of these categories so it can pick terms the matcher missed */
    indexCategories: env("LLM_INDEX_CATEGORIES", "medicine,disease,procedure,test")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  server: {
    port: num("PORT", 5055),
  },
};

export function llmBaseUrl(): string {
  if (config.llm.baseUrl) return config.llm.baseUrl.replace(/\/$/, "");
  switch (config.llm.provider) {
    case "ollama":
      return "http://127.0.0.1:11434";
    case "lmstudio":
      return "http://127.0.0.1:1234/v1";
    default:
      return "http://127.0.0.1:8000/v1";
  }
}
