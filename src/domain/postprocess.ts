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
import type { KnowledgeBase, Term } from "../kb/types.js";
import type { Prescription } from "../llm/schema.js";
import { findMatches, normalize } from "../match/matcher.js";
import { allNumberValues, findNumbers } from "./numbers.js";
import { findNegations } from "./negation.js";
import { scanLexicon } from "./lexicon.js";

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
  // by name: "KOH mount" and "Corneal scraping (smear and culture)" share a vocabulary entry but are two tests
  ["investigations", (p) => p.investigations, (x) => `${normalize(x.test ?? "") || x.kb_id}|${x.eye ?? ""}`],
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

/** speaker labels read aloud in the recording ("ডাক্তার … রোগী …") are not the patient's name */
const ROLE_WORD = /^(রোগী|রোগি|রুগী|ডাক্তার|ডাক্তারবাবু|ডাক্তারবাবুর|patient|rogi|rogee|doctor|মরিজ|मरीज़|मरीज|रोगी|डॉक्टर|डाक्टर|डॉक्टरसाहब)$/i;

const GREETING = /^(asun|ashun|asen|bosun|bosen|basun|bhusun|bisun|bison|namaskar|nomoskar|namaste|suprabhat|suprobhat|shubho|good|morning|evening|dr|doctor|daktar|daktarbabu|babu|sir|madam|sar|ji)$/;

const AGE_SAID = /বয়স|বয়স|বয়েস|বয়েস|বছর বয়স|উমর|উম্র|उम्र|उमर|आयु|साल का|साल की|\bage\b|\baged\b|years? old|yrs? old/i;

