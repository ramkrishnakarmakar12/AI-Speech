/**
 * General transcription accuracy mode.
 *   audio ──ASR (Indic / Whisper)──▶ raw transcript ──Qwen3 review──▶ corrected text + estimated accuracy
 *   + optional reference text ──▶ measured WER / CER for raw AND corrected
 *
 * Nothing medical here: no knowledge base, no prescription, no English translation pass.
 */
import { transcribe } from "../asr/index.js";
import { chatJson } from "../llm/client.js";
import { config } from "../config.js";
import { assessTranscript, type TranscriptQuality } from "../quality/accuracy.js";
import { accuracy, changeRatio, type AccuracyReport } from "./metrics.js";
import { buildGeneralUserPrompt, GENERAL_SCHEMA, GENERAL_SYSTEM_PROMPT } from "./prompt.js";

export interface GeneralIssue {
  text: string;
  type: string;
  suggestion: string;
}

export interface LlmReview {
  model: string;
  ms: number;
  language: string;
  correctedText: string;
  estimatedAccuracy: number;
  quality: string;
  issues: GeneralIssue[];
  summary: string;
  /** share of characters the LLM changed; above the limit its correction is not used */
  changeRatio: number;
  correctionUsed: boolean;
  warnings: string[];
}

export interface GeneralResult {
  name?: string;
  language: string | null;
  asr?: { backend: string; model?: string; ms: number; durationSec?: number | null };
  transcript: string;
  /** reference-free heuristic estimate (same signals as the prescription pipeline's stage 1) */
  heuristic: Pick<TranscriptQuality, "estimated" | "tier" | "issues" | "words">;
  llm?: LlmReview;
  /** present when a reference text was given */
  measured?: { raw: AccuracyReport; corrected?: AccuracyReport; llmHelped?: boolean };
  /** best available accuracy figure 0..1 and where it came from */
  accuracy: { value: number; source: "measured (raw ASR)" | "LLM estimate" | "heuristic estimate" };
}

export interface GeneralOptions {
  name?: string;
  language?: string;
  reference?: string;
  context?: string;
  useLlm?: boolean;
  /** max share of characters the LLM may change before its correction is rejected (default 0.35) */
  maxChange?: number;
}

/** Split long transcripts so the LLM's corrected_text fits in LLM_MAX_TOKENS. */
function chunkText(t: string, max = 1400): string[] {
  const sentences = t.split(/(?<=[।.?!\n])\s+/u);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + " " + s).length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  // a transcript with no punctuation at all (IndicConformer) → cut on words
  return out.flatMap((c) => {
    if (c.length <= max * 1.5) return [c];
    const w = c.split(/\s+/), parts: string[] = [];
    for (let i = 0; i < w.length; i += 180) parts.push(w.slice(i, i + 180).join(" "));
    return parts;
  });
}

