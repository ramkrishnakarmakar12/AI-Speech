import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKb } from "../src/kb/build-kb.js";
import { loadLexicon, scanLexicon } from "../src/domain/lexicon.js";
import { findNegations, insideNegation } from "../src/domain/negation.js";
import { postProcess, supported, translationForLlm } from "../src/domain/postprocess.js";
import { findNumbers } from "../src/domain/numbers.js";
import { buildUserPrompt } from "../src/llm/prompt.js";
import { analyzeTranscript } from "../src/pipeline.js";
import type { Prescription } from "../src/llm/schema.js";

const kb = loadKb();
const ids = (hits: { entry: { id?: string } }[]) => hits.map((h) => h.entry.id).filter(Boolean) as string[];

const empty = (): Prescription => ({
  patient: { name: "", age: "", sex: "" },
  chief_complaints: [],
  history: { systemic: [], ocular: [], current_medications: [], allergies: [] },
  examination: [], clinical_findings: [], diagnosis: [], medications: [], procedures: [],
  investigations: [], glasses: [], advice: [], follow_up: [], terms: [],
} as any);
const med = (generic_name: string, extra: any = {}) => ({ kb_id: "", generic_name, brand_said: "", form: "drop", strength: "", eye: "BE", dose: "", frequency: "", duration: "", phase: "", instructions: "", ...extra });

test("lexicon: every id exists in the ophthalmology KB", () => {
  const known = new Set(kb.terms.map((t) => t.id));
  for (const e of loadLexicon()) for (const id of [...(e.id ? [e.id] : []), ...(e.block ?? [])]) assert.ok(known.has(id), `${e.match[0]} → ${id}`);
});

test("lexicon: Bengali clinic phrases decode to the right terms", () => {
  assert.ok(ids(scanLexicon("কাছের জিনিস দেখতে পারি না, চালশে হয়েছে", kb)).includes("DIS-143"));
  assert.ok(ids(scanLexicon("সুগার আছে দশ বছর ধরে", kb)).includes("ABR-005"));
  // longest match wins: eye pressure is a test, plain প্রেশার is blood pressure
  const eyeP = ids(scanLexicon("চোখের প্রেশার মাপব", kb));
  assert.ok(eyeP.includes("TST-013") && !eyeP.includes("ABR-006"), JSON.stringify(eyeP));
  assert.ok(ids(scanLexicon("প্রেশার আছে", kb)).includes("ABR-006"));
});

test("lexicon: English ASR mishearings are mapped", () => {
  assert.ok(ids(scanLexicon("do the amstrad grid at home", kb)).includes("TST-060"));
  assert.ok(ids(scanLexicon("start r-cyte capsules", kb)).includes("MED-106"));
});

test("negation: denials are found, inability is not a denial", () => {
  const bn = "সুগার প্রেশার নেই";
  const s = findNegations(bn);
  assert.ok(s.length && insideNegation(bn.indexOf("সুগার"), bn.indexOf("সুগার") + 5, s), JSON.stringify(s));
  assert.equal(findNegations("কাছের লেখা পড়তে পারছি না").length, 0);
  assert.equal(findNegations("मुझे साफ दिखाई नहीं देता").length, 0);
  assert.ok(findNegations("मुझे शुगर नहीं है").length > 0);
  const en = "No diabetes or hypertension but itching";
  const e = findNegations(en);
  assert.ok(e.some((x) => /diabetes/.test(x.phrase)) && !e.some((x) => /itching/.test(x.phrase)), JSON.stringify(e));
  assert.equal(findNegations("I can't see near objects").length, 0);
});

test("postprocess: medicines never said are removed, said ones kept", () => {
  const p = empty();
  p.medications = [med("Carboxymethylcellulose"), med("Prednisolone acetate"), med("")];
  const r = postProcess(p, { heardText: "use carboxymethylcellulose drops four times a day", kb, negatedIds: new Set(), negatedText: "", positiveIds: new Set() });
  assert.deepEqual(p.medications.map((m) => m.generic_name), ["Carboxymethylcellulose"]);
  assert.ok(r.removed.some((x) => /Prednisolone/.test(x)));
});

