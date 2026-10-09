/**
 * Three stages, in order:
 *   1. transcription accuracy   – how far can this transcript be trusted? (quality/accuracy.ts)
 *   2. general keywords         – eye side, numbers, durations, frequency, drops, lay symptoms … (match/keywords.ts)
 *   3. medical terms            – KB matching whose strictness depends on the stage-1 tier, then
 *                                 LLM structured extraction → grounding against KB → prescription draft
 */
import { config } from "./config.js";
import { loadKb } from "./kb/build-kb.js";
import type { KnowledgeBase, Term, TermCategory } from "./kb/types.js";
import { findMatches, normalize, pickScenarios, selectCandidates, type Match } from "./match/matcher.js";
import { hasIndicScript, transliterate } from "./match/translit.js";
import { detectKeywords, type KeywordReport } from "./match/keywords.js";
import { assessTranscript, inferLanguage, policyFor, type AsrSignals, type MedicalPolicy, type TranscriptQuality } from "./quality/accuracy.js";
import { chatJson } from "./llm/client.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./llm/prompt.js";
import { prescriptionSchema, type Prescription } from "./llm/schema.js";
import { transcribe, type Transcript } from "./asr/index.js";
import { scanLexicon, type LexHit } from "./domain/lexicon.js";
import { findNegations, insideNegation, type NegatedSpan } from "./domain/negation.js";
import { postProcess, supported, translationForLlm } from "./domain/postprocess.js";
import { numbersNote } from "./domain/numbers.js";
import { examplesSection, pickExamples } from "./domain/examples.js";

export interface KbRef {
  id: string;
  name: string;
  category: TermCategory;
  verified: "llm" | "resolved" | "none";
  reference?: Record<string, string>;
}

export interface ExtractOptions {
  /** English translation of the transcript (from Whisper translate) */
  english?: string;
  /** spoken language code: en / hi / bn */
  language?: string | null;
  /** what the ASR reported about this transcript (confidence, duration, per-word probabilities) */
  asr?: AsrSignals | null;
  /** known correct text → measured WER/CER instead of an estimate */
  reference?: string;
  /** run the LLM even when stage 1 says the transcript is unusable */
  force?: boolean;
}

export interface DetectedTerm {
  id: string;
  name: string;
  category: string;
  heardAs: string;
  score: number;
  kind: Match["kind"];
  /** heard where the ASR was unsure — confirm before trusting */
  uncertain?: boolean;
}

/** What the eye-domain layer found (lexicon, negation, translation policy) */
export interface DomainInfo {
  /** lay phrases / known mishearings decoded to KB terms */
  lexicon: { heard: string; id?: string; name?: string; hint?: string; negated: boolean }[];
  /** phrases the patient/doctor explicitly denied */
  negated: string[];
  negatedIds: string[];
  /** KB terms suppressed because a lexicon phrase explains the words better (e.g. প্রেশার → not glaucoma) */
  blocked: string[];
  translation: { used: boolean; reason?: string };
  /** filled after extraction */
  removed?: string[];
  notes?: string[];
  examples?: string[];
}

/** Stages 1–3 without the LLM (instant) */
export interface Analysis {
  quality: TranscriptQuality;
  keywords: KeywordReport;
  policy: MedicalPolicy;
  matches: Match[];
  detectedTerms: DetectedTerm[];
  domain: DomainInfo;
}

export interface ExtractionResult {
  transcript: string;
  english?: string;
  language?: string | null;
  asr?: Omit<Transcript, "text" | "english" | "words">;
  /** stage 1 */
  quality: TranscriptQuality;
  /** stage 2 */
  keywords: KeywordReport;
  /** stage 3 settings chosen from the stage-1 tier */
  policy: MedicalPolicy;
  prescription: Prescription;
  /** kb references per item, keyed "section.index" (e.g. "medications.0") */
  kbRefs: Record<string, KbRef>;
  warnings: string[];
  detectedTerms: DetectedTerm[];
  domain: DomainInfo;
  llm: { model: string; ms: number; promptTokens?: number; completionTokens?: number; skipped?: string };
}

