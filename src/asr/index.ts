/**
 * Speech-to-text with pluggable local backends. All of them get a domain vocabulary prompt
 * built from the knowledge base so drug / disease names are spelled correctly.
 *
 *   whisper-cli    – whisper.cpp CLI + Whisper large-v3 (brew install whisper-cpp)   [DEFAULT: English + Hindi + Bengali]
 *   whisper-server – whisper.cpp HTTP server (/inference)
 *   openai         – any OpenAI-compatible /v1/audio/transcriptions server (mlx-audio, speaches, LocalAI…)
 *   indic          – Hindi/Bengali → Indic-trained HF model (IndicConformer / Vaani Whisper), English → whisper.cpp
 *   qwen3-mlx      – Qwen3-ASR via MLX through src/asr/qwen3_asr.py                 [English + Hindi only, no Bengali]
 *
 * Multilingual flow (Whisper backends): pass 1 transcribes in the spoken language (auto-detected or forced).
 * If that language is Hindi/Bengali, pass 2 runs Whisper's built-in translate task to get an English
 * version. The LLM gets both texts; the term matcher uses the English text plus a romanised original.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT, type AsrBackend } from "../config.js";
import { buildHotwords, loadKb } from "../kb/build-kb.js";

export interface Transcript {
  /** transcript in the spoken language/script */
  text: string;
  /** machine English translation (only when the audio was not English) */
  english?: string;
  backend: AsrBackend;
  /** ISO code: en / hi / bn … */
  language?: string | null;
  /** model that produced the transcript (Indic backend) */
  model?: string;
  ms: number;
}

export interface TranscribeOptions {
  /** "" / "auto" = detect; "en" | "hi" | "bn" (or English/Hindi/Bengali) */
  language?: string;
  backend?: AsrBackend;
}

const LANG: Record<string, { name: string; code: string }> = {
  en: { name: "English", code: "en" },
  english: { name: "English", code: "en" },
  hi: { name: "Hindi", code: "hi" },
  hindi: { name: "Hindi", code: "hi" },
  bn: { name: "Bengali", code: "bn" },
  bengali: { name: "Bengali", code: "bn" },
  bangla: { name: "Bengali", code: "bn" },
};
const langName = (l: string) => LANG[l.toLowerCase()]?.name ?? l;
export const langCode = (l: string | null | undefined) => (l ? LANG[l.toLowerCase()]?.code ?? l.toLowerCase() : "");

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e: any) => reject(e.code === "ENOENT" ? new Error(`"${cmd}" not found. Install it or set its path in .env`) : e));
    p.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${(stderr || stdout).slice(-800)}`))));
  });
}

/** Convert anything ffmpeg can read to 16 kHz mono WAV (what whisper.cpp expects). */
async function toWav16k(input: string): Promise<string> {
  const out = path.join(os.tmpdir(), `asr-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await run(config.asr.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  return out;
}

function vocabulary(maxChars: number): string {
  const words = buildHotwords(loadKb(), maxChars);
  return `Ophthalmology OPD consultation between doctor and patient. Terms: ${words}.`;
}

const needsTranslation = (lang: string) => config.asr.translate !== "off" && !!lang && lang !== "en";

// ---------------- whisper.cpp CLI ----------------
async function whisperCliPass(wav: string, lang: string, translate: boolean): Promise<{ text: string; detected: string }> {
  const base = wav.replace(/\.wav$/, "") + (translate ? "-en" : "");
  const args = ["-m", config.asr.whisperModel, "-f", wav, "-l", lang || "auto", "-nt", "-otxt", "-of", base];
  if (config.asr.whisperThreads) args.push("-t", String(config.asr.whisperThreads));
  if (translate) args.push("-tr");
  // English vocabulary prompt helps drug names; for native Hindi/Bengali script it can push output
  // toward English, so it is only used for English/translate passes unless WHISPER_PROMPT_NATIVE=true.
  if (translate || lang === "en" || config.asr.whisperPromptNative) args.push("--prompt", vocabulary(config.asr.whisperPromptChars));
  try {
    const { stderr, stdout } = await run(config.asr.whisperCli, args);
    const detected = (stderr + stdout).match(/auto-detected language:\s*([a-z]{2,3})/i)?.[1] ?? lang;
    return { text: fs.readFileSync(base + ".txt", "utf8").trim(), detected };
  } finally {
    fs.rmSync(base + ".txt", { force: true });
  }
}