test("postprocess: duplicates, greeting-as-name, bad age, pre-op without surgery", () => {
  const p = empty();
  p.patient = { name: "Ashun Bosun", age: "At 8", sex: "" };
  p.advice = [{ text: "Blink often", kb_id: "", evidence: "blink often" }, { text: "blink often", kb_id: "", evidence: "blink often" }];
  p.medications = [med("Moxifloxacin", { phase: "post-op" })];
  const r = postProcess(p, { heardText: "moxifloxacin drop four times, blink often", kb, negatedIds: new Set(), negatedText: "", positiveIds: new Set() });
  assert.equal(p.patient.name, "");
  assert.equal(p.patient.age, "");
  assert.equal(p.advice.length, 1);
  assert.equal(p.medications[0].phase, "");
  assert.ok(r.notes.length >= 2);
});

test("postprocess: denied conditions are dropped", () => {
  const p = empty();
  p.history.systemic = [{ condition: "Diabetes mellitus", kb_id: "ABR-005", duration: "", treatment: "" }];
  postProcess(p, { heardText: "sugar nei", kb, negatedIds: new Set(["ABR-005"]), negatedText: "sugar", positiveIds: new Set() });
  assert.equal(p.history.systemic.length, 0);
});

test("translationForLlm: drops Bengali and looping translations", () => {
  assert.equal(translationForLlm("Use drops twice.", "bn", "auto").use, undefined);
  assert.equal(translationForLlm("Use drops twice.", "hi", "auto").use, "Use drops twice.");
  const loop = Array(8).fill("There is constipation.").join(" ");
  assert.equal(translationForLlm(loop, "hi", "on").use, undefined);
  assert.equal(translationForLlm("Use drops twice.", "hi", "off").use, undefined);
});

test("analyzeTranscript: Bengali visit gets decoded phrases and negated ids", () => {
  const a = analyzeTranscript("রোগী: কাছের লেখা পড়তে পারছি না, চালশে হয়েছে। রোগী: সুগার নেই।", { language: "bn" });
  assert.ok(a.domain.lexicon.some((l) => l.id === "DIS-143"), JSON.stringify(a.domain.lexicon));
  assert.ok(a.domain.negatedIds.includes("ABR-005"), JSON.stringify(a.domain));
});

// ---------------- LEF evaluation fixes (Oct 2026) ----------------
const LEF = "বয়স কত হলো আটান্নছে আটান্ন … সুগার আছে প্রায় এক বছর প্রেশার আছে … কোন ওষুধে অ্যালার্জি আছে না সেরকম কিছু … " +
  "ডান চোখে ছানি পড়েছে মানে ক্যাটারাক্ট নিউক্লিয়ার ক্যাটারাক্ট গ্রেড টু থেকে থ্রি মা চোখেও শুরু হয়েছে তবে এখন হালকা … " +
  "তিন দিন আগে থেকে ডান চোখে মক্সিফলেসিন ড্রপ শুরু করবেন … ইসিজি আর এখানেই স্ক্যান বায়োমেট্রি … মোবাইল দেখার সময় মাঝে মাঝে চোখের পলক ফেলবেন";

test("numbers: Bengali/Hindi number words are decoded", () => {
  const n = Object.fromEntries(findNumbers(LEF + " সুগার একশো আটচল্লিশ").map((h) => [h.heard, h.value]));
  assert.equal(n["আটান্নছে"], 58);
  assert.equal(n["এক বছর"], 1);
  assert.equal(n["একশো আটচল্লিশ"], 148);
  assert.equal(n["তিন দিন"], 3);
  assert.equal(findNumbers("उम्र अट्ठावन साल")[0].value, 58);
  assert.equal(findNumbers("ডাক্তার বিশেষজ্ঞ তিনি বলেন").length, 0, "বিশেষ / তিনি are not numbers");
});

test("lexicon: ছানি no longer suggests cortical / PSC; A-scan beats optical; garbled moxifloxacin, ECG are recognised", () => {
  const a = analyzeTranscript(LEF, { language: "bn" });
  const ids = new Set(a.matches.map((m) => m.term.id));
  assert.ok(ids.has("DIS-002"), "nuclear cataract was said");
  assert.ok(!ids.has("DIS-003") && !ids.has("DIS-004"), "cortical / PSC were not said");
  assert.ok(ids.has("TST-036") && !ids.has("TST-037"), "A-scan, not optical biometry");
  assert.ok(ids.has("MED-001"), "মক্সিফলেসিন → Moxifloxacin");
  assert.ok(ids.has("TST-069"), "ইসিজি → ECG / pre-op workup");
});

