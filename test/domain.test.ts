import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKb } from "../src/kb/build-kb.js";
import { loadLexicon, scanLexicon } from "../src/domain/lexicon.js";
import { findNegations, insideNegation } from "../src/domain/negation.js";
import { postProcess, translationForLlm } from "../src/domain/postprocess.js";
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
  p.advice = [{ text: "Blink often", kb_id: "" }, { text: "blink often", kb_id: "" }];
  p.medications = [med("Moxifloxacin", { phase: "post-op" })];
  const r = postProcess(p, { heardText: "moxifloxacin drop four times", kb, negatedIds: new Set(), negatedText: "", positiveIds: new Set() });
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