/** Which KB fields to surface to the doctor next to each extracted item */
const REFERENCE_FIELDS: Partial<Record<TermCategory, string[]>> = {
  medicine: ["Drug Class", "Common Strength", "Typical Prescription Usage", "Key Cautions / Side Effects", "Example Brands (India, indicative)"],
  disease: ["ICD-10 (indicative)", "Category", "Usual Management"],
  procedure: ["Abbreviation", "Anaesthesia / Setting"],
  test: ["Abbreviation", "Normal / Reference Value"],
};

const SECTION_CATEGORIES: Record<string, TermCategory[]> = {
  chief_complaints: ["symptom", "disease"],
  "history.systemic": ["abbreviation", "disease"],
  "history.ocular": ["disease", "procedure", "abbreviation"],
  examination: ["test", "optical", "abbreviation"],
  clinical_findings: ["sign", "disease", "abbreviation"],
  diagnosis: ["disease", "abbreviation"],
  medications: ["medicine"],
  procedures: ["procedure"],
  investigations: ["test"],
  advice: ["counselling"],
};

const NAME_FIELD: Record<string, string> = {
  chief_complaints: "complaint",
  "history.systemic": "condition",
  "history.ocular": "item",
  examination: "test",
  clinical_findings: "finding",
  diagnosis: "condition",
  medications: "generic_name",
  procedures: "procedure",
  investigations: "test",
  advice: "text",
};

function emptyPrescription(): Prescription {
  return {
    patient: { name: "", age: "", sex: "" },
    chief_complaints: [],
    history: { systemic: [], ocular: [], current_medications: [], allergies: [] },
    examination: [],
    clinical_findings: [],
    diagnosis: [],
    medications: [],
    procedures: [],
    investigations: [],
    glasses: [],
    advice: [],
    follow_up: [],
    terms: [],
  };
}

/** Deep-merge model output onto an empty prescription so missing keys never crash rendering. */
function coerce(raw: any): Prescription {
  const base: any = emptyPrescription();
  if (!raw || typeof raw !== "object") return base;
  for (const k of Object.keys(base)) {
    if (k === "patient" || k === "history") base[k] = { ...base[k], ...(raw[k] ?? {}) };
    else if (Array.isArray(raw[k])) base[k] = raw[k];
  }
  for (const k of ["systemic", "ocular", "current_medications", "allergies"]) if (!Array.isArray(base.history[k])) base.history[k] = [];
  return base as Prescription;
}

function resolveByName(name: string, cats: TermCategory[], kb: KnowledgeBase): Term | null {
  if (!name) return null;
  const n = normalize(name);
  const pool = kb.terms.filter((t) => cats.includes(t.category));
  const exact = pool.find((t) => [t.name, ...t.aliases].some((a) => normalize(a) === n));
  if (exact) return exact;
  // head-word match: "Timolol" → "Timolol maleate", "Brimonidine" → "Brimonidine tartrate"
  if (n.length >= 5) {
    const head = pool.find((t) => normalize(t.name).startsWith(n + " "));
    if (head) return head;
  }
  const m = findMatches(name, { ...kb, terms: pool }).filter((x) => x.score >= 0.8);
  return m[0]?.term ?? null;
}