async function whisperCli(audio: string, language: string) {
  if (!fs.existsSync(config.asr.whisperModel))
    throw new Error(
      `Whisper model not found at ${config.asr.whisperModel}. Put ggml-large-v3.bin in the project's models/ folder ` +
        `(if you downloaded it to ~/models: mv ~/models/ggml-large-v3.bin models/), or set WHISPER_MODEL in .env to its full path.`,
    );
  const wav = await toWav16k(audio);
  try {
    const first = await whisperCliPass(wav, language, false);
    const lang = langCode(first.detected);
    const english = needsTranslation(lang) ? (await whisperCliPass(wav, lang, true)).text : undefined;
    return { text: first.text, english, language: lang };
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

// ---------------- HTTP backends ----------------
async function multipart(url: string, audio: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(audio)]), path.basename(audio));
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  const res = await fetch(url, { method: "POST", body: form, headers }).catch((e) => {
    throw new Error(`Cannot reach ASR server at ${url}: ${e?.cause?.code ?? e.message}`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${url}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function whisperServer(audio: string, language: string) {
  const url = `${config.asr.whisperServerUrl.replace(/\/$/, "")}/inference`;
  const common = { response_format: "verbose_json", temperature: "0.0" };
  const d = await multipart(url, audio, { ...common, language: language || "auto", ...(language === "en" ? { prompt: vocabulary(config.asr.whisperPromptChars) } : {}) });
  const lang = langCode(d.language ?? d.detected_language ?? language);
  let english: string | undefined;
  if (needsTranslation(lang)) {
    const t = await multipart(url, audio, { ...common, language: lang, translate: "true", prompt: vocabulary(config.asr.whisperPromptChars) });
    english = String(t.text ?? "").trim();
  }
  return { text: String(d.text ?? "").trim(), english, language: lang || null };
}

async function openaiCompat(audio: string, language: string) {
  const base = config.asr.openaiBaseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${config.asr.openaiApiKey}` };
  const d = await multipart(
    `${base}/audio/transcriptions`,
    audio,
    { model: config.asr.openaiModel, response_format: "verbose_json", language, ...(language === "en" ? { prompt: vocabulary(config.asr.whisperPromptChars) } : {}) },
    headers,
  );
  const lang = langCode(d.language ?? language);
  let english: string | undefined;
  if (needsTranslation(lang)) {
    try {
      const t = await multipart(`${base}/audio/translations`, audio, { model: config.asr.openaiModel, response_format: "json", prompt: vocabulary(config.asr.whisperPromptChars) }, headers);
      english = String(t.text ?? "").trim();
    } catch {
      /* server has no /audio/translations – the LLM will work from the original text */
    }
  }
  return { text: String(d.text ?? "").trim(), english, language: lang || null };
}

// ---------------- Indic models (Hugging Face, via Python) ----------------
const whisperAvailable = () => fs.existsSync(config.asr.whisperModel);

/** whisper.cpp language detection only (-dl): fast, no transcription. */
async function detectLanguage(wav: string): Promise<string> {
  const { stderr, stdout } = await run(config.asr.whisperCli, ["-m", config.asr.whisperModel, "-f", wav, "-dl", "-l", "auto"]);
  return langCode((stderr + stdout).match(/auto-detected language:\s*([a-z]{2,3})/i)?.[1] ?? "");
}

/**
 * Hindi / Bengali audio → an Indic-trained model (IndicConformer or Vaani Whisper fine-tunes).
 * English audio → whisper.cpp as before. The English translation for the LLM still comes from
 * Whisper's translate pass when the Whisper model is installed.
 */
async function indic(audio: string, language: string) {
  const wav = await toWav16k(audio);
  try {
    let lang = language;
    if (!lang) {
      if (!whisperAvailable())
        throw new Error("Pick the spoken language (Hindi/Bengali/English) — auto-detect needs the Whisper model in models/.");
      lang = await detectLanguage(wav);
    }
    const model = config.asr.indicModels[lang];
    if (!model) {
      // English (or a language without an Indic model configured) → plain Whisper
      if (!whisperAvailable()) throw new Error(`No Indic model configured for "${lang}" and the Whisper model is missing.`);
      const r = await whisperCliPass(wav, lang, false);
      return { text: r.text, english: undefined, language: lang };
    }
    const args = [path.join(ROOT, "src/asr/indic_asr.py"), "--audio", wav, "--lang", lang, "--model", model, "--decoding", config.asr.indicDecoding];
    const { stdout } = await run(config.asr.python, args).catch((e: Error) => {
      // the helper prints a JSON error line before exiting non-zero
      const m = e.message.match(/\{"error":.*\}/);
      throw new Error(m ? JSON.parse(m[0]).error : e.message);
    });
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (!line) throw new Error(`indic_asr.py returned no JSON: ${stdout.slice(-500)}`);
    const r = JSON.parse(line);
    if (r.error) throw new Error(r.error);
    const english = needsTranslation(lang) && whisperAvailable() ? (await whisperCliPass(wav, lang, true)).text : undefined;
    return { text: String(r.text), english, language: lang, model: r.model as string };
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

// ---------------- Qwen3-ASR (MLX) ----------------
async function qwen3(audio: string, language: string) {
  if (language === "bn") throw new Error("Qwen3-ASR does not support Bengali. Use ASR_BACKEND=whisper-cli for Bengali audio.");
  const ctxFile = path.join(os.tmpdir(), `asr-context-${Date.now()}.txt`);
  fs.writeFileSync(ctxFile, vocabulary(config.asr.qwen3ContextChars));
  try {
    const args = [path.join(ROOT, "src/asr/qwen3_asr.py"), "--audio", audio, "--model", config.asr.qwen3Model, "--context-file", ctxFile];
    if (language) args.push("--language", langName(language));
    const { stdout } = await run(config.asr.python, args);
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (!line) throw new Error(`qwen3_asr.py returned no JSON: ${stdout.slice(-500)}`);
    const r = JSON.parse(line);
    if (r.error) throw new Error(r.error);
    return { text: String(r.text), english: undefined, language: langCode(r.language) || language || null };
  } finally {
    fs.rmSync(ctxFile, { force: true });
  }
}

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
  const backend = opts.backend ?? config.asr.backend;
  const raw = opts.language ?? config.asr.language;
  const language = !raw || raw.toLowerCase() === "auto" ? "" : langCode(raw);
  const t0 = Date.now();
  let r: { text: string; english?: string; language?: string | null; model?: string };
  switch (backend) {
    case "whisper-cli":
      r = await whisperCli(audioPath, language);
      break;
    case "whisper-server":
      r = await whisperServer(audioPath, language);
      break;
    case "openai":
      r = await openaiCompat(audioPath, language);
      break;
    case "indic":
      r = await indic(audioPath, language);
      break;
    case "qwen3-mlx":
      r = await qwen3(audioPath, language);
      break;
    case "none":
      throw new Error("ASR_BACKEND=none — provide a transcript instead of audio");
    default:
      throw new Error(`Unknown ASR_BACKEND "${backend}"`);
  }
  return { ...r, backend, ms: Date.now() - t0 };
}
