/**
 * Checks applied to the LLM's prescription BEFORE grounding — each one fixes an error seen in the
 * evaluation runs (evaluation/model_analysis_latest.md):
 *   · duplicate rows (CMC ×3, "Itching" ×9, "Nausea" ×4)
 *   · empty medication rows
 *   · medicines nobody said (Prednisolone for a dry-eye patient, Dexamethasone implant from "amstrad")
 *   · conditions the patient denied (Diabetes from "সুগার প্রেশার নেই")
 *   · greetings or ASR noise as the patient's name ("Ashan Bhusun" = আসুন বসুন), impossible ages ("At 8")
 *   · "pre-op" / "post-op" on visits where no surgery was discussed
 */
import type { KnowledgeBase } from "../kb/types.js";
import type { Prescription } from "../llm/schema.js";
import { findMatches, normalize } from "../match/matcher.js";
import { findNumbers } from "./numbers.js";

export interface PostResult {
  removed: string[];
  notes: string[];
  /** items kept but needing the doctor's attention (shown under "Check before signing") */
  flags: string[];
}

const SECTIONS: [string, (p: Prescription) => any[], (x: any) => string][] = [
  ["chief_complaints", (p) => p.chief_complaints, (x) => `${x.kb_id || normalize(x.complaint ?? "")}|${x.eye ?? ""}`],
  ["history.systemic", (p) => p.history.systemic, (x) => x.kb_id || normalize(x.condition ?? "")],
  ["history.ocular", (p) => p.history.ocular, (x) => `${x.kb_id || normalize(x.item ?? "")}|${x.eye ?? ""}`],
  ["examination", (p) => p.examination, (x) => `${x.kb_id || normalize(x.test ?? "")}|${x.eye ?? ""}|${normalize(x.result ?? "")}`],
  ["clinical_findings", (p) => p.clinical_findings, (x) => `${x.kb_id || normalize(x.finding ?? "")}|${x.eye ?? ""}`],
  ["diagnosis", (p) => p.diagnosis, (x) => `${x.kb_id || normalize(x.condition ?? "")}|${x.eye ?? ""}`],
  ["medications", (p) => p.medications, (x) => [x.kb_id || normalize(x.generic_name || x.brand_said || ""), x.form, x.eye, normalize(x.frequency ?? "")].join("|")],
  ["procedures", (p) => p.procedures, (x) => `${x.kb_id || normalize(x.procedure ?? "")}|${x.eye ?? ""}`],
  ["investigations", (p) => p.investigations, (x) => `${x.kb_id || normalize(x.test ?? "")}|${x.eye ?? ""}`],
  ["advice", (p) => p.advice, (x) => x.kb_id || normalize(x.text ?? "")],
  ["follow_up", (p) => p.follow_up, (x) => normalize(`${x.when} ${x.purpose}`)],
  ["glasses", (p) => p.glasses, (x) => [x.eye, x.sph, x.cyl, x.axis, x.add].join("|")],
  ["terms", (p) => p.terms, (x) => `${x.kb_id}|${normalize(x.heard ?? "")}`],
];

function dedupe(p: Prescription, out: PostResult) {
  for (const [name, get, key] of SECTIONS) {
    const arr = get(p);
    const seen = new Set<string>();
    let dropped = 0;
    for (let i = 0; i < arr.length; ) {
      const k = key(arr[i]);
      if (k && seen.has(k)) {
        arr.splice(i, 1);
        dropped++;
      } else {
        seen.add(k);
        i++;
      }
    }
    if (dropped) out.notes.push(`Removed ${dropped} duplicate ${name.replace(/_/g, " ")} row${dropped > 1 ? "s" : ""}.`);
  }
}

const GREETING = /^(asun|ashun|asen|bosun|bosen|basun|bhusun|bisun|bison|namaskar|nomoskar|namaste|suprabhat|suprobhat|shubho|good|morning|evening|dr|doctor|daktar|daktarbabu|babu|sir|madam|sar|ji)$/;

