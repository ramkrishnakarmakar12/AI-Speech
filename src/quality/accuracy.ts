/**
 * Stage 1 — transcription accuracy.
 *
 * With a reference script: measured WER (English) / CER (Hindi, Bengali), as in evaluation/.
 * Without one (the normal OPD case): an estimate from signals that need no ground truth:
 *   confidence   – mean ASR token probability (Whisper backends)
 *   language fit – share of everyday function words of the spoken language ("है/का/में", "আছে/না/কি", "the/is/you")
 *                  → catches audio decoded as the wrong language (Bengali heard as Hindi/Punjabi)
 *   script       – letters in the expected script (Bengali visit written in Devanagari = wrong decoder)
 *   garbled      – broken characters / stray one-letter fragments (� , "</", lone consonants)
 *   repetition   – hallucination loops ("Patient. Patient. Patient.")
 *   speech rate  – words per minute of audio (very low = sentences/turns were dropped)
 *   agreement    – native transcript vs English translation agree on eye side, numbers, durations
 *   keywords     – density of general keywords (stage 2) — a consultation always has them
 *
 * The score decides the tier, and the tier decides how the medical-term stage runs (policyFor).
 */
import { config } from "../config.js";
import { normalize } from "../match/matcher.js";
import { hasIndicScript } from "../match/translit.js";
import { detectKeywords, keywordAgreement, type KeywordReport } from "../match/keywords.js";
import { errorRates } from "./wer.js";

export type QualityTier = "high" | "medium" | "low" | "unusable";

/** What the ASR backend can tell us about its own output */
export interface AsrSignals {
  /** mean token probability 0..1 */
  confidence?: number | null;
  /** share of tokens with probability below ASR_LOW_CONF */
  lowConfidenceRatio?: number | null;
  /** per-word probabilities (whisper.cpp) */
  words?: { w: string; p: number }[];
  durationSec?: number | null;
}

export interface QualitySignal {
  name: "confidence" | "language_fit" | "script" | "garbled" | "repetition" | "speech_rate" | "translation_agreement" | "keyword_density";
  /** raw measurement (probability, ratio, words/min …) */
  value: number | null;
  /** 0..1, null = not available for this input */
  score: number | null;
  weight: number;
  note: string;
}

export interface TranscriptQuality {
  /** 0..1 — measured when a reference was given, otherwise estimated */
  score: number;
  estimated: number;
  source: "measured" | "estimated";
  tier: QualityTier;
  language: string;
  words: number;
  signals: QualitySignal[];
  measured?: { metric: "WER" | "CER"; wer: number; cer: number; refWords: number };
  /** plain-language reasons the score is not higher */
  issues: string[];
  /** normalised words the ASR itself was unsure about (used to flag medical terms heard there) */
  lowConfidenceWords: string[];
}

/** Everyday function words, native script and romanised. Share in normal speech ≈ `typical`. */
const FUNCTION_WORDS: Record<string, { native: string[]; latin: string[]; typical: number }> = {
  en: {
    native: [],
    latin: "the a an and to of is are was were you i it in on for that this have has my your me do does what with be not no yes any how can will at so".split(" "),
    typical: 0.3,
  },
  hi: {
    native: "है हैं था थी थे का की के में से को और नहीं क्या आप मैं हम हाँ हां हो तो भी पर यह ये वह वो एक कुछ जी कब कैसे कितने कितना होता होती लग रहा रही".split(" "),
    latin: "hai hain tha thi the ka ki ke mein me se ko aur nahi nahin kya aap main hum haan ho to bhi par yeh ye woh wo ek kuch ji kab kaise kitne hota hoti lag raha rahi".split(" "),
    typical: 0.25,
  },
  bn: {
    native: "আছে আছেন না কি কী করে করুন হয় হচ্ছে হবে আমার আমি আপনার আপনি এই ও আর তো একটু দিন হ্যাঁ কোন কোনো কত থেকে দিয়ে দিন একটা যে তাহলে মনে লাগে কেমন".split(" "),
    latin: "ache achen na ki kore korun hoy hochhe hobe amar ami apnar apni ei o ar to ektu din hyan kon kono koto theke diye ekta je tahole mone lage kemon".split(" "),
    // Bengali is agglutinative (করছি, চোখে …), so fewer free-standing function words than Hindi
    typical: 0.1,
  },
};

const SUPPORTED = new Set(["en", "hi", "bn"]);