function ground(p: Prescription, kb: KnowledgeBase, transcript: string) {
  const byId = new Map(kb.terms.map((t) => [t.id, t]));
  const kbRefs: Record<string, KbRef> = {};
  const warnings: string[] = [];

  const sectionArrays: [string, any[]][] = [
    ["chief_complaints", p.chief_complaints],
    ["history.systemic", p.history.systemic],
    ["history.ocular", p.history.ocular],
    ["examination", p.examination],
    ["clinical_findings", p.clinical_findings],
    ["diagnosis", p.diagnosis],
    ["medications", p.medications],
    ["procedures", p.procedures],
    ["investigations", p.investigations],
    ["advice", p.advice],
  ];

  for (const [section, items] of sectionArrays) {
    const cats = SECTION_CATEGORIES[section];
    items.forEach((item, i) => {
      const nameField = NAME_FIELD[section];
      let term = item.kb_id ? byId.get(String(item.kb_id).trim()) ?? null : null;
      let verified: KbRef["verified"] = "llm";
      // an id from the wrong category (e.g. a disease id on a medicine) is treated as missing
      if (term && !cats.includes(term.category) && !(section === "diagnosis" && term.category === "abbreviation")) term = null;
      if (!term) {
        term = resolveByName(item[nameField], cats, kb) ?? (item.brand_said ? resolveByName(item.brand_said, cats, kb) : null);
        verified = term ? "resolved" : "none";
      }
      // plain "Glaucoma" is not "Glaucoma suspect" (H40.0) or POAG: no sub-type, no sub-type ICD code
      if (term && section === "diagnosis" && /^glaucoma$/i.test(normalize(item[nameField] ?? "")) && !/^glaucoma$/i.test(normalize(term.name))) {
        warnings.push(`"${item[nameField]}"${item.eye ? ` (${item.eye})` : ""}: type of glaucoma not stated — no ICD-10 sub-code given; add the type (e.g. POAG H40.1) when known.`);
        term = null;
        verified = "none";
      }
      if (term) {
        item.kb_id = term.id;
        const refFields = REFERENCE_FIELDS[term.category] ?? [];
        const reference = Object.fromEntries(refFields.filter((f) => term!.details[f]).map((f) => [f, term!.details[f]]));
        kbRefs[`${section}.${i}`] = { id: term.id, name: term.name, category: term.category, verified, reference };
        if (section === "medications" && !item.generic_name) item.generic_name = term.name;
      } else {
        item.kb_id = "";
        if (["medications", "diagnosis", "procedures"].includes(section) && !(section === "diagnosis" && /^glaucoma$/i.test(normalize(item[nameField] ?? ""))))
          warnings.push(`"${item[nameField] || item.brand_said}" (${section}) is not in the knowledge base — verify spelling.`);
      }
    });
  }

  // Completeness checks on medications
  p.medications.forEach((m) => {
    const label = m.generic_name || m.brand_said || "medication";
    const missing = ["frequency", "duration", "eye"].filter((k) => !(m as any)[k] && !(k === "eye" && /^(Tab|Cap|Inj|Syrup)$/.test(m.form)));
    if (missing.length) warnings.push(`${label}: ${missing.join(", ")} not stated in the conversation.`);
  });

  // Caution cross-check: medicine cautions vs patient's systemic history (e.g. timolol + asthma)
  const historyText = normalize(
    [...p.history.systemic.map((h) => h.condition), ...p.history.allergies, ...p.history.current_medications].join(" ") + " " + transcript,
  );
  const RISK_WORDS = ["asthma", "copd", "heart block", "bradycardia", "pregnan", "sulfa", "diabet", "glaucoma", "kidney", "renal", "children", "infant"];
  p.medications.forEach((m) => {
    const t = m.kb_id ? byId.get(m.kb_id) : undefined;
    const caution = normalize(t?.details["Key Cautions / Side Effects"] ?? "");
    for (const w of RISK_WORDS)
      if (caution.includes(w) && historyText.includes(w))
        warnings.push(`⚠ ${t!.name}: caution mentions "${w}" and it appears in this patient's history — "${t!.details["Key Cautions / Side Effects"]}"`);
  });

  // Terms list: make sure every KB term the model cited really exists
  p.terms = p.terms.filter((t) => !t.kb_id || byId.has(t.kb_id)).map((t) => ({ ...t, canonical: t.kb_id ? byId.get(t.kb_id)!.name : t.canonical }));

  return { kbRefs, warnings };
}

/**
 * Stages 1–3 without the LLM.
 * Stage 1 scores the transcript; stage 2 finds general keywords; stage 3 matches KB terms with thresholds
 * picked from the stage-1 tier and flags terms heard in words the ASR was unsure about.
 */