function patientSanity(p: Prescription, out: PostResult) {
  const name = (p.patient.name ?? "").trim();
  if (name) {
    const words = normalize(name).split(" ").filter(Boolean);
    if (/\b(dr|doctor)\b\.?/i.test(name) || /babu/i.test(name) || (words.length && words.filter((w) => GREETING.test(w)).length >= Math.ceil(words.length / 2))) {
      out.removed.push(`Patient name "${name}" (looks like a greeting or the doctor, not the patient's name)`);
      p.patient.name = "";
    }
  }
  const age = String(p.patient.age ?? "").trim();
  if (age && !/^\d{1,3}(\s*(y|yr|yrs|years?|m|months?))?$/i.test(age)) {
    out.removed.push(`Patient age "${age}" (not a number)`);
    p.patient.age = "";
  } else if (age && Number.parseInt(age) > 110) p.patient.age = "";
}

/** A medicine must have been SAID: its KB entry (or its written name) has to match the conversation. */
function medicinesHeard(p: Prescription, heardText: string, kb: KnowledgeBase, out: PostResult, positiveIds: Set<string> = new Set()) {
  const byId = new Map(kb.terms.map((t) => [t.id, t]));
  const norm = normalize(heardText);
  p.medications = p.medications.filter((m) => {
    const label = m.generic_name || m.brand_said;
    if (!label && !m.kb_id) {
      out.notes.push("Removed an empty medication row.");
      return false;
    }
    const term = m.kb_id ? byId.get(m.kb_id) : undefined;
    // heard via the eye lexicon (e.g. garbled "মক্সিফলেসিন" → Moxifloxacin)
    if (m.kb_id && positiveIds.has(m.kb_id)) return true;
    if (term && findMatches(heardText, { ...kb, terms: [term] }, { fuzzyMinLatin: 0.78, fuzzyMinIndic: 0.72 }).length) return true;
    for (const name of [m.generic_name, m.brand_said].filter(Boolean)) {
      const head = normalize(name!).split(" ")[0];
      if (head.length >= 5 && norm.includes(head)) return true;
      const pseudo = { id: "X", category: "medicine", name: name!, aliases: [], colloquial: [], details: {} } as any;
      if (findMatches(heardText, { ...kb, terms: [pseudo] }, { fuzzyMinLatin: 0.8, fuzzyMinIndic: 0.74 }).length) return true;
    }
    // brand written but generic spoken (Moxicip ↔ मोक्सीफ्लॉक्सासिन): resolve the label to KB medicines and check those
    const meds = { ...kb, terms: kb.terms.filter((t) => t.category === "medicine") };
    for (const name of [m.generic_name, m.brand_said].filter(Boolean))
      for (const hit of findMatches(name!, meds, { fuzzyMinLatin: 0.85, fuzzyMinIndic: 0.85 })) {
        const t = hit.term;
        if (t && findMatches(heardText, { ...kb, terms: [t] }, { fuzzyMinLatin: 0.78, fuzzyMinIndic: 0.72 }).length) {
          if (!m.kb_id) m.kb_id = t.id;
          return true;
        }
      }
    out.removed.push(`Medicine "${label || term?.name}" — not found anywhere in the conversation (likely guessed by the model)`);
    return false;
  });
}

const SURGERY = /(surgery|operation|operate|phaco|sics|lasik|laser|injection|অপারেশন|অপারেশান|সার্জারি|ऑपरेशन|आपरेशन|सर्जरी|ইনজেকশন|इंजेक्शन)/i;

function phaseSanity(p: Prescription, text: string, out: PostResult) {
  if (p.procedures.length || SURGERY.test(text)) return;
  let n = 0;
  for (const m of p.medications) if (/(pre|post)[- ]?op/i.test(m.phase ?? "")) (m.phase = ""), n++;
  if (n) out.notes.push(`Cleared "pre-op/post-op" on ${n} medicine${n > 1 ? "s" : ""} (no surgery was discussed).`);
}

/** Drop complaints / systemic history the patient explicitly denied. */
function negatedItems(p: Prescription, negatedIds: Set<string>, negatedText: string, positiveIds: Set<string>, out: PostResult) {
  const neg = normalize(negatedText);
  const isNeg = (id: string, name: string) =>
    (id && negatedIds.has(id) && !positiveIds.has(id)) || (!!name && normalize(name).length >= 4 && neg.includes(normalize(name)) && !(id && positiveIds.has(id)));
  const drop = (arr: any[], field: string, label: string) => {
    for (let i = arr.length - 1; i >= 0; i--)
      if (isNeg(arr[i].kb_id ?? "", arr[i][field] ?? "")) {
        out.removed.push(`${label} "${arr[i][field]}" — the patient said they do NOT have it`);
        arr.splice(i, 1);
      }
  };
  drop(p.chief_complaints, "complaint", "Complaint");
  drop(p.history.systemic, "condition", "History");
}

