/**
 * transcript → candidate terms (matcher) → LLM structured extraction → grounding against KB → prescription draft
 */
import { config } from "./config.js";
import { loadKb } from "./kb/build-kb.js";
import type { KnowledgeBase, Term, TermCategory } from "./kb/types.js";
import { findMatches, normalize, pickScenarios, selectCandidates, type Match } from "./match/matcher.js";
import { chatJson } from "./llm/client.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./llm/prompt.js";
import { prescriptionSchema, type Prescription } from "./llm/schema.js";
import { transcribe, type Transcript } from "./asr/index.js";

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
}

export interface ExtractionResult {
  transcript: string;
  english?: string;
  language?: string | null;
  asr?: Omit<Transcript, "text">;
  prescription: Prescription;
  /** kb references per item, keyed "section.index" (e.g. "medications.0") */
  kbRefs: Record<string, KbRef>;
  warnings: string[];
  detectedTerms: { id: string; name: string; category: string; heardAs: string; score: number }[];
  llm: { model: string; ms: number; promptTokens?: number; completionTokens?: number };
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
      if (term) {
        item.kb_id = term.id;
        const refFields = REFERENCE_FIELDS[term.category] ?? [];
        const reference = Object.fromEntries(refFields.filter((f) => term!.details[f]).map((f) => [f, term!.details[f]]));
        kbRefs[`${section}.${i}`] = { id: term.id, name: term.name, category: term.category, verified, reference };
        if (section === "medications" && !item.generic_name) item.generic_name = term.name;
      } else {
        item.kb_id = "";
        if (["medications", "diagnosis", "procedures"].includes(section))
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

export async function extractFromTranscript(transcript: string, opts: ExtractOptions = {}, kb = loadKb()): Promise<ExtractionResult> {
  // Match on both the original (romanised if Hindi/Bengali script) and the English translation
  const matchText = [transcript, opts.english ?? ""].join("\n");
  const matches = findMatches(matchText, kb);
  const candidates = selectCandidates(matches, config.llm.maxCandidates);
  const scenarios = config.llm.scenarioExamples > 0 ? pickScenarios(matches, kb, config.llm.scenarioExamples) : [];
  const user = buildUserPrompt({ transcript, english: opts.english, language: opts.language, candidates, kb, indexCategories: config.llm.indexCategories, scenarios });

  const res = await chatJson(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    prescriptionSchema,
  );
  const prescription = coerce(res.json);
  const { kbRefs, warnings } = ground(prescription, kb, matchText);
  if (res.truncated) warnings.unshift(`⚠ The model's answer was cut short (${res.truncated}); some items may be missing — check against the transcript.`);

  return {
    transcript,
    english: opts.english,
    language: opts.language,
    prescription,
    kbRefs,
    warnings,
    detectedTerms: matches.map((m: Match) => ({ id: m.term.id, name: m.term.name, category: m.term.category, heardAs: m.heardAs, score: +m.score.toFixed(2) })),
    llm: { model: res.model, ms: res.ms, promptTokens: res.usage?.prompt, completionTokens: res.usage?.completion },
  };
}

export async function runFromAudio(audioPath: string, transcriptOverride?: string, language?: string): Promise<ExtractionResult> {
  if (transcriptOverride?.trim()) return extractFromTranscript(transcriptOverride, { language });
  const t = await transcribe(audioPath, { language });
  const r = await extractFromTranscript(t.text, { english: t.english, language: t.language });
  const { text: _t, english: _e, ...asr } = t;
  return { ...r, asr };
}