export function analyzeTranscript(transcript: string, opts: ExtractOptions = {}, kb = loadKb()): Analysis {
  const language = opts.language && opts.language !== "auto" ? opts.language : inferLanguage(transcript);
  // Eye-domain: is the machine English translation trustworthy enough to use at all?
  const tr = translationForLlm(opts.english, language, config.llm.useTranslation);
  const english = tr.use;

  // Stage 2 runs on the transcript alone first, because stage 1 uses it (keyword density, translation agreement)
  const nativeKeywords = detectKeywords(transcript, language);
  // Stage 1
  const quality = assessTranscript(transcript, { english, language, asr: opts.asr, reference: opts.reference, keywords: nativeKeywords });
  // Stage 2 (reported): transcript + English translation
  const keywords = english ? detectKeywords(transcript + "\n" + english, language) : nativeKeywords;

  // Stage 3: the tier decides how strict the medical matcher is
  const policy = policyFor(quality.tier);
  const matchText = [transcript, english ?? ""].join("\n");
  let matches = findMatches(matchText, kb, { fuzzyMinLatin: policy.fuzzyMinLatin, fuzzyMinIndic: policy.fuzzyMinIndic });

  // Eye-domain layer: negation, lay-phrase lexicon, blocked false friends
  const negSpans: NegatedSpan[] = findNegations(transcript);
  const engNeg = english ? findNegations(english) : [];
  const negatedText = [...negSpans.map((n) => n.phrase), ...engNeg.map((n) => n.phrase)].join(" | ");
  const positiveText = removeSpans(transcript, negSpans) + "\n" + (english ? removeSpans(english, engNeg) : "");
  const lex: LexHit[] = [...scanLexicon(transcript, kb), ...(english ? scanLexicon(english, kb).map((h) => ({ ...h, start: -1, end: -1 })) : [])];
  const lexNeg = (h: LexHit) => (h.start >= 0 ? insideNegation(h.start, h.end, negSpans) : normalize(negatedText).includes(normalize(h.heard)) && !normalize(positiveText).includes(normalize(h.heard)));
  const explicit = new Set(lex.filter((h) => h.entry.id).map((h) => h.entry.id!));
  const blocked = new Set(lex.flatMap((h) => h.entry.block ?? []).filter((id) => !explicit.has(id)));
  // A block only suppresses matches that come FROM the blocking phrase's own words (প্রেশার → not glaucoma):
  // "গ্লুকোমা" said in its own words is still glaucoma, "ছানি" does not cancel a spoken "nuclear".
  const roman = (s: string) => normalize(hasIndicScript(s) ? transliterate(s) : s);
  const blockers = lex.filter((h) => h.entry.block?.length).map((h) => ({ ids: new Set(h.entry.block), words: roman(h.heard).split(" ").filter((w) => w.length >= 3) }));
  const fromBlocker = (m: Match) => {
    const heard = roman(m.heardAs).split(" ").filter((w) => w.length >= 3);
    return blockers.some((b) => b.ids.has(m.term.id) && heard.some((w) => b.words.some((x) => x === w || x.startsWith(w) || w.startsWith(x))));
  };
  const before = matches.length;
  matches = matches.filter((m) => !blocked.has(m.term.id) || !fromBlocker(m));
  // short fuzzy matches on diseases/signs caused most false diagnoses ("চোখে ছয়" → cataract, "চোখে জেল" → corneal opacity)
  matches = matches.filter((m) => !(m.kind === "fuzzy" && (m.term.category === "disease" || m.term.category === "sign") && m.score < 0.75));
  const blockedNames = before !== matches.length ? [...blocked].map((id) => kb.terms.find((t) => t.id === id)?.name ?? id) : [];

  const negatedIds = new Set<string>();
  const positiveIds = new Set<string>();
  for (const h of lex) {
    if (!h.term) continue;
    if (lexNeg(h)) negatedIds.add(h.term.id);
    else {
      positiveIds.add(h.term.id);
      const have = matches.find((m) => m.term.id === h.term!.id);
      if (have) have.score = Math.max(have.score, 0.95);
      else matches.push({ term: h.term, score: 0.95, form: h.heard, heardAs: h.heard, kind: "exact", count: 1 });
    }
  }
  const normNeg = normalize(negatedText), normPos = normalize(positiveText);
  for (const m of matches) {
    const heard = normalize(m.heardAs);
    if (heard.length >= 3 && normNeg.includes(heard) && !normPos.includes(heard) && !positiveIds.has(m.term.id)) negatedIds.add(m.term.id);
    else positiveIds.add(m.term.id);
  }
  matches = matches.filter((m) => !negatedIds.has(m.term.id) || positiveIds.has(m.term.id)).sort((a, b) => b.score - a.score);

  const lowWords = new Set(quality.lowConfidenceWords);
  if (lowWords.size) for (const m of matches) m.uncertain = normalize(m.heardAs).split(" ").some((w) => lowWords.has(w));

  const detectedTerms = matches.map((m) => ({
    id: m.term.id,
    name: m.term.name,
    category: m.term.category,
    heardAs: m.heardAs,
    score: +m.score.toFixed(2),
    kind: m.kind,
    ...(m.uncertain ? { uncertain: true } : {}),
  }));
  const domain: DomainInfo = {
    lexicon: lex.map((h) => ({ heard: h.heard, id: h.term?.id, name: h.term?.name, hint: h.entry.hint, negated: lexNeg(h) })),
    negated: [...negSpans, ...engNeg].map((n) => `${n.phrase} ${n.negator}`.trim()),
    negatedIds: [...negatedIds].filter((id) => !positiveIds.has(id)),
    blocked: blockedNames,
    translation: { used: !!english, reason: tr.reason },
  };
  // internal working values for the extraction step — non-enumerable, so they never reach the API/JSON
  for (const [k, v] of [["_negatedText", negatedText], ["_positiveText", positiveText], ["_positiveIds", [...positiveIds]]] as const)
    Object.defineProperty(domain, k, { value: v, enumerable: false, configurable: true });
  return { quality, keywords, policy, matches, detectedTerms, domain };
}