const WEIGHTS: Record<QualitySignal["name"], number> = {
  confidence: 0.3,
  language_fit: 0.2,
  script: 0.15,
  garbled: 0.1,
  repetition: 0.15,
  speech_rate: 0.1,
  // Whisper's own Bengali→English translation is noisy, so agreement is only a weak hint
  translation_agreement: 0.05,
  keyword_density: 0.1,
};

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const r2 = (x: number) => +x.toFixed(2);
const nativeTokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

function scriptCounts(text: string) {
  let dev = 0, ben = 0, lat = 0, other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0900 && c <= 0x097f) dev++;
    else if (c >= 0x0980 && c <= 0x09ff) ben++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lat++;
    else if (/\p{L}/u.test(ch)) other++; // Gurmukhi, Odia, Tamil … = decoded as another language
  }
  return { dev, ben, lat, other };
}

/** Language from the script when the caller doesn't know it (typed transcript, auto-detect off). */
export function inferLanguage(text: string): string {
  const { dev, ben } = scriptCounts(text);
  return ben > dev && ben > 0 ? "bn" : dev > 0 ? "hi" : "en";
}

/** Tokens that repeat in a loop: 1 word ×4+ or a 2–6 word phrase ×3+ in a row. Returns the looped share. */
export function loopRatio(tokens: string[]): number {
  if (tokens.length < 8) return 0;
  const looped = new Uint8Array(tokens.length);
  for (let n = 1; n <= 6; n++) {
    const need = n === 1 ? 4 : 3;
    for (let i = 0; i + n * need <= tokens.length; ) {
      let reps = 1;
      while (i + (reps + 1) * n <= tokens.length && tokens.slice(i + reps * n, i + (reps + 1) * n).join(" ") === tokens.slice(i, i + n).join(" ")) reps++;
      if (reps >= need) {
        for (let k = i + n; k < i + reps * n; k++) looped[k] = 1;
        i += reps * n;
      } else i++;
    }
  }
  return looped.reduce((s, x) => s + x, 0) / tokens.length;
}

export function tierFor(score: number): QualityTier {
  const q = config.quality;
  return score >= q.high ? "high" : score >= q.medium ? "medium" : score >= q.low ? "low" : "unusable";
}

export interface AssessOptions {
  english?: string;
  language?: string | null;
  asr?: AsrSignals | null;
  /** known correct text (a recording script) → measured WER/CER */
  reference?: string;
  /** stage-2 result for the transcript, if already computed */
  keywords?: KeywordReport;
}