// ---------------------------------------------------------------------------------------------
// Evidence: every item should quote the transcript words it came from (LEF evaluation, Oct 2026:
// invented advice, a copied hypertension duration, a wrong age and a "cortical" sub-type nobody said).
// ---------------------------------------------------------------------------------------------
const tokens = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split(/[\s,।.?!;:()"'“”‘’\-–—/]+/)
    .filter((t) => t.length >= 2);

/** Are (most of) the quoted words really in the transcript? Tolerant of small ASR/LLM spelling drift. */
export function supported(evidence: string | undefined, transcript: string): boolean {
  const ev = tokens(evidence ?? "");
  if (!ev.length) return false;
  const tr = tokens(transcript);
  const set = new Set(tr);
  const hit = ev.filter((w) => set.has(w) || (w.length >= 4 && tr.some((t) => t.length >= 4 && (t.startsWith(w.slice(0, 4)) || w.startsWith(t.slice(0, 4))))));
  return hit.length / ev.length >= 0.6;
}

const label = (x: any) => x.text || x.condition || x.complaint || x.test || x.finding || x.procedure || x.item || x.generic_name || "item";

function evidenceCheck(p: Prescription, transcript: string, out: PostResult) {
  // Advice is where unspoken template text appeared ("warm compress", "20-20-20"): drop anything unsupported.
  p.advice = p.advice.filter((a) => {
    if (supported(a.evidence, transcript)) return true;
    out.removed.push(`Advice "${a.text}" — no matching words in the conversation`);
    return false;
  });
  // Elsewhere keep the item but flag it for the doctor.
  const sections: [string, any[]][] = [
    ["Complaint", p.chief_complaints],
    ["History", p.history.systemic],
    ["Finding", p.clinical_findings],
    ["Diagnosis", p.diagnosis],
    ["Procedure", p.procedures],
    ["Investigation", p.investigations],
  ];
  for (const [name, rows] of sections)
    for (const r of rows) if (!supported(r.evidence, transcript)) out.flags.push(`${name} "${label(r)}" — no supporting words found in the conversation; confirm it was said`);
}

const SUBTYPE: { ids: string[]; name: RegExp; said: RegExp }[] = [
  { ids: ["DIS-002"], name: /nuclear/i, said: /nuclear|নিউক্লিয়|নিউক্লিয়|न्यूक्लियर|\bNS\s?\d/i },
  { ids: ["DIS-003"], name: /cortical/i, said: /cortical|কর্টিক|कॉर्टिकल|कोर्टिकल/i },
  { ids: ["DIS-004"], name: /posterior subcapsular|\bpsc/i, said: /subcapsular|সাবক্যাপসুলার|পিএসসি|\bpscc?\b/i },
];

/** A cataract sub-type that nobody said becomes plain "Cataract" (it also drove a wrong ICD code). */
function subtypeCheck(p: Prescription, transcript: string, out: PostResult) {
  for (const d of p.diagnosis) {
    const st = SUBTYPE.find((s) => s.ids.includes(d.kb_id) || s.name.test(d.condition));
    if (st && !st.said.test(transcript)) {
      out.notes.push(`"${d.condition}"${d.eye ? ` (${d.eye})` : ""} → "Cataract (type not specified)": the sub-type was not said.`);
      d.condition = "Cataract (type not specified)";
      d.kb_id = "DIS-001";
    }
  }
}

const SYSTEMIC_TEST = /blood|sugar|glucose|hba1c|a1c|fbs|ppbs|rbs|ecg|ekg|electrocardio|pressure monitoring|\bbp\b|urine|creatinine|cbc|haemogram|hemogram|lipid|x-?ray|chest|serolog|hiv|hbsag|hcv|thyroid|tsh|pre-?operative workup|physician/i;

/** Blood tests, ECG etc. have no eye; "(BE)" on them came from the schema forcing an eye side. */
function systemicEye(p: Prescription) {
  for (const t of p.investigations) if (SYSTEMIC_TEST.test(t.test) && !/tonometr|intraocular/i.test(t.test)) t.eye = "";
}

const TIME_OF_DAY = /^(morning|afternoon|evening|night|at night|in the evening|in the afternoon|bedtime|daytime)$/i;

function fieldSanity(p: Prescription, transcript: string, out: PostResult) {
  // "× afternoon": a time of day is not a duration
  for (const c of p.chief_complaints)
    if (c.duration && TIME_OF_DAY.test(c.duration.trim())) {
      c.character = [c.character, `worse in the ${c.duration.replace(/^(at|in the)\s+/i, "")}`].filter(Boolean).join(", ");
      c.duration = "";
    }
  // pressure values of two eyes merged into one range
  for (const e of p.examination)
    if (/pressure|iop|tonometr/i.test(e.test) && /\d+\s*[-–]\s*\d+/.test(e.result) && e.eye !== "BE")
      out.flags.push(`${e.test}${e.eye ? ` (${e.eye})` : ""}: "${e.result}" looks like two eyes merged into one range — enter RE and LE separately`);
  // durations must come from the item's own words (HTN "× 1 year" was copied from diabetes)
  const hasNumber = (s: string) => /\d/.test(s) || findNumbers(s).length > 0 || /\b(one|two|three|four|five|six|seven|eight|nine|ten|few|several)\b|এক|দুই|দু |তিন|চার|পাঁচ|ছয়|সাত|আট|নয়|দশ/i.test(s);
  for (const h of p.history.systemic)
    if (h.duration && h.evidence !== undefined && !hasNumber(h.evidence)) {
      out.notes.push(`Removed duration "${h.duration}" from ${h.condition}: no duration was said for it.`);
      h.duration = "";
    }
  // age must be a number that was actually said
  const age = Number.parseInt(String(p.patient.age ?? ""));
  if (age) {
    const said = new Set<number>([...findNumbers(transcript).map((n) => n.value), ...(transcript.match(/\d+/g) ?? []).map(Number)]);
    if (!said.has(age)) {
      out.flags.push(`Age ${age}: that number does not appear in the conversation — check the age`);
    }
  }
  // medicines: default to "prescribed today"
  for (const m of p.medications) {
    if ((m as any).phase === "current") (m as any).phase = "";
    if (!m.status) m.status = "new";
  }
}

export function postProcess(
  p: Prescription,
  ctx: { heardText: string; kb: KnowledgeBase; negatedIds: Set<string>; negatedText: string; positiveIds: Set<string> },
): PostResult {
  const out: PostResult = { removed: [], notes: [], flags: [] };
  medicinesHeard(p, ctx.heardText, ctx.kb, out, ctx.positiveIds);
  negatedItems(p, ctx.negatedIds, ctx.negatedText, ctx.positiveIds, out);
  patientSanity(p, out);
  phaseSanity(p, ctx.heardText, out);
  subtypeCheck(p, ctx.heardText, out);
  systemicEye(p);
  fieldSanity(p, ctx.heardText, out);
  evidenceCheck(p, ctx.heardText, out);
  dedupe(p, out);
  return out;
}

/**
 * Should the LLM see Whisper's English translation?
 * In testing the Bengali→English pass changed days, times and instructions (Saturday → "Sunday",
 * 6 a.m. → "afternoon") and looped ("constipation…" ×40); Hindi→English was ~90% right.
 */
export function translationForLlm(english: string | undefined, language: string | null | undefined, mode: "auto" | "on" | "off"): { use?: string; reason?: string } {
  const e = english?.trim();
  if (!e) return {};
  if (mode === "off") return { reason: "LLM_USE_TRANSLATION=off" };
  const sentences = e.split(/(?<=[.?!])\s+/).map((s) => normalize(s)).filter((s) => s.length > 3);
  const loopy = sentences.length >= 4 && new Set(sentences).size / sentences.length < 0.7;
  if (loopy) return { reason: "the machine translation repeats itself (hallucination loop)" };
  if (mode === "on") return { use: e };
  if (language === "bn") return { reason: "Bengali→English machine translation is unreliable (set LLM_USE_TRANSLATION=on to use it)" };
  return { use: e };
}