/** The text with the given spans cut out (what was said WITHOUT the denied parts). */
function removeSpans(text: string, spans: NegatedSpan[]): string {
  let out = "", at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at) continue;
    out += text.slice(at, s.start) + " ";
    at = s.end;
  }
  return out + text.slice(at);
}

/** Prompt notes from the domain layer: decoded lay phrases, denied conditions, approved clinic examples. */
function domainNotes(a: Analysis, language: string | null | undefined, transcript = ""): { notes: string[]; examples: string[] } {
  const notes: string[] = [];
  const hints = a.domain.lexicon.filter((l) => !l.negated && (l.hint || l.id));
  if (hints.length) {
    const seen = new Set<string>();
    notes.push(
      "EYE-CLINIC PHRASES DECODED (lay words / speech-recognition slips in this transcript and what they mean)\n" +
        hints
          .filter((l) => !seen.has(l.heard + l.id) && seen.add(l.heard + l.id))
          .map((l) => `- «${l.heard}» → ${l.id ? `${l.id} ${l.name}` : ""}${l.hint ? `${l.id ? " — " : ""}${l.hint}` : ""}`)
          .join("\n"),
    );
  }
  const nums = numbersNote(transcript);
  if (nums) notes.push(nums);
  if (a.domain.negated.length) notes.push("NEGATED (explicitly denied — do NOT record these as present)\n" + a.domain.negated.map((n) => `- ${n}`).join("\n"));
  const exs = pickExamples(language, a.matches.map((m) => m.term.id));
  if (exs.length) notes.push(examplesSection(exs));
  return { notes, examples: exs.map((e) => e.id) };
}

function qualityWarnings(a: Analysis): string[] {
  const q = a.quality;
  const out: string[] = [];
  const head = q.source === "measured" ? `${q.measured!.metric} ${Math.round((q.measured!.metric === "WER" ? q.measured!.wer : q.measured!.cer) * 100)}%` : `estimated ${Math.round(q.score * 100)}%`;
  if (q.tier === "low" || q.tier === "unusable")
    out.push(`⚠ Transcript accuracy is ${q.tier.toUpperCase()} (${head}). ${q.issues.join(" ")} Every item below needs checking against the recording.`);
  else if (q.issues.length) out.push(`Transcript accuracy ${q.tier} (${head}): ${q.issues.join(" ")}`);
  return out;
}

const COVERAGE_SYSTEM = `You check an ophthalmology prescription draft against the doctor–patient conversation it was made from.
List clinically relevant things that were SAID in the conversation but are MISSING from the draft: complaints, history
(systemic illness and its duration, current medicines, allergy status, previous eye surgery, glasses), examination values
per eye, diagnoses, medicines (including ones that start later, e.g. before surgery), drop instructions, procedures,
investigations, advice, follow-up. Ignore small talk, cost discussion and the patient's own guesses.
Do not list anything already in the draft (even if worded differently). For each item quote the exact transcript words.
Return at most 12 items, most important first. Return JSON only.`;

const coverageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["missed"],
  properties: {
    missed: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "item", "evidence"],
        properties: {
          section: { type: "string", enum: ["complaint", "history", "examination", "diagnosis", "medication", "procedure", "investigation", "advice", "follow-up"] },
          item: { type: "string", description: "what is missing, in English" },
          evidence: { type: "string", description: "exact words from the transcript" },
        },
      },
    },
  },
};