export async function reviewTranscript(transcript: string, opts: GeneralOptions = {}): Promise<LlmReview> {
  const maxChange = opts.maxChange ?? Number(process.env.GENERAL_MAX_CHANGE ?? 0.35);
  const chunks = chunkText(transcript);
  const t0 = Date.now();
  let model = "";
  const corrected: string[] = [];
  const issues: GeneralIssue[] = [];
  const summaries: string[] = [];
  const warnings: string[] = [];
  let accWeighted = 0, langVotes: Record<string, number> = {};
  for (const [i, chunk] of chunks.entries()) {
    const r = await chatJson(
      [
        { role: "system", content: GENERAL_SYSTEM_PROMPT },
        { role: "user", content: buildGeneralUserPrompt({ transcript: chunk, language: opts.language, context: opts.context }) },
      ],
      GENERAL_SCHEMA,
    );
    model = r.model;
    if (r.truncated) warnings.push(`part ${i + 1}: the model's answer was cut short (${r.truncated})`);
    const j = (r.json ?? {}) as any;
    const fixed = typeof j.corrected_text === "string" && j.corrected_text.trim() ? j.corrected_text.trim() : chunk;
    corrected.push(fixed);
    const est = Number.isFinite(+j.estimated_accuracy) ? Math.max(0, Math.min(100, +j.estimated_accuracy)) : NaN;
    if (Number.isFinite(est)) accWeighted += est * chunk.length;
    else warnings.push(`part ${i + 1}: no accuracy estimate returned`);
    if (Array.isArray(j.issues)) issues.push(...j.issues.filter((x: any) => x && typeof x.text === "string").slice(0, 15));
    if (typeof j.summary === "string" && j.summary) summaries.push(j.summary);
    if (j.language) langVotes[j.language] = (langVotes[j.language] ?? 0) + chunk.length;
  }
  const correctedText = corrected.join(" ");
  const ratio = changeRatio(transcript, correctedText);
  const correctionUsed = ratio <= maxChange;
  if (!correctionUsed)
    warnings.push(`the LLM changed ${(ratio * 100).toFixed(0)}% of the characters (limit ${(maxChange * 100).toFixed(0)}%) — treated as a rewrite, correction ignored`);
  const estimatedAccuracy = Math.round(accWeighted / Math.max(1, transcript.length));
  const quality = estimatedAccuracy >= 85 ? "high" : estimatedAccuracy >= 60 ? "medium" : estimatedAccuracy >= 30 ? "low" : "unusable";
  return {
    model,
    ms: Date.now() - t0,
    language: Object.entries(langVotes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
    correctedText,
    estimatedAccuracy,
    quality,
    issues: issues.slice(0, 25),
    summary: summaries.join(" "),
    changeRatio: ratio,
    correctionUsed,
    warnings,
  };
}

/** Score an existing transcript (no audio). */
export async function evaluateTranscript(transcript: string, opts: GeneralOptions = {}, asr?: GeneralResult["asr"]): Promise<GeneralResult> {
  const language = opts.language && opts.language !== "auto" ? opts.language : null;
  const q = assessTranscript(transcript, { language, asr: asr?.durationSec ? { durationSec: asr.durationSec } : undefined });
  const res: GeneralResult = {
    name: opts.name,
    language,
    asr,
    transcript,
    // the keyword-density check is tuned for eye-clinic consultations — meaningless for general audio
    heuristic: { estimated: q.estimated, tier: q.tier, issues: q.issues.filter((i) => !/consultation|eye side|drops/i.test(i)), words: q.words },
    accuracy: { value: q.estimated, source: "heuristic estimate" },
  };
  if (opts.useLlm !== false && transcript.trim()) {
    res.llm = await reviewTranscript(transcript, opts);
    res.accuracy = { value: res.llm.estimatedAccuracy / 100, source: "LLM estimate" };
  }
  if (opts.reference?.trim()) {
    const raw = accuracy(transcript, opts.reference);
    const corrected = res.llm?.correctionUsed ? accuracy(res.llm.correctedText, opts.reference) : undefined;
    res.measured = { raw, corrected, llmHelped: corrected ? corrected.wer < raw.wer : undefined };
    // Bengali/Hindi: characters are the fairer measure (spelling variants split words); English: words
    const value = language === "en" ? raw.wordAccuracy : raw.charAccuracy;
    res.accuracy = { value, source: "measured (raw ASR)" };
  }
  return res;
}

/** Audio → transcript → review → (optional) measured accuracy. */
export async function evaluateAudio(audioPath: string, opts: GeneralOptions = {}): Promise<GeneralResult> {
  const t = await transcribe(audioPath, { language: opts.language, translate: false });
  const language = opts.language && opts.language !== "auto" ? opts.language : t.language ?? undefined;
  return evaluateTranscript(t.text, { ...opts, language }, { backend: t.backend, model: t.model, ms: t.ms, durationSec: t.durationSec });
}

export const describeSetup = () => `ASR ${config.asr.backend} · LLM ${config.llm.provider}/${config.llm.model}`;