test("prompt: no full KB index and no KB style example (they buried the transcript and leaked advice)", () => {
  const a = analyzeTranscript(LEF, { language: "bn" });
  const u = buildUserPrompt({ transcript: LEF, language: "bn", candidates: a.matches, kb, indexCategories: ["medicine", "disease"], scenarios: kb.scenarios ?? [] });
  assert.ok(!u.includes("## INDEX") && !u.includes("STYLE EXAMPLE"));
  assert.ok(u.includes("CONVERSATION TRANSCRIPT"));
});

test("postprocess: unspoken advice is dropped, spoken advice kept", () => {
  const p = empty();
  p.advice = [
    { text: "Use warm compress and clean lid margins twice daily", kb_id: "CNS-025", evidence: "গরম সেক দেবেন" },
    { text: "Follow the 20-20-20 rule", kb_id: "CNS-023", evidence: "" },
    { text: "Blink often while using the mobile", kb_id: "CNS-024", evidence: "মোবাইল দেখার সময় মাঝে মাঝে চোখের পলক ফেলবেন" },
  ];
  const r = postProcess(p, { heardText: LEF, kb, negatedIds: new Set(), negatedText: "", positiveIds: new Set() });
  assert.deepEqual(p.advice.map((a) => a.kb_id), ["CNS-024"]);
  assert.equal(r.removed.filter((x) => x.startsWith("Advice")).length, 2);
});

test("postprocess: invented cataract sub-type → plain cataract; systemic tests lose the eye; copied duration removed; age checked", () => {
  const p = empty();
  p.patient.age = "69";
  p.diagnosis = [
    { condition: "Nuclear cataract", kb_id: "DIS-002", eye: "RE", grade_or_notes: "grade 2-3", certainty: "confirmed", evidence: "নিউক্লিয়ার ক্যাটারাক্ট গ্রেড টু থেকে থ্রি" },
    { condition: "Cortical cataract", kb_id: "DIS-003", eye: "LE", grade_or_notes: "mild", certainty: "confirmed", evidence: "মা চোখেও শুরু হয়েছে তবে এখন হালকা" },
  ];
  p.investigations = [{ test: "Blood sugar / HbA1c", kb_id: "TST-067", eye: "BE", purpose: "", evidence: "সুগার" }];
  p.history.systemic = [
    { condition: "Diabetes mellitus", kb_id: "ABR-005", duration: "1 year", treatment: "", evidence: "সুগার আছে প্রায় এক বছর" },
    { condition: "Hypertension", kb_id: "ABR-006", duration: "1 year", treatment: "", evidence: "প্রেশার আছে" },
  ];
  const r = postProcess(p, { heardText: LEF, kb, negatedIds: new Set(), negatedText: "", positiveIds: new Set() });
  assert.equal(p.diagnosis[0].kb_id, "DIS-002");
  assert.equal(p.diagnosis[1].condition, "Cataract (type not specified)");
  assert.equal(p.investigations[0].eye, "");
  assert.equal(p.history.systemic[0].duration, "1 year");
  assert.equal(p.history.systemic[1].duration, "");
  assert.ok(r.flags.some((f) => f.startsWith("Age 69")));
});

test("postprocess: a medicine heard through the lexicon is kept even when garbled", () => {
  const p = empty();
  p.medications = [med("Moxifloxacin", { kb_id: "MED-001", eye: "RE", start_when: "3 days before surgery" })];
  postProcess(p, { heardText: "ডান চোখে মক্সিফলেসিন ড্রপ", kb, negatedIds: new Set(), negatedText: "", positiveIds: new Set(["MED-001"]) });
  assert.equal(p.medications.length, 1);
  assert.equal(p.medications[0].status, "new");
});

test("supported(): quotes must come from the transcript", () => {
  assert.ok(supported("চোখের পলক ফেলবেন", LEF));
  assert.ok(!supported("warm compress twice daily", LEF));
  assert.ok(!supported("", LEF));
});
