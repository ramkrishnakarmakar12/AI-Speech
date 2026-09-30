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

export interface PostResult {
  removed: string[];
  notes: string[];
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
function medicinesHeard(p: Prescription, heardText: string, kb: KnowledgeBase, out: PostResult) {
  const byId = new Map(kb.terms.map((t) => [t.id, t]));
  const norm = normalize(heardText);
  p.medications = p.medications.filter((m) => {
    const label = m.generic_name || m.brand_said;
    if (!label && !m.kb_id) {
      out.notes.push("Removed an empty medication row.");
      return false;
    }
    const term = m.kb_id ? byId.get(m.kb_id) : undefined;
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

export function postProcess(
  p: Prescription,
  ctx: { heardText: string; kb: KnowledgeBase; negatedIds: Set<string>; negatedText: string; positiveIds: Set<string> },
): PostResult {
  const out: PostResult = { removed: [], notes: [] };
  medicinesHeard(p, ctx.heardText, ctx.kb, out);
  negatedItems(p, ctx.negatedIds, ctx.negatedText, ctx.positiveIds, out);
  patientSanity(p, out);
  phaseSanity(p, ctx.heardText, out);
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