/** Second LLM pass: things said but missing from the draft. Shown to the doctor as warnings, never merged silently. */
async function coverageCheck(transcript: string, english: string | undefined, p: Prescription): Promise<string[]> {
  if (!config.llm.coverageCheck) return [];
  const draft = JSON.stringify(p, (k, v) => (k === "evidence" || k === "kb_id" || k === "terms" || k === "patient_words" || v === "" || (Array.isArray(v) && !v.length) ? undefined : v));
  const res = await chatJson(
    [
      { role: "system", content: COVERAGE_SYSTEM },
      { role: "user", content: `## CONVERSATION TRANSCRIPT\n${transcript.trim()}${english ? `\n\n## MACHINE ENGLISH TRANSLATION\n${english.trim()}` : ""}\n\n## DRAFT PRESCRIPTION (JSON)\n${draft}` },
    ],
    coverageSchema,
  );
  const j = res.json as any;
  const rows: any[] = Array.isArray(j?.missed) ? j.missed : [];
  const heard = transcript + "\n" + (english ?? "");
  return rows
    .filter((m) => m?.item && supported(m.evidence, heard)) // only items that really are in the conversation
    .slice(0, 12)
    .map((m) => `Possibly missed (${m.section}): ${m.item} — «${String(m.evidence).trim()}»`);
}

export async function extractFromTranscript(transcript: string, opts: ExtractOptions = {}, kb = loadKb()): Promise<ExtractionResult> {
  // Stages 1–3 (lexical)
  const analysis = analyzeTranscript(transcript, opts, kb);
  const { quality, keywords, policy, matches, detectedTerms, domain } = analysis;
  const base = { transcript, english: opts.english, language: opts.language ?? quality.language, quality, keywords, policy, detectedTerms, domain };
  const englishForLlm = domain.translation.used ? opts.english : undefined;

  if (policy.skipLlm && !opts.force) {
    for (const k of ["_negatedText", "_positiveText", "_positiveIds"]) delete (domain as any)[k];
    return {
      ...base,
      prescription: emptyPrescription(),
      kbRefs: {},
      warnings: [
        ...qualityWarnings(analysis),
        "No prescription was generated: the transcript is too unreliable. The terms detected below are shown for reference only. Pick the spoken language / re-record, or generate anyway (--force, or QUALITY_GATE=off).",
      ],
      llm: { model: "", ms: 0, skipped: `transcript accuracy ${quality.tier}` },
    };
  }

  // Match on both the original (romanised if Hindi/Bengali script) and the English translation
  const matchText = [transcript, englishForLlm ?? ""].join("\n");
  const candidates = selectCandidates(matches, Math.round(config.llm.maxCandidates * policy.candidateFactor), policy.candidateMin);
  const scenarios = config.llm.scenarioExamples > 0 ? pickScenarios(matches, kb, config.llm.scenarioExamples) : [];
  void scenarios; // no longer sent to the model (see prompt.ts)
  const qualityNote = policy.cautionLlm
    ? `TRANSCRIPT QUALITY: ${quality.tier} (accuracy ≈ ${Math.round(quality.score * 100)}%). ${quality.issues.join(" ")} ` +
      "Expect many speech-recognition errors: rely on CANDIDATES and the English translation, correct a misheard term only when a KB term clearly fits, and leave a field empty rather than guess."
    : undefined;
  const dn = domainNotes(analysis, opts.language ?? quality.language, transcript);
  domain.examples = dn.examples;
  const user = buildUserPrompt({ transcript, english: englishForLlm, language: opts.language, candidates, kb, indexCategories: [], scenarios: [], qualityNote, domainNotes: dn.notes });

  const res = await chatJson(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    prescriptionSchema,
  );
  const prescription = coerce(res.json);
  // Eye-domain safety checks, then KB grounding (drug cautions only against what was NOT denied)
  const d = domain as any;
  const post = postProcess(prescription, {
    heardText: matchText,
    kb,
    negatedIds: new Set(domain.negatedIds),
    negatedText: d._negatedText ?? "",
    positiveIds: new Set<string>(d._positiveIds ?? []),
  });
  domain.removed = post.removed;
  domain.notes = post.notes;
  const { kbRefs, warnings } = ground(prescription, kb, d._positiveText ?? matchText);
  for (const r of post.removed) warnings.push(`Removed: ${r}.`);
  for (const f of post.flags) warnings.push(`Check: ${f}.`);
  // Second pass: what was said but is not in the draft? (LEF evaluation: allergy, ECG, glare, referral … dropped)
  const missed = await coverageCheck(transcript, englishForLlm, prescription).catch((e) => [`Coverage check skipped: ${e?.message ?? e}`]);
  warnings.push(...missed);
  if (domain.translation.reason && opts.english?.trim()) warnings.push(`Machine English translation not used: ${domain.translation.reason}.`);
  if (res.truncated) warnings.unshift(`⚠ The model's answer was cut short (${res.truncated}); some items may be missing — check against the transcript.`);
  // A whole section left empty although the conversation clearly has it (Oct 2026 run: complaints and the full
  // examination missing from a clean Bengali transcript) — say so instead of printing "—".
  const gaps = emptySections(prescription, matchText);
  if (gaps.length) {
    warnings.unshift(`⚠ ${gaps.join(" ")} Enter them from the transcript or generate again.`);
    console.warn("[extract] sections empty although spoken:", gaps.join(" | "), res.truncated ? `(truncated: ${res.truncated})` : "");
  }

  // Medical items the ASR was unsure about (stage 1 word confidence → stage 3)
  const unsure = new Set(matches.filter((m) => m.uncertain).map((m) => m.term.id));
  for (const [key, ref] of Object.entries(kbRefs))
    if (unsure.has(ref.id) && ["medications", "diagnosis", "procedures", "investigations"].includes(key.split(".")[0]))
      warnings.push(`${ref.name}: heard in a part of the audio the speech model was unsure about — confirm it was really said.`);
  warnings.unshift(...qualityWarnings(analysis));

  delete d._negatedText;
  delete d._positiveText;
  delete d._positiveIds;
  return {
    ...base,
    prescription,
    kbRefs,
    warnings,
    llm: { model: res.model, ms: res.ms, promptTokens: res.usage?.prompt, completionTokens: res.usage?.completion },
  };
}

const EXAM_SAID = /দৃষ্টি|ভিশন|চোখের প্রেশার|ফান্ডাস|স্লিট|কাপ ডিস্ক|কাপডিস্ক|visual acuity|vision is|vision \d|eye pressure|fundus|slit.?lamp|cup.?disc|नज़र|नजर|आँख का प्रेशर|आंख का प्रेशर|स्लिट|फंडस|बटा|\b6\/\d{1,2}\b|ছয় বাই|ছ বাই|छह बटा/i;
const COMPLAINT_SAID = /অসুবিধা|সমস্যা|কষ্ট|ঝাপসা|ব্যথা|problem|trouble|complain|blur|pain|तकलीफ|परेशानी|दिक्कत|धुंधला|दर्द/i;

/** Sections the model left empty although the conversation has them. */
export function emptySections(p: Prescription, heard: string): string[] {
  const out: string[] = [];
  if (!p.chief_complaints.length && COMPLAINT_SAID.test(heard)) out.push("No complaints were extracted, but the patient described a problem.");
  if (!p.examination.length && !p.clinical_findings.length && EXAM_SAID.test(heard)) out.push("The examination section is empty, but the doctor gave examination findings (vision / pressure / slit lamp / fundus).");
  return out;
}

/** Transcript fields that carry stage-1 signals */
export const asrSignals = (t: Transcript): AsrSignals => ({ confidence: t.confidence, lowConfidenceRatio: t.lowConfidenceRatio, words: t.words, durationSec: t.durationSec });

export async function runFromAudio(
  audioPath: string,
  transcriptOverride?: string,
  language?: string,
  extra: Pick<ExtractOptions, "reference" | "force"> = {},
): Promise<ExtractionResult> {
  if (transcriptOverride?.trim()) return extractFromTranscript(transcriptOverride, { language, ...extra });
  const t = await transcribe(audioPath, { language });
  const r = await extractFromTranscript(t.text, { english: t.english, language: t.language, asr: asrSignals(t), ...extra });
  const { text: _t, english: _e, words: _w, ...asr } = t;
  return { ...r, asr };
}