function patientSanity(p: Prescription, out: PostResult, heard = "") {
  const name = (p.patient.name ?? "").trim();
  if (name) {
    const words = normalize(name).split(" ").filter(Boolean);
    const raw = name.split(/[\s,.]+/).filter(Boolean);
    if (raw.length && raw.every((w) => ROLE_WORD.test(w))) {
      out.removed.push(`Patient name "${name}" (a speaker label — "patient"/"রোগী" — not the patient's name)`);
      p.patient.name = "";
    } else if (/\b(dr|doctor)\b\.?/i.test(name) || /babu/i.test(name) || (words.length && words.filter((w) => GREETING.test(w)).length >= Math.ceil(words.length / 2))) {
      out.removed.push(`Patient name "${name}" (looks like a greeting or the doctor, not the patient's name)`);
      p.patient.name = "";
    }
  }
  // an age needs age words: "সুগার বারো বছর" (diabetes for 12 years) became "Age: 12"
  if (String(p.patient.age ?? "").trim() && heard && !AGE_SAID.test(heard)) {
    out.removed.push(`Patient age "${p.patient.age}" — no age was said (the number belongs to something else)`);
    p.patient.age = "";
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

const SURGERY = /(surgery|operation|operate|phaco|sics|lasik|laser|injection|অপারেশন|অপারেশান|সার্জারি|ऑपरेशन|आपरेशन|सर्जरी|ইনজেকশন|ইন্জেকশন|ইঞ্জেকশন|इंजेक्शन)/i;

function phaseSanity(p: Prescription, text: string, out: PostResult) {
  if (p.procedures.length || SURGERY.test(text)) return;
  let n = 0;
  for (const m of p.medications) if (/(pre|post)[- ]?op/i.test(m.phase ?? "")) (m.phase = ""), n++;
  if (n) out.notes.push(`Cleared "pre-op/post-op" on ${n} medicine${n > 1 ? "s" : ""} (no surgery was discussed).`);
}

// Systemic history words as spoken in Bengali / Hindi / English consultations
const SYSTEMIC_WORDS: [RegExp, RegExp][] = [
  [/diabet|sugar|\bdm\b|glucose/i, /^(সুগার|সুগারের|ডায়াবেটিস|ডায়াবেটিস|শুগার|शुगर|मधुमेह|डायबिटीज|डायबिटीज़|sugar|diabetes|diabetic|dm)$/i],
  [/hypertens|blood pressure|\bhtn\b|\bbp\b/i, /^(প্রেশার|প্রেসার|প্রেশারও|প্রেশারের|বিপি|बीपी|प्रेशर|प्रेसर|pressure|bp|hypertension)$/i],
  [/thyro/i, /^(থাইরয়েড|থাইরয়েড|থাইরয়েডার|থাইরয়েডের|থাইরাইড|থাইরক্সিন|থাইরাক্সিন|थायराइड|थाइरॉइड|थायरॉइड|thyroid|thyroxine|eltroxin)$/i],
  [/asthma/i, /^(হাঁপানি|অ্যাজমা|এজমা|अस्थमा|दमा|asthma)$/i],
];
const OR_WORD = /^(বা|কিংবা|অথবা|या|अथवा|or)$/i;
/** words after a condition that say the patient HAS it ("সুগার আছে", "शुगर है", "BP for 5 years") */
const EXIST_WORD = /^(আছে|আছেন|আছেই|হয়েছে|হয়েছে|খাই|খাচ্ছি|নিই|ছিল|ধরে|বছর|বছরের|है|हैं|था|थी|हुआ|हुई|साल|लेता|लेती|खाता|खाती|have|has|had|since|for|years?|taking|diagnosed)$/i;

/**
 * What did the patient say about a systemic illness? Every mention is classified:
 *   no    — inside a denial ("সুগার প্রেশার নেই");
 *   asked — inside the doctor's "সুগার, প্রেশার বা থাইরয়েড আছে?" list, or followed by "?";
 *   yes   — followed by an existence word ("থাইরয়েড আছে", "BP for five years").
 * When yes and no are both heard, the LAST of them is the patient's answer (the question comes first).
 * Returns null when the condition is not one tracked here or nothing decisive was said.
 */
export function systemicAnswer(condition: string, heard: string): { answer: "yes" | "no" | "asked" | "none"; conflict: boolean } | null {
  const row = SYSTEMIC_WORDS.find(([name]) => name.test(condition));
  if (!row) return null;
  let last: "yes" | "no" | null = null;
  let yes = false, no = false, asked = false, mentions = 0;
  for (const text of heard.split("\n")) {
    if (!text.trim()) continue;
    const neg = findNegations(text);
    const toks = [...text.matchAll(/[^\s,।॥?!.;:"'()]+/g)].map((m) => ({ w: m[0], start: m.index!, end: m.index! + m[0].length }));
    toks.forEach((t, i) => {
      if (!row[1].test(t.w)) return;
      // "intraocular pressure" / "চোখের প্রেশার" / "आँख का प्रेशर" is eye pressure, not blood pressure
      if (EYE_PRESSURE_BEFORE.test(toks[i - 1]?.w ?? "") || EYE_PRESSURE_BEFORE.test(toks[i - 2]?.w ?? "")) return;
      mentions++;
      // "I am diabetic", "known case of DM", "BP-র জন্য", "for BP"
      if (!neg.some((n) => t.start >= n.start && t.end <= n.end) && toks.slice(Math.max(0, i - 2), i).some((x) => HAS_BEFORE.test(x.w))) {
        yes = true;
        last = "yes";
        return;
      }
      if (neg.some((n) => t.start >= n.start && t.end <= n.end)) {
        no = true;
        last = "no";
      } else if (toks.slice(Math.max(0, i - 2), i + 3).some((x) => OR_WORD.test(x.w)) || /^\s*\?/.test(text.slice(t.end, t.end + 3))) asked = true;
      else if (toks.slice(i + 1, i + 4).some((x) => EXIST_WORD.test(x.w))) {
        yes = true;
        last = "yes";
      }
    });
  }
  if (last) return { answer: last, conflict: yes && no };
  if (asked) return { answer: "asked", conflict: false };
  // never mentioned at all (only "intraocular pressure" said) → the model invented it
  return mentions ? null : { answer: "none", conflict: false };
}
const EYE_PRESSURE_BEFORE = /^(intraocular|eye|ocular|চোখের|চোখে|আইওপি|आँख|आंख|आँखों|आंखों|का|की|के)$/i;
const HAS_BEFORE = /^(am|i'm|known|k\/c\/o)$/i;

/** Drop complaints / systemic history the patient explicitly denied. */
function negatedItems(p: Prescription, negatedIds: Set<string>, negatedText: string, positiveIds: Set<string>, out: PostResult, heard = "") {
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
  // Systemic history: decided from the patient's answer, not from the doctor's question
  p.history.systemic = p.history.systemic.filter((h) => {
    const said = heard ? systemicAnswer(h.condition ?? "", heard) : null;
    if (!said) return keepRow(h);
    if (said.answer === "none") {
      out.removed.push(`History "${h.condition}" — never mentioned in the conversation`);
      return false;
    }
    if (said.answer === "asked") {
      out.removed.push(`History "${h.condition}" — only the doctor's question mentions it; the patient did not say they have it`);
      return false;
    }
    if (said.answer === "no") {
      out.removed.push(`History "${h.condition}" — the patient said they do NOT have it`);
      if (said.conflict) out.flags.push(`History "${h.condition}" — heard as both present and absent; the patient's last answer was "no" — confirm`);
      return false;
    }
    if (said.conflict) out.flags.push(`History "${h.condition}" — heard as both present and absent; the patient's last answer was "yes" — confirm`);
    return true;
  });
  function keepRow(h: any) {
    if (!isNeg(h.kb_id ?? "", h.condition ?? "")) return true;
    out.removed.push(`History "${h.condition}" — the patient said they do NOT have it`);
    return false;
  }
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

// ---------------------------------------------------------------------------------------------
// Checks added after the Bengali test runs of Oct 2026 (script 9 / glaucoma-cataract recording):
// "No known drug allergy" when allergy was never discussed, IOP left "8" for «আঠেরো», no IOP method/time,
// examination findings printed twice, the follow-up printed in Advice and Review, family history with an eye side,
// and an anti-VEGF injection that was advised but never reached the prescription.
// ---------------------------------------------------------------------------------------------
const ALLERGY_SAID = /allerg|অ্যালার্জি|অ্যালার্জি|এলার্জি|অ্যালার্জী|এ্যালার্জি|एलर्जी|ऐलर्जी|एलर्जि|sulfa|সালফা|सल्फा|reaction to/i;

/** Allergy status only when allergy was talked about. */
function allergySanity(p: Prescription, heard: string, out: PostResult) {
  if (ALLERGY_SAID.test(heard)) return;
  if (p.history.allergy_status === "none known" || p.history.allergy_status === "present" || p.history.allergies.length) {
    out.removed.push(`Allergy status "${p.history.allergies.join(", ") || p.history.allergy_status}" — allergy was not discussed in the conversation`);
    p.history.allergy_status = "not discussed";
    p.history.allergies = [];
  }
}

const IOP_TEST = /pressure|\biop\b|tonometr|intraocular|\bnct\b|applanation/i;
const VA_TEST = /acuity|vision|\bva\b|ucva|bcva|pinhole|snellen/i;
const IOP_METHODS: [string, RegExp][] = [
  ["NCT", /\bnct\b|এনসিটি|এন সি টি|নন ?কন্ট্যাক্ট|non.?contact|एनसीटी|एन सी टी|नॉन ?कॉन्टैक्ट|air.?puff/i],
  ["AT", /applanation|অ্যাপ্লানেশন|এপ্লানেশন|অ্যাপলানেশন|goldmann|গোল্ডম্যান|गोल्डमैन|एप्लानेशन|अप्लानेशन|\bGAT\b/i],
  ["RT", /rebound|icare|আইকেয়ার|রিবাউন্ড|रिबाउंड|आईकेयर/i],
];
/** "সকাল এগারোটায়" / "सुबह दस बजे" / "at ten thirty" / "at 10:30" → "11 am" / "10 am" / "10:30" */
function iopTime(heard: string): string {
  const d = heard.match(/\b(?:at\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i);
  if (d && Number(d[1]) < 24 && Number(d[2]) < 60) return `${d[1]}:${d[2]}${d[3] ? ` ${d[3].toLowerCase()}` : ""}`;
  const m = heard.match(/(সকাল|বিকেল|বিকাল|দুপুর|সন্ধ্যা|সন্ধে|রাত|सुबह|दोपहर|शाम|रात)\s+(\S+?)(?:টায়|টায়|টা|টার|টে)?(?:\s+(বেজে|बजे))?(?=[\s,।.]|$)/);
  if (m) {
    const n = [...allNumberValues(m[2])].find((x) => x >= 1 && x <= 12);
    if (n !== undefined) {
      const pm = /বিকেল|বিকাল|সন্ধ্যা|সন্ধে|রাত|शाम|रात/.test(m[1]) || (/দুপুর|दोपहर/.test(m[1]) && n < 6);
      return `${n} ${pm ? "pm" : "am"}`;
    }
  }
  const e = heard.match(/\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(thirty|fifteen|forty.?five|o'?clock))?\b/i);
  if (e) {
    const n = [...allNumberValues(e[1])][0];
    const mm = e[2] ? (/thirty/i.test(e[2]) ? "30" : /fifteen/i.test(e[2]) ? "15" : /forty/i.test(e[2]) ? "45" : "00") : "00";
    if (n) return `${n}:${mm}`;
  }
  return "";
}

/** Examination values that were never said are removed; IOP rows get the method and time that were said. */
function examinationSanity(p: Prescription, heard: string, out: PostResult) {
  const said = allNumberValues(heard);
  p.examination = p.examination.filter((e) => {
    // "Dynamic retinoscopy: (nothing)" — a test named without any result is not an examination finding
    if (!String(e.result ?? "").trim() && !IOP_TEST.test(e.test) && !VA_TEST.test(e.test)) {
      out.notes.push(`"${e.test}"${e.eye ? ` (${e.eye})` : ""} left out of the examination: no result was said.`);
      return false;
    }
    if (!IOP_TEST.test(e.test) && !VA_TEST.test(e.test)) return true;
    // "we'll check your vision / pressure" is a plan, not a result: no value → no row ("Normal" here was invented)
    if (!/\d|\b(cf|fc|hm|hmcf|pl|npl|pr|nlp|counting fingers?|hand movements?|perception of light|no perception)\b|[০-৯०-९]/i.test(e.result ?? "")) {
      out.removed.push(`${e.test}${e.eye ? ` (${e.eye})` : ""}${e.result ? ` "${e.result}"` : ""} — no value was said for it`);
      return false;
    }
    const nums = (e.result.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    const missing = nums.filter((n) => !said.has(n));
    if (!missing.length) return true;
    out.removed.push(`${e.test}${e.eye ? ` (${e.eye})` : ""} "${e.result}" — ${missing.join(", ")} was not said in the conversation`);
    return false;
  });
  const iop = p.examination.filter((e) => IOP_TEST.test(e.test));
  if (!iop.length) return;
  const methods = IOP_METHODS.filter(([, re]) => re.test(heard)).map(([m]) => m);
  // the time is looked for only right after the eye-pressure / method words, not anywhere (drop timings)
  const ANCHOR = /চোখের প্রেশার|চোখের চাপ|eye pressure|pressure by|\biop\b|intraocular|tonometr|आँख का प्रेशर|आंख का प्रेशर|आँखों का प्रेशर|\bnct\b|এনসিটি|এন সি টি|एनसीटी|एन सी टी|applanation|অ্যাপ্লানেশন|एप्लानेशन/gi;
  let time = "";
  for (const a of heard.matchAll(ANCHOR)) {
    time = iopTime(heard.slice(a.index!, a.index! + 140));
    if (time) break;
  }
  const OTHER_TONO = /schi[oø]tz|tono.?pen|perkins|indentation/i;
  for (const e of iop) {
    // a tonometer named in the test that is not the one said ("Schiøtz / iCare / Tono-Pen tonometry" for an NCT reading)
    const named = IOP_METHODS.filter(([, re]) => re.test(e.test)).map(([m]) => m);
    if ((named.length && named.some((m) => !methods.includes(m))) || (OTHER_TONO.test(e.test) && !OTHER_TONO.test(heard))) {
      out.notes.push(`"${e.test}" → "Intraocular pressure": that tonometer was not said.`);
      e.test = "Intraocular pressure";
    }
    // a method the model wrote that nobody said ("(NCT)" copied from an example) is taken out
    for (const [m] of IOP_METHODS)
      if (!methods.includes(m) && new RegExp(`\\(\\s*${m}\\s*\\)|\\b${m}\\b`).test(e.test)) {
        e.test = e.test.replace(new RegExp(`\\s*\\(\\s*${m}\\s*\\)|\\s*\\b${m}\\b`), "").trim();
        out.notes.push(`IOP method "${m}" removed: the method was not said.`);
      }
    const has = IOP_METHODS.some(([m, re]) => re.test(e.test) || re.test(e.result) || new RegExp(`\\b${m}\\b`).test(`${e.test} ${e.result}`));
    if (!has && methods.length === 1) e.test = `${e.test} (${methods[0]})`;
    if (time && !/\d{1,2}[:.]\d{2}|\b(am|pm)\b/i.test(e.result)) e.result = `${e.result}${/mm ?hg/i.test(e.result) ? "" : " mmHg"} at ${time}`.trim();
  }
}

const INDIC = /[\u0900-\u09FF]/g;
/** The doctor's own plan for the next visit ("প্রেশার দেখব" = I will check the pressure) is not advice to the patient. */
const DOCTOR_PLAN = /(দেখব|দেখবো|মাপব|মাপবো|করব|করবো|দেখে নেব)\s*[।.]?$|देखेंगे|देखूंगा|देखूँगा|जांचेंगे|\b(i|we)('ll| will) (check|see|recheck|measure)\b/i;

/** Advice in English, and the doctor's next-visit plan moved to Review. */
function adviceSanity(p: Prescription, kb: KnowledgeBase, out: PostResult) {
  const counselling = { ...kb, terms: kb.terms.filter((t) => t.category === "counselling") };
  p.advice = p.advice.filter((a) => {
    const text = a.text.trim();
    if (DOCTOR_PLAN.test(text)) {
      const raw = text.replace(/[।.]$/, "");
      const plan = /প্রেশার|প্রেসার|प्रेशर|pressure/i.test(raw) ? "Recheck eye pressure" : /দৃষ্টি|नज़र|नजर|vision/i.test(raw) ? "Recheck vision" : raw;
      if (p.follow_up.length) {
        if (!(p.follow_up[0].purpose ?? "").includes(plan)) p.follow_up[0].purpose = [p.follow_up[0].purpose, plan].filter(Boolean).join("; ");
      }
      else p.follow_up.push({ when: "", purpose: plan });
      out.notes.push(`"${text}" is the doctor's plan for the next visit — moved from Advice to Review.`);
      return false;
    }
    const indic = (text.match(INDIC) ?? []).length;
    const letters = (text.match(/\p{L}/gu) ?? []).length || 1;
    if (indic / letters > 0.3) {
      const hit = (a.kb_id && kb.terms.find((t) => t.id === a.kb_id && t.category === "counselling")) || findMatches(text, counselling).filter((m) => m.score >= 0.8)[0]?.term;
      if (hit) {
        out.notes.push(`Advice "${text}" written in English from the vocabulary: "${hit.name}".`);
        a.text = hit.name;
      } else out.flags.push(`Advice "${text}" was not written in English — rewrite it before signing`);
    }
    return true;
  });
}

const MACULA_SAID = /macula|ম্যাকুলা|ম্যাকুলার|মেকুলা|मैक्युला|मैकुला|मैक्यूला/i;

/** "OCT of macula" when the doctor only said "OCT" (a glaucoma visit needs OCT RNFL, not macula). */
function investigationSanity(p: Prescription, heard: string, out: PostResult) {
  if (MACULA_SAID.test(heard)) return;
  for (const t of p.investigations)
    if (/\boct\b|optical coherence/i.test(t.test) && /macula/i.test(t.test)) {
      const was = t.test;
      t.test = t.test.replace(/\s*(\(|-|–)?\s*(of\s+(the\s+)?)?macula(r)?\s*\)?/i, "").trim();
      out.notes.push(`"${was}" → "${t.test}": macula was not said.`);
    }
  for (const t of p.investigations)
    if (/\boct\b|optical coherence/i.test(t.test) && /macula/i.test(t.purpose ?? "")) {
      t.purpose = t.purpose.replace(/\b(the\s+)?macula(r)?(\s+(and|&)\s+)?|(\s+(and|&)\s+)?(the\s+)?macula(r)?\b/i, "").replace(/\s+/g, " ").trim();
      if (/^(assessment|assess|evaluation|evaluate|to assess|to evaluate)( of)?$/i.test(t.purpose)) t.purpose = "";
    }
}

/** One line per fact: findings already printed as an examination result or a diagnosis are not repeated. */
function layoutSanity(p: Prescription, out: PostResult, heardAll = "") {
  const spell = (s: string) =>
    normalize(s).replace(/oedema/g, "edema").replace(/haemorrh/g, "hemorrh").replace(/\b(in|of|the|right|left|both|eye|eyes|re|le|be)\b/g, " ").replace(/\s+/g, " ").trim();
  const covered = (text: string, eye: string) => {
    const n = spell(text);
    if (n.length < 4) return false;
    const inExam = p.examination.some((e) => (e.eye === eye || e.eye === "BE" || !eye || !e.eye) && spell(e.result).includes(n));
    const inDx = p.diagnosis.some((d) => spell(`${d.grade_or_notes} ${d.condition}`).includes(n) || spell(`${d.condition} ${d.grade_or_notes}`).includes(n));
    // "Moderate NPDR with CSME" when the diagnosis already says "NPDR (Moderate)" + "Macular oedema"
    const dxText = ` ${spell(p.diagnosis.map((d) => `${d.condition} ${d.grade_or_notes}`).join(" "))} `;
    const words = n.split(" ").filter((w) => w.length >= 3 && !/^(with|and|the|both|eye|eyes)$/.test(w));
    const mostlyDx = p.diagnosis.length > 0 && words.length >= 2 && words.filter((w) => dxText.includes(` ${w} `)).length / words.length >= 0.6;
    return inExam || inDx || mostlyDx;
  };
  const complaintNames = p.chief_complaints.map((c) => spell(c.complaint ?? "")).filter(Boolean);
  const before = p.clinical_findings.length;
  // a symptom copied into the findings ("Headache", "Coloured haloes") is not an examination finding
  p.clinical_findings = p.clinical_findings.filter((f) => !covered(f.finding, f.eye) && !complaintNames.includes(spell(f.finding ?? "")));
  if (before !== p.clinical_findings.length) out.notes.push(`Removed ${before - p.clinical_findings.length} finding${before - p.clinical_findings.length > 1 ? "s" : ""} already shown in the examination or diagnosis.`);

  // Follow-up belongs in Review, not Advice
  const FOLLOW = /^(come back|come again|review|follow.?up|revisit|see me|return)\b|^(come|return|visit)\b.*\b(after|in|within|next)\b|\bfollow.?up (after|in|visit)\b|আবার (আসবেন|দেখাবেন|আসুন)|फिर (आइए|आना|दिखाइए)|दोबारा आ/i;
  const followAdvice = p.advice.filter((a) => FOLLOW.test(a.text.trim()));
  if (followAdvice.length) {
    if (!p.follow_up.length) p.follow_up = followAdvice.map((a) => ({ when: a.text.replace(/^(come back|come again|review|follow.?up|revisit|return)\s*(after|in)?\s*/i, "").trim() || a.text, purpose: "" }));
    p.advice = p.advice.filter((a) => !followAdvice.includes(a));
    out.notes.push("Follow-up moved from Advice to Review.");
  }

  // "এক মাস পরে আবার আসবেন, প্রেশার দেখব" — the doctor's reason for the next visit
  if (p.follow_up.length && !p.follow_up[0].purpose && /(প্রেশার|প্রেসার|pressure|प्रेशर)\s*(দেখব|দেখবো|মাপব|check|recheck|देखेंगे|देखूंगा|चेक)/i.test(heardAll)) p.follow_up[0].purpose = "Recheck eye pressure";

  // Family history is not about the patient's eyes
  for (const h of p.history.ocular) if (/family|mother|father|sibling|brother|sister|মা|বাবা|माँ|पिता/i.test(h.item)) h.eye = "";
}

const CONDITIONAL = /\bif\b|\bin case\b|\bunless\b|\bshould (it|the|this)\b|considered if|যদি|হলে তবে|हो जाए तो|अगर|यदि|अगर .* तो/i;

const NOT_NEEDED = /not (required|indicated|needed|necessary|advised)|no need|প্রয়োজন নেই|প্রয়োজন নেই|দরকার নেই|লাগবে না|দিতে হবে না|ज़रूरत नहीं|जरूरत नहीं|आवश्यकता नहीं|नहीं चाहिए/i;

/** "Intravitreal injection — not required currently": what the doctor said is NOT needed is not advised or prescribed. */
function notNeeded(p: Prescription, out: PostResult) {
  const drop = <T extends { evidence?: string }>(rows: T[], note: (x: T) => string, label: (x: T) => string) =>
    rows.filter((x) => {
      if (!NOT_NEEDED.test(`${note(x)} ${x.evidence ?? ""}`)) return true;
      out.removed.push(`${label(x)} — the doctor said it is not needed`);
      return false;
    });
  p.procedures = drop(p.procedures, (x) => x.notes ?? "", (x) => `Procedure "${x.procedure}"`);
  p.medications = drop(p.medications, (x) => x.instructions ?? "", (x) => `Medicine "${x.generic_name || x.brand_said}"`);
  p.investigations = drop(p.investigations, (x) => x.purpose ?? "", (x) => `Investigation "${x.test}"`);
}

/** "Photodynamic therapy if it turns wet": a procedure for a future "if" is not advised today — it becomes advice. */
function conditionalProcedures(p: Prescription, out: PostResult) {
  p.procedures = p.procedures.filter((x) => {
    const cond = CONDITIONAL.test(x.notes ?? "") ? x.notes : CONDITIONAL.test(x.evidence ?? "") ? x.evidence : "";
    if (!cond) return true;
    const text = `${x.procedure}${x.eye ? ` (${x.eye})` : ""} — only ${CONDITIONAL.test(x.notes ?? "") ? x.notes.replace(/^(to be )?(considered )?/i, "").replace(/^./, (c) => c.toLowerCase()) : "if the condition changes, as discussed"}`;
    p.advice.push({ text, kb_id: "", evidence: x.evidence ?? "" });
    out.notes.push(`"${x.procedure}" is planned only if something happens — moved from Procedure advised to Advice.`);
    return false;
  });
}

/** Two advice lines quoting the same words are the same advice said twice. */
function adviceDuplicates(p: Prescription, out: PostResult) {
  const seen: string[] = [];
  const before = p.advice.length;
  p.advice = p.advice.filter((a) => {
    const ev = normalize(a.evidence ?? "");
    // the same quote exactly (one sentence can carry two different pieces of advice, so containment is not enough)
    if (ev.length >= 6 && seen.includes(ev)) return false;
    if (ev) seen.push(ev);
    return true;
  });
  if (before !== p.advice.length) out.notes.push(`Removed ${before - p.advice.length} advice line(s) that repeated the same spoken advice.`);
}

/** "Latanoprost — ABR-068": a knowledge-base id written into a medicine field is replaced by what it stands for. */
function medicineFieldIds(p: Prescription, kb: KnowledgeBase, out: PostResult) {
  const byId = new Map(kb.terms.map((t) => [t.id, t]));
  for (const m of p.medications)
    for (const k of ["frequency", "dose", "duration", "strength", "form", "instructions"] as const) {
      const v = String((m as any)[k] ?? "").trim();
      if (!/^[A-Z]{3}-\d{3}$/.test(v)) continue;
      const t = byId.get(v);
      const name = t ? (t.aliases.find((a) => a.length <= 6 && /^[A-Z.]+$/.test(a)) ?? t.name) : "";
      (m as any)[k] = name;
      out.flags.push(`${m.generic_name || "Medicine"}: the ${k} came back as a code (${v})${name ? ` — written as "${name}"` : ""}; check it against the recording`);
    }
}

/** "Current medications: Diabetes mellitus, Hypertension" — conditions are not medicines. */
function currentMedsSanity(p: Prescription, kb: KnowledgeBase, out: PostResult) {
  const conditions = p.history.systemic.map((h) => normalize(h.condition ?? "")).filter(Boolean);
  const nonMed = kb.terms.filter((t) => t.category !== "medicine");
  const before = p.history.current_medications.length;
  p.history.current_medications = p.history.current_medications.filter((m) => {
    const n = normalize(m);
    if (!n) return false;
    if (conditions.some((c) => c === n || c.includes(n) || n.includes(c))) return false;
    if (/^(diabetes|hypertension|thyroid|hypothyroidism|asthma|sugar|bp|blood pressure)\b/i.test(m)) return false;
    return !nonMed.some((t) => t.category !== "medicine" && [t.name, ...t.aliases].some((a) => normalize(a) === n) && !kb.terms.some((x) => x.category === "medicine" && normalize(x.name) === n));
  });
  if (before !== p.history.current_medications.length) out.notes.push("Removed conditions listed as current medications.");
}

const PLAN = /দিতে হবে|দিতে হবেই|করতে হবে|করাতে হবে|করাব|করব|করে দেব|দেওয়া হবে|দেব|নিতে হবে|লাগবে|will (do|give|need)|need(s)? (an? )?|advis|plan|schedule|करेंगे|करना होगा|करवाना|लगेगा|लगाना होगा|देंगे/i;
const PAST = /হয়েছিল|হয়েছিল|করা হয়েছিল|করেছিলাম|আগে|ago|previous|earlier|had (a|an)? ?|हुआ था|हुई थी|करवाया था|पहले/i;

/** A KB procedure the doctor ADVISED (plan words right after it) that the model left out is added, flagged for checking. */
function procedureFallback(p: Prescription, heard: string, kb: KnowledgeBase, positiveIds: Set<string>, out: PostResult) {
  const have = new Set(p.procedures.map((x) => x.kb_id).filter(Boolean));
  const haveNames = p.procedures.map((x) => normalize(x.procedure));
  for (const t of kb.terms) {
    if (t.category !== "procedure" || !positiveIds.has(t.id) || have.has(t.id)) continue;
    if (haveNames.some((n) => [t.name, ...t.aliases].some((a) => n.includes(normalize(a)) || normalize(a).includes(n)))) continue;
    // where it was said: an eye-lexicon phrase ("অ্যান্টিভিইজিএফ ইন্জেকশন") or the KB name itself
    const lexHit = scanLexicon(heard, kb).find((h) => h.term?.id === t.id && h.start >= 0);
    const kbHit = lexHit ? null : findMatches(heard, { ...kb, terms: [t] }).filter((x) => x.score >= 0.85)[0];
    const heardAs = lexHit ? lexHit.heard : kbHit?.heardAs ?? "";
    const at = lexHit ? lexHit.start : heardAs ? heard.indexOf(heardAs) : -1;
    if (at < 0) continue;
    const after = heard.slice(at, at + heardAs.length + 45);
    const before = heard.slice(Math.max(0, at - 40), at);
    if (!PLAN.test(after) || PAST.test(after)) continue;
    const eye = /ডান|right|दाईं|दायीं|दाहिनी/i.test(before) ? "RE" : /বাম|বাঁ|left|बाईं|बायीं/i.test(before) ? "LE" : "";
    p.procedures.push({ procedure: t.name, kb_id: t.id, eye, notes: "", evidence: (before.split(/\s+/).slice(-3).join(" ") + " " + after).trim() } as any);
    out.flags.push(`Procedure "${t.name}"${eye ? ` (${eye})` : ""} was advised in the conversation but missing from the model's draft — added; confirm it`);
  }
}

// ---------------------------------------------------------------------------------------------
// Bench round 3 (Bedrock 32B): IOP values said but put nowhere ("Non-contact tonometry" listed as a test to order),
// clinic examinations listed as investigations, complaints the model dropped although the words were clearly said.
// ---------------------------------------------------------------------------------------------
const IOP_ANCHOR = /প্রেশার|প্রেসার|চাপ|pressure|\biop\b|\bnct\b|এনসিটি|এনসিটিতে|tonometr|टोनोमेट्री|प्रेशर|एनसीटी/i;
const RIGHT_EYE = /^(ডান|ডানে|ডানদিকের|right|দাঈ|दाईं|दायीं|दाहिनी|दाएं|दाईं|दायें)$/i;
const LEFT_EYE = /^(বাম|বাঁ|বামে|বামচোখে|left|बाईं|बायीं|बाएं|बायें)$/i;

/** Eye pressures said as "প্রেশার … ডান ষোলো বাঁ ছাব্বিশ" / "प्रेशर … दाईं चौदह, बाईं पंद्रह" when the model put no IOP row. */
function iopFallback(p: Prescription, heard: string, out: PostResult) {
  if (p.examination.some((e) => IOP_TEST.test(e.test))) return;
  const toks = heard.split(/[\s,।.?!;:()"'“”‘’]+/).filter(Boolean);
  const valueAt = (i: number) => {
    for (let j = i + 1; j <= i + 3 && j < toks.length; j++) {
      if (RIGHT_EYE.test(toks[j]) || LEFT_EYE.test(toks[j])) return null;
      const vals = [...allNumberValues(toks[j])].filter((n) => n >= 5 && n <= 70 && Number.isInteger(n));
      if (vals.length === 1) return { n: vals[0], end: j };
    }
    return null;
  };
  for (let a = 0; a < toks.length; a++) {
    if (!IOP_ANCHOR.test(toks[a])) continue;
    const found: { eye: "RE" | "LE"; n: number; from: number; to: number }[] = [];
    for (let i = a + 1; i < Math.min(toks.length, a + 14); i++) {
      const eye = RIGHT_EYE.test(toks[i]) ? "RE" : LEFT_EYE.test(toks[i]) ? "LE" : null;
      if (!eye || found.some((f) => f.eye === eye)) continue;
      const v = valueAt(i);
      if (v) found.push({ eye, n: v.n, from: i, to: v.end });
    }
    if (found.length === 2) {
      for (const f of found) {
        p.examination.push({ test: "Intraocular pressure", kb_id: "", eye: f.eye, result: `${f.n} mmHg`, evidence: toks.slice(a, f.to + 1).join(" ") } as any);
        out.flags.push(`IOP ${f.eye} ${f.n} mmHg was said but missing from the model's draft — added from «${toks.slice(f.from, f.to + 1).join(" ")}»; check it`);
      }
      return;
    }
  }
}

const CLINIC_TEST = /snellen|visual acuity|slit.?lamp|biomicroscop|ophthalmoscop|tonometr|\bnct\b|applanation|retinoscop|\brefraction\b/i;

/** Examinations done in the clinic are not investigations to order. */
function clinicTestsNotInvestigations(p: Prescription, out: PostResult) {
  const before = p.investigations.map((t) => t.test);
  p.investigations = p.investigations.filter((t) => !CLINIC_TEST.test(t.test) || /photo|oct|angiograph|ffa|field|perimetr|biometr|scan/i.test(t.test));
  const gone = before.filter((t) => !p.investigations.some((x) => x.test === t));
  if (gone.length) out.notes.push(`Not investigations (examined in the clinic): ${[...new Set(gone)].join(", ")}.`);
}

/** Eye symptoms the vocabulary has no entry for, in English / Bengali / Hindi */
const EXTRA_SYMPTOMS: [string, RegExp][] = [
  ["Metamorphopsia (distorted vision)", /metamorphops|distort|wavy lines|lines look (bent|wavy|crooked)|বাঁকা দেখ|খাপছাড়া|টেরা বাঁকা|टेढ़ा दिख|टेढ़ी दिख|लहरदार/i],
  ["Photopsia (flashes of light)", /photops|flashes of light|flashing lights|আলোর ঝলক|ঝলকানি|चमक दिख|रोशनी की चमक/i],
  ["Asthenopia (eye strain)", /asthenop|eye strain|eyes? (feel )?tired|চোখের ক্লান্তি|চোখ ক্লান্ত|आँखों में थकान|आंखों में थकान/i],
];

/** Symptoms clearly said in the patient's words (eye-lexicon phrase or exact vocabulary term, not denied) that no complaint covers. */
function symptomBackfill(p: Prescription, heard: string, kb: KnowledgeBase, out: PostResult) {
  const neg = findNegations(heard);
  const inNeg = (start: number, end: number) => neg.some((n) => start >= n.start && end <= n.end);
  // the patient's quote is not counted: "metamorphopsia" sitting only inside a quoted sentence is not a listed complaint
  const lines = p.chief_complaints.map((c) => normalize(`${c.complaint} ${c.character}`)).join(" | ");
  const have = new Set(p.chief_complaints.map((c) => c.kb_id).filter(Boolean));
  const seen = new Set<string>();
  const add = (t: Term, quote: string) => {
    if (seen.has(t.id) || have.has(t.id)) return;
    seen.add(t.id);
    const key = normalize(t.name).split(" ").filter((w) => w.length >= 4 && !/^(vision|sensation|with|from|both|eyes?)$/.test(w));
    if (key.length && key.some((w) => lines.includes(w.slice(0, 5)))) return;
    p.chief_complaints.push({ complaint: t.name, kb_id: t.id, eye: "", duration: "", character: "", patient_words: quote, evidence: quote });
    out.flags.push(`Complaint "${t.name}" was said («${quote}») but missing from the model's draft — added; confirm it`);
  };
  // the doctor's own lines are questions and explanations, not complaints ("Any headache or vomiting?")
  const doctorSpans = [...heard.matchAll(/^\s*(doctor|dr\.?|ডাক্তার|ডাঃ|डॉक्टर|डॉ\.?)\s*[:：].*$/gimu)].map((m) => [m.index!, m.index! + m[0].length]);
  const byDoctor = (at: number) => doctorSpans.some(([a, b]) => at >= a && at < b);
  // a symptom denied anywhere in the visit is never added
  const denied = new Set<string>();
  const hits: { term: Term; quote: string; at: number; end: number }[] = [];
  for (const h of scanLexicon(heard, kb)) if (h.term?.category === "symptom" && h.start >= 0) hits.push({ term: h.term, quote: h.heard, at: h.start, end: h.end });
  const symptoms = { ...kb, terms: kb.terms.filter((t) => t.category === "symptom") };
  for (const m of findMatches(heard, symptoms).filter((x) => x.kind === "exact" && x.score >= 0.95)) {
    let at = heard.indexOf(m.heardAs);
    while (at >= 0) {
      hits.push({ term: m.term, quote: m.heardAs, at, end: at + m.heardAs.length });
      at = heard.indexOf(m.heardAs, at + 1);
    }
  }
  for (const h of hits) if (inNeg(h.at, h.end)) denied.add(h.term.id);
  for (const h of hits) if (!denied.has(h.term.id) && !byDoctor(h.at)) add(h.term, h.quote);
  for (const [name, re] of EXTRA_SYMPTOMS) {
    const m = re.exec(heard);
    if (!m || byDoctor(m.index) || inNeg(m.index, m.index + m[0].length)) continue;
    add({ id: `X-${name}`, name, category: "symptom", aliases: [], colloquial: [], details: {} } as Term, m[0]);
  }
}

const HAS_INDIC = /[\u0900-\u09FF]/;
const UNITS: [RegExp, string][] = [
  [/মাস|মাসের|महीन|महिन|month/i, "month"],
  [/সপ্তাহ|হপ্তা|हफ्त|हफ़्त|सप्ताह|week/i, "week"],
  [/দিন|दिन|day/i, "day"],
  [/বছর|साल|वर्ष|year/i, "year"],
];

const SYSTEMIC_DRUGS: [RegExp, string][] = [
  [/থাইরক্সিন|থাইরাক্সিন|থাইরোক্সিন|এলট্রক্সিন|थायरोक्सिन|थाइरोक्सिन|थायरॉक्सिन|एल्ट्रोक्सिन/, "Thyroxine"],
  [/মেটফর্?মিন|मेटफॉर्मिन|मेटफार्मिन/, "Metformin"],
  [/অ্যামলোডিপি|এমলোডিপি|আমলোডিপি|एम्लोडिपि|एमलोडिपि|अम्लोडिपि/, "Amlodipine"],
  [/টেলমিসার্টান|टेल्मिसार्टन|टेलमिसार्टन/, "Telmisartan"],
  [/লোসার্টান|लोसार्टन/, "Losartan"],
  [/অ্যাটেনোলল|এটেনোলল|एटेनोलोल/, "Atenolol"],
  [/ইনসুলিন|इंसुलिन|इन्सुलिन/, "Insulin"],
  [/গ্লিমেপিরাইড|ग्लिमेपिराइड/, "Glimepiride"],
  [/অ্যাসপিরিন|এসপিরিন|एस्पिरिन/, "Aspirin"],
  [/অ্যাটরভাস্টাটিন|এটরভাস্টাটিন|एटोरवास्टेटिन/, "Atorvastatin"],
];

/** "দেড় মাস পরে" → "1.5 months"; "থাইরক্সিন" → "Thyroxine": fields printed on the prescription are written in English. */
function englishFields(p: Prescription, kb: KnowledgeBase, out: PostResult) {
  for (const f of p.follow_up) {
    if (!HAS_INDIC.test(f.when ?? "")) continue;
    const unit = UNITS.find(([re]) => re.test(f.when))?.[1];
    const n = [...allNumberValues(f.when)].filter((x) => x > 0 && x < 100).sort((a, b) => (Number.isInteger(a) ? 1 : 0) - (Number.isInteger(b) ? 1 : 0))[0];
    if (unit && n !== undefined) {
      const was = f.when;
      f.when = `${n} ${unit}${n === 1 ? "" : "s"}`;
      out.notes.push(`Review "${was}" written as "${f.when}".`);
    }
  }
  const meds = { ...kb, terms: kb.terms.filter((t) => t.category === "medicine") };
  const english = (x: string) => {
    if (!HAS_INDIC.test(x)) return x;
    // common systemic medicines (not in the eye vocabulary)
    const sys = SYSTEMIC_DRUGS.find(([re]) => re.test(x));
    if (sys) return sys[1];
    const hit = findMatches(x, meds, { fuzzyMinIndic: 0.7, fuzzyMinLatin: 0.8 })[0]?.term;
    return hit ? hit.name.replace(/\s*\(.*\)$/, "") : x;
  };
  for (const h of p.history.systemic) if (h.treatment) h.treatment = english(h.treatment);
  p.history.current_medications = p.history.current_medications.map(english);
  for (const x of [...p.history.systemic.map((h) => h.treatment), ...p.history.current_medications])
    if (x && HAS_INDIC.test(x)) out.flags.push(`"${x}" is not written in English — rewrite it before signing`);
}

export function postProcess(
  p: Prescription,
  ctx: { heardText: string; kb: KnowledgeBase; negatedIds: Set<string>; negatedText: string; positiveIds: Set<string> },
): PostResult {
  const out: PostResult = { removed: [], notes: [], flags: [] };
  medicinesHeard(p, ctx.heardText, ctx.kb, out, ctx.positiveIds);
  negatedItems(p, ctx.negatedIds, ctx.negatedText, ctx.positiveIds, out, ctx.heardText);
  allergySanity(p, ctx.heardText, out);
  iopFallback(p, ctx.heardText, out);
  examinationSanity(p, ctx.heardText, out);
  procedureFallback(p, ctx.heardText, ctx.kb, ctx.positiveIds, out);
  patientSanity(p, out, ctx.heardText);
  currentMedsSanity(p, ctx.kb, out);
  medicineFieldIds(p, ctx.kb, out);
  phaseSanity(p, ctx.heardText, out);
  subtypeCheck(p, ctx.heardText, out);
  systemicEye(p);
  fieldSanity(p, ctx.heardText, out);
  evidenceCheck(p, ctx.heardText, out);
  notNeeded(p, out);
  conditionalProcedures(p, out);
  layoutSanity(p, out, ctx.heardText);
  adviceDuplicates(p, out);
  investigationSanity(p, ctx.heardText, out);
  clinicTestsNotInvestigations(p, out);
  adviceSanity(p, ctx.kb, out);
  symptomBackfill(p, ctx.heardText, ctx.kb, out);
  englishFields(p, ctx.kb, out);
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