export function assessTranscript(transcript: string, opts: AssessOptions = {}): TranscriptQuality {
  const text = transcript ?? "";
  const asked = (opts.language ?? "").toLowerCase();
  // decoded as a language we don't handle (pa, or, ta …): language/script checks would only add noise
  const unsupported = !!asked && !SUPPORTED.has(asked);
  const lang = (opts.language && FUNCTION_WORDS[opts.language] ? opts.language : inferLanguage(text)) as keyof typeof FUNCTION_WORDS;
  const toks = nativeTokens(text);
  const words = toks.length;
  const signals: QualitySignal[] = [];
  const issues: string[] = [];
  const sig = (name: QualitySignal["name"], value: number | null, score: number | null, note: string) =>
    signals.push({ name, value: value === null ? null : r2(value), score: score === null ? null : r2(clamp(score)), weight: WEIGHTS[name], note });

  // 1. ASR confidence
  const asr = opts.asr ?? {};
  if (typeof asr.confidence === "number") {
    const low = asr.lowConfidenceRatio ?? null;
    const s = 0.7 * clamp((asr.confidence - 0.4) / 0.45) + 0.3 * (low === null ? clamp((asr.confidence - 0.4) / 0.45) : clamp(1 - low * 2.5));
    sig("confidence", asr.confidence, s, `mean token probability ${asr.confidence.toFixed(2)}${low !== null ? `, ${Math.round(low * 100)}% of tokens below ${config.quality.lowConfP}` : ""}`);
    if (s < 0.5) issues.push(`The speech model was unsure of much of the audio (confidence ${asr.confidence.toFixed(2)}).`);
  } else sig("confidence", null, null, "not reported by this ASR backend / typed transcript");

  // 2. Language fit (function words)
  const fw = FUNCTION_WORDS[lang];
  const indicLetters = scriptCounts(text);
  const useLatin = lang === "en" || indicLetters.dev + indicLetters.ben + indicLetters.other === 0;
  const fwSet = new Set(useLatin ? fw.latin : fw.native);
  if (words >= 15) {
    const rate = toks.filter((t) => fwSet.has(t)).length / words;
    const s = clamp(rate / fw.typical);
    sig("language_fit", rate, s, `${Math.round(rate * 100)}% everyday ${lang} words (typical ≈ ${Math.round(fw.typical * 100)}%)`);
    if (s < 0.5 && !unsupported) issues.push(`Few everyday ${({ en: "English", hi: "Hindi", bn: "Bengali" } as any)[lang]} words — the audio may be in another language or badly decoded; try forcing the spoken language.`);
  } else sig("language_fit", null, null, "transcript too short");

  // 3. Script
  const { dev, ben, lat, other } = indicLetters;
  if (lang === "en") {
    const total = dev + ben + lat + other;
    const s = total ? lat / total : null;
    sig("script", s, s, "share of Latin letters");
    if (s !== null && s < 0.7 && !unsupported) issues.push("An English visit came out largely in Indian script — check the language setting.");
  } else if (dev + ben + other > 0) {
    const s = (lang === "bn" ? ben : dev) / (dev + ben + other);
    sig("script", s, s, `share of ${lang === "bn" ? "Bengali" : "Devanagari"} letters among Indian-script letters`);
    if (s < 0.7 && !unsupported) issues.push(`Only ${Math.round(s * 100)}% of the Indian-script text is in ${lang === "bn" ? "Bengali" : "Devanagari"} script — the audio was probably decoded as the wrong language.`);
  } else sig("script", null, null, "romanised transcript — script not checked");

  // 3b. Garbled output: broken UTF-8, markup, lone consonants (Vaani byte-level decoding failures)
  const rawToks = text.split(/\s+/).filter(Boolean);
  if (rawToks.length >= 8) {
    const junk = rawToks.filter((t) => /[\uFFFD<>§¯¨]/.test(t) || /^[\u0915-\u0939\u0995-\u09B9][\u093C\u09BC\u094D\u09CD]?[।,.?!]*$/.test(t)).length / rawToks.length;
    sig("garbled", junk, 1 - junk * 2.7, `${Math.round(junk * 100)}% of words are broken characters or fragments`);
    if (junk > 0.08) issues.push(`${Math.round(junk * 100)}% of the words are broken characters or one-letter fragments — the speech model failed on parts of the audio.`);
  } else sig("garbled", null, null, "transcript too short");

  // 4. Repetition loops
  const loop = loopRatio(normalize(text).split(" ").filter(Boolean));
  sig("repetition", loop, 1 - loop * 3, `${Math.round(loop * 100)}% of words are in repeated loops`);
  if (loop > 0.08) issues.push(`${Math.round(loop * 100)}% of the transcript is a repeated loop — typical speech-model hallucination; that part carries no information.`);

  // 5. Speech rate
  const dur = asr.durationSec ?? null;
  if (dur && dur > 10) {
    const wpm = words / (dur / 60);
    const minOk = { en: 60, hi: 55, bn: 40 }[lang] ?? 50;
    const s = wpm < minOk ? wpm / minOk : wpm > 280 ? 1 - (wpm - 280) / 200 : 1;
    sig("speech_rate", wpm, s, `${Math.round(wpm)} words/min over ${Math.round(dur)} s of audio`);
    if (wpm < minOk * 0.6) issues.push(`Only ${Math.round(wpm)} words per minute of audio — parts of the conversation were probably dropped.`);
  } else sig("speech_rate", null, null, "audio duration unknown");

  // 6. Native vs English translation
  const kw = opts.keywords ?? detectKeywords(text, lang);
  if (opts.english?.trim() && lang !== "en") {
    const agree = keywordAgreement(kw, detectKeywords(opts.english, "en"));
    if (agree !== null) {
      sig("translation_agreement", agree, clamp(agree / 0.5), `${Math.round(agree * 100)}% of eye-side / number / duration / symptom words agree between the ${lang} transcript and the English translation`);
      if (agree < 0.3) issues.push("The transcript and its English translation disagree on basics (eye side, numbers, durations) — at least one of them is unreliable.");
    } else sig("translation_agreement", null, null, "too few shared keywords to compare");
  } else sig("translation_agreement", null, null, "no translation (English audio or translation off)");

  // 7. General keyword density
  if (words >= 15) {
    const s = clamp(kw.perHundredWords / 12) * 0.6 + clamp(kw.categoriesFound / 7) * 0.4;
    sig("keyword_density", kw.perHundredWords, s, `${kw.perHundredWords} general keywords per 100 words, ${kw.categoriesFound} kinds`);
    if (s < 0.4 && !unsupported) issues.push("Very few everyday consultation words (eye side, days, drops, numbers) were recognised.");
  } else sig("keyword_density", null, null, "transcript too short");

  // Weighted mean over the signals that are available
  const avail = signals.filter((s) => s.score !== null);
  const wsum = avail.reduce((s, x) => s + x.weight, 0);
  let estimated = wsum ? avail.reduce((s, x) => s + x.weight * x.score!, 0) / wsum : 0;
  // Weakest link: one clearly failed core signal (wrong language, loops, low confidence, dropped speech)
  // can't be averaged away by the others being fine.
  const core = avail.filter((s) => ["confidence", "language_fit", "script", "garbled", "repetition", "speech_rate"].includes(s.name));
  if (core.length) estimated = Math.min(estimated, Math.min(...core.map((s) => s.score!)) + 0.3);
  // Hard caps: some failures make the text unreliable whatever the other signals say
  if (unsupported) {
    estimated = Math.min(estimated, config.quality.low - 0.01);
    issues.unshift(`The audio was decoded as "${asked}", which this system does not support (English/Hindi/Bengali) — pick the spoken language and transcribe again.`);
  }
  const scriptSig = signals.find((s) => s.name === "script")?.score;
  if (scriptSig !== null && scriptSig !== undefined && scriptSig < 0.5) estimated = Math.min(estimated, config.quality.medium - 0.01);
  if (loop > 0.3) estimated = Math.min(estimated, (loop > 0.5 ? config.quality.low : config.quality.medium) - 0.01);
  if (words < 8) {
    estimated = 0;
    issues.unshift("The transcript is (almost) empty.");
  }
  estimated = r2(estimated);

  let score = estimated;
  let source: TranscriptQuality["source"] = "estimated";
  let measured: TranscriptQuality["measured"];
  if (opts.reference?.trim()) {
    const er = errorRates(text, opts.reference);
    const metric = lang === "en" ? "WER" : "CER";
    measured = { metric, wer: r2(er.wer), cer: r2(er.cer), refWords: er.refWords };
    score = r2(clamp(1 - (metric === "WER" ? er.wer : er.cer)));
    source = "measured";
  }

  const lowP = config.quality.lowConfP;
  const lowConfidenceWords = [...new Set((asr.words ?? []).filter((w) => w.p < lowP).flatMap((w) => normalize(w.w).split(" ")).filter((w) => w.length > 2))];

  return { score, estimated, source, tier: tierFor(score), language: lang, words, signals, measured, issues, lowConfidenceWords };
}

