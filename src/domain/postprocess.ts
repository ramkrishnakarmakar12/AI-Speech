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

/** speaker labels read aloud in the recording ("ডাক্তার … রোগী …") are not the patient's name */
const ROLE_WORD = /^(রোগী|রোগি|রুগী|ডাক্তার|ডাক্তারবাবু|ডাক্তারবাবুর|patient|rogi|rogee|doctor|মরিজ|मरीज़|मरीज|रोगी|डॉक्टर|डाक्टर|डॉक्टरसाहब)$/i;

const GREETING = /^(asun|ashun|asen|bosun|bosen|basun|bhusun|bisun|bison|namaskar|nomoskar|namaste|suprabhat|suprobhat|shubho|good|morning|evening|dr|doctor|daktar|daktarbabu|babu|sir|madam|sar|ji)$/;

function patientSanity(p: Prescription, out: PostResult) {
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
export function systemicAnswer(condition: string, heard: string): { answer: "yes" | "no" | "asked"; conflict: boolean } | null {
  const row = SYSTEMIC_WORDS.find(([name]) => name.test(condition));
  if (!row) return null;
  let last: "yes" | "no" | null = null;
  let yes = false, no = false, asked = false;
  for (const text of heard.split("\n")) {
    if (!text.trim()) continue;
    const neg = findNegations(text);
    const toks = [...text.matchAll(/[^\s,।॥?!.;:"'()]+/g)].map((m) => ({ w: m[0], start: m.index!, end: m.index! + m[0].length }));
    toks.forEach((t, i) => {
      if (!row[1].test(t.w)) return;
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
  return asked ? { answer: "asked", conflict: false } : null;
}

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
    if (!IOP_TEST.test(e.test) && !VA_TEST.test(e.test)) return true;
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
  for (const e of iop) {
    const has = IOP_METHODS.some(([m, re]) => re.test(e.test) || re.test(e.result) || new RegExp(`\\b${m}\\b`).test(`${e.test} ${e.result}`));
    if (!has && methods.length === 1) e.test = `${e.test} (${methods[0]})`;
    if (time && !/\d{1,2}[:.]\d{2}|\b(am|pm)\b/i.test(e.result)) e.result = `${e.result}${/mm ?hg/i.test(e.result) ? "" : " mmHg"} at ${time}`.trim();
  }
}

/** One line per fact: findings already printed as an examination result or a diagnosis are not repeated. */
function layoutSanity(p: Prescription, out: PostResult) {
  const covered = (text: string, eye: string) => {
    const n = normalize(text);
    if (n.length < 4) return false;
    const inExam = p.examination.some((e) => (e.eye === eye || e.eye === "BE" || !eye || !e.eye) && normalize(e.result).includes(n));
    const inDx = p.diagnosis.some((d) => normalize(`${d.grade_or_notes} ${d.condition}`).includes(n) || normalize(`${d.condition} ${d.grade_or_notes}`).includes(n));
    // "Moderate NPDR with CSME" when the diagnosis already says "NPDR (Moderate)" + "Macular oedema"
    const dxText = ` ${normalize(p.diagnosis.map((d) => `${d.condition} ${d.grade_or_notes}`).join(" "))} `;
    const words = n.split(" ").filter((w) => w.length >= 3 && !/^(with|and|the|both|eye|eyes)$/.test(w));
    const mostlyDx = p.diagnosis.length > 0 && words.length >= 2 && words.filter((w) => dxText.includes(` ${w} `)).length / words.length >= 0.6;
    return inExam || inDx || mostlyDx;
  };
  const before = p.clinical_findings.length;
  p.clinical_findings = p.clinical_findings.filter((f) => !covered(f.finding, f.eye));
  if (before !== p.clinical_findings.length) out.notes.push(`Removed ${before - p.clinical_findings.length} finding${before - p.clinical_findings.length > 1 ? "s" : ""} already shown in the examination or diagnosis.`);

  // Follow-up belongs in Review, not Advice
  const FOLLOW = /^(come back|come again|review|follow.?up|revisit|see me|return)\b|আবার (আসবেন|দেখাবেন|আসুন)|फिर (आइए|आना|दिखाइए)|दोबारा आ/i;
  const followAdvice = p.advice.filter((a) => FOLLOW.test(a.text.trim()));
  if (followAdvice.length) {
    if (!p.follow_up.length) p.follow_up = followAdvice.map((a) => ({ when: a.text.replace(/^(come back|come again|review|follow.?up|revisit|return)\s*(after|in)?\s*/i, "").trim() || a.text, purpose: "" }));
    p.advice = p.advice.filter((a) => !followAdvice.includes(a));
    out.notes.push("Follow-up moved from Advice to Review.");
  }

  // Family history is not about the patient's eyes
  for (const h of p.history.ocular) if (/family|mother|father|sibling|brother|sister|মা|বাবা|माँ|पिता/i.test(h.item)) h.eye = "";
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

export function postProcess(
  p: Prescription,
  ctx: { heardText: string; kb: KnowledgeBase; negatedIds: Set<string>; negatedText: string; positiveIds: Set<string> },
): PostResult {
  const out: PostResult = { removed: [], notes: [], flags: [] };
  medicinesHeard(p, ctx.heardText, ctx.kb, out, ctx.positiveIds);
  negatedItems(p, ctx.negatedIds, ctx.negatedText, ctx.positiveIds, out, ctx.heardText);
  allergySanity(p, ctx.heardText, out);
  examinationSanity(p, ctx.heardText, out);
  procedureFallback(p, ctx.heardText, ctx.kb, ctx.positiveIds, out);
  patientSanity(p, out);
  phaseSanity(p, ctx.heardText, out);
  subtypeCheck(p, ctx.heardText, out);
  systemicEye(p);
  fieldSanity(p, ctx.heardText, out);
  evidenceCheck(p, ctx.heardText, out);
  layoutSanity(p, out);
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