/** How the medical-term stage (stage 3) runs for each tier. */
export interface MedicalPolicy {
  tier: QualityTier;
  /** minimum fuzzy similarity for Latin-script (English / romanised) text */
  fuzzyMinLatin: number;
  /** minimum fuzzy similarity for native-script text (transliteration drift is not ASR error, so kept stable) */
  fuzzyMinIndic: number;
  /** minimum matcher score for a term to be offered to the LLM */
  candidateMin: number;
  /** multiplier on MAX_CANDIDATES */
  candidateFactor: number;
  /** tell the LLM the transcript is unreliable */
  cautionLlm: boolean;
  /** skip the LLM entirely (QUALITY_GATE=on and tier unusable) */
  skipLlm: boolean;
  description: string;
}

export function policyFor(tier: QualityTier): MedicalPolicy {
  const gate = config.quality.gate;
  switch (tier) {
    case "high":
      // Same thresholds as medium on purpose: clean text still has the odd ASR misspelling ("brimonadin"),
      // and tightening would drop those. What changes with the tier is trust, not recall.
      return { tier, fuzzyMinLatin: 0.8, fuzzyMinIndic: 0.8, candidateMin: 0.6, candidateFactor: 1, cautionLlm: false, skipLlm: false,
        description: "clean transcript: standard matching, terms can be taken as heard" };
    case "medium":
      return { tier, fuzzyMinLatin: 0.8, fuzzyMinIndic: 0.8, candidateMin: 0.6, candidateFactor: 1, cautionLlm: false, skipLlm: false,
        description: "standard matching; spot-check drug names and numbers" };
    case "low":
      return { tier, fuzzyMinLatin: 0.75, fuzzyMinIndic: 0.75, candidateMin: 0.5, candidateFactor: 1.3, cautionLlm: true, skipLlm: false,
        description: "noisy transcript: looser fuzzy matching, more candidates, LLM told to be cautious — every term needs checking" };
    default:
      return { tier, fuzzyMinLatin: 0.75, fuzzyMinIndic: 0.75, candidateMin: 0.5, candidateFactor: 1.3, cautionLlm: true, skipLlm: gate,
        description: gate ? "transcript unusable: medical terms listed from the text only, no prescription generated (set QUALITY_GATE=off or use --force to generate anyway)" : "transcript unusable: generated anyway (QUALITY_GATE=off)" };
  }
}
