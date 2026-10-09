/**
 * Regressions from the Bengali prescription runs of 9 Oct 2026 (rx-lef): real transcripts, and model answers
 * that reproduce the errors printed on those prescriptions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKb } from "../src/kb/build-kb.js";
import { postProcess, systemicAnswer } from "../src/domain/postprocess.js";
import { allNumberValues, findNumbers } from "../src/domain/numbers.js";
import { analyzeTranscript, coerce, emptySections } from "../src/pipeline.js";
import type { Prescription } from "../src/llm/schema.js";

const kb = loadKb();

const DR =
  "ডাক্তার বলুন কি অসুবিধা রোগী ডান চোখে দুই মাস ধরে ঝাপসা দেখছি সুগার বারো বছর ধরে প্রেশারও আছে ডাক্তার থাইরয়েড রোগী না থাইরয়েড নেই ডাক্তার আগে চোখে কিছু করা হয়েছে রোগী দুই বছর আগে বামচোখে লেজার হয়েছিল ডাক্তার দৃষ্টি ডান চোখে ছয় বাই আঠেরো বাম চোখে ছয় বাই বারো চোখের প্রেশার এনসিটিতে ডান ষোলো বাম আঠেরো সকাল এগারোটায় ফান্ডাসে ডান চোখে ডট ব্লট হেমরেজ হার্ড এক্সুডেট আর ম্যাকুলার ইডিমা বাম চোখে মাইল্ড এনপিডিআর ডাক্তার ডান চোখে মডারেট এনপিডিআর উইথ সিএসএমই আজ ওসিটি ম্যাকুলা আর এফএফএ করাবেন ডান চোখে অ্যান্টিভিইজিএফ ইন্জেকশন দিতে হবে ডাক্তার সুগার আর প্রেশার নিয়ন্ত্রণে রাখবেন এক মাস পরে আবার দেখাবেন";

const GLAUCOMA =
  "নমস্কার বসুন বলুন কিী সমস্যা ডাক্তারবাবু ছ মাস ধরে বাঁ চোখে ঝাপসা দেখছি রাতে আলোর চারপাশে রামধনুর মতো দেখি সুগার আছে প্রেশার আছে সুগার নেই প্রেশার আছে পাঁচ বছর ধরে অ্যামলোডিপিং খাই আপনার বাড়িতে কারও গ্লুকোমা আছে হ্যাঁ আমার মায়ের গ্লুকোমা ছিল দেখছি ডান চোখে দৃষ্টি ছয় বাই নয় বাঁ চোখে ছয় বাই আঠেরো চোখের প্রেশার ডান চোখে ষোলো বাঁ চোখে ছাব্বিশ স্লিটল্যাম্পে দুই চোখের কর্ণিয়া পরিষ্কার বাঁ চোখে ছানি শুরু হয়েছে ফান্ডাসে ডান চোখে কাপডিস্ক রেশিও শূন্য দশমিক চার বাঁ চোখে শূন্য দশমিক সাত বাঁ চোখে গ্লুকোমা হয়েছে সাথে ছানি শুরু হয়েছে একটা ফিল্ড টেস্ট আর ওসিটি করাতে হবে মোবাইল কম দেখবেন ড্রপ নিজে থেকে বন্ধ করবেন না এক মাস পরে আবার আসবেন প্রেশার দেখব";

const empty = (): Prescription =>
  ({
    patient: { name: "", age: "", sex: "" },
    chief_complaints: [],
    history: { systemic: [], ocular: [], current_medications: [], allergies: [] },
    examination: [], clinical_findings: [], diagnosis: [], medications: [], procedures: [],
    investigations: [], glasses: [], advice: [], follow_up: [], terms: [],
  }) as any;

function run(transcript: string, p: Prescription) {
  const a = analyzeTranscript(transcript, { language: "bn" }, kb);
  const d = a.domain as any;
  return postProcess(p, { heardText: transcript, kb, negatedIds: new Set(a.domain.negatedIds), negatedText: d._negatedText ?? "", positiveIds: new Set<string>(d._positiveIds ?? []) });
}

/** What the model returned for the diabetic-retinopathy recording (prescription 2). */
function drAnswer(): Prescription {
  const p = empty();
  p.patient.name = "রোগী";
  p.chief_complaints = [{ complaint: "Diminution of vision", kb_id: "SYM-001", eye: "RE", duration: "2 months", character: "", patient_words: "", evidence: "ডান চোখে দুই মাস ধরে ঝাপসা দেখছি" }];
  p.history.systemic = [
    { condition: "Diabetes mellitus", kb_id: "ABR-005", duration: "12 years", treatment: "", evidence: "সুগার বারো বছর ধরে" },
    { condition: "Hypertension", kb_id: "ABR-006", duration: "", treatment: "", evidence: "প্রেশারও আছে" },
    { condition: "Thyroid problem on thyroxine", kb_id: "", duration: "", treatment: "thyroxine", evidence: "ডাক্তার থাইরয়েড" },
  ];
  p.history.ocular = [{ item: "Laser treatment", kb_id: "", eye: "LE", evidence: "দুই বছর আগে বামচোখে লেজার হয়েছিল" }];
  p.history.allergy_status = "none known";
  p.examination = [
    { test: "Visual acuity", kb_id: "", eye: "RE", result: "6/18", evidence: "ডান চোখে ছয় বাই আঠেরো" },
    { test: "Visual acuity", kb_id: "", eye: "LE", result: "6/12", evidence: "বাম চোখে ছয় বাই বারো" },
    { test: "Intraocular pressure", kb_id: "", eye: "RE", result: "16 mmHg", evidence: "ডান ষোলো" },
    { test: "Intraocular pressure", kb_id: "", eye: "LE", result: "8 mmHg", evidence: "বাম আঠেরো" },
    { test: "Fundus examination", kb_id: "", eye: "RE", result: "Dot blot haemorrhage, hard exudate, macular oedema", evidence: "ফান্ডাসে ডান চোখে ডট ব্লট হেমরেজ" },
    { test: "Fundus examination", kb_id: "", eye: "LE", result: "Mild NPDR", evidence: "বাম চোখে মাইল্ড এনপিডিআর" },
  ];
  p.clinical_findings = [
    { finding: "Dot blot haemorrhage", kb_id: "", eye: "RE", evidence: "ডট ব্লট হেমরেজ" },
    { finding: "Hard exudate", kb_id: "", eye: "RE", evidence: "হার্ড এক্সুডেট" },
    { finding: "Macular oedema", kb_id: "", eye: "RE", evidence: "ম্যাকুলার ইডিমা" },
    { finding: "Mild NPDR", kb_id: "", eye: "LE", evidence: "মাইল্ড এনপিডিআর" },
    { finding: "Moderate NPDR with CSME", kb_id: "", eye: "RE", evidence: "মডারেট এনপিডিআর উইথ সিএসএমই" },
  ];
  p.diagnosis = [
    { condition: "Diabetic retinopathy (NPDR)", kb_id: "", eye: "RE", grade_or_notes: "Moderate", certainty: "confirmed", evidence: "ডান চোখে মডারেট এনপিডিআর" },
    { condition: "Macular oedema", kb_id: "", eye: "RE", grade_or_notes: "", certainty: "confirmed", evidence: "উইথ সিএসএমই" },
  ];
  p.advice = [
    { text: "Keep sugar and pressure under control", kb_id: "", evidence: "সুগার আর প্রেশার নিয়ন্ত্রণে রাখবেন" },
    { text: "Come back in one month", kb_id: "", evidence: "এক মাস পরে আবার দেখাবেন" },
  ];
  p.follow_up = [{ when: "1 month", purpose: "Review" }];
  return p;
}

test("numbers: spoken spellings, decimals and English digits in Bengali script", () => {
  assert.ok(findNumbers("বাম আঠেরো").some((h) => h.value === 18));
  assert.ok(allNumberValues("কাপডিস্ক রেশিও শূন্য দশমিক চার").has(0.4));
  assert.ok(allNumberValues("প্লাস ওয়ান পয়েন্ট ফাইভ অ্যাড").has(1.5));
  assert.ok(allNumberValues("চোখের প্রেশার এনসিটিতে ডান ষোলো").has(16));
  assert.ok(allNumberValues("दाईं चौदह, बाईं पंद्रह").has(15));
  assert.ok(allNumberValues("cup disc ratio zero point seven").has(0.7));
});

test("systemic history: the doctor's question is not an answer; the patient's last answer wins", () => {
  assert.equal(systemicAnswer("Hypothyroidism", DR)?.answer, "no");
  assert.equal(systemicAnswer("Diabetes mellitus", DR)?.answer, "yes");
  assert.equal(systemicAnswer("Hypertension", DR)?.answer, "yes");
  assert.equal(systemicAnswer("Diabetes mellitus", GLAUCOMA)?.answer, "no");
  assert.equal(systemicAnswer("Hypertension", GLAUCOMA)?.answer, "yes");
  assert.equal(systemicAnswer("Diabetes", "সুগার, প্রেশার বা থাইরয়েড আছে? থাইরয়েড আছে, থাইরক্সিন খাই। সুগার প্রেশার নেই।")?.answer, "no");
  assert.equal(systemicAnswer("Hypothyroidism", "সুগার, প্রেশার বা থাইরয়েড আছে? থাইরয়েড আছে, থাইরক্সিন খাই। সুগার প্রেশার নেই।")?.answer, "yes");
  assert.equal(systemicAnswer("Asthma", "Do you have sugar, BP or asthma?")?.answer, "asked");
});

test("prescription 2 (diabetic retinopathy): every error on the printed prescription is fixed or flagged", () => {
  const p = drAnswer();
  const r = run(DR, p);
  // denied thyroid, unsaid allergy, speaker label as name
  assert.deepEqual(p.history.systemic.map((h) => h.condition), ["Diabetes mellitus", "Hypertension"]);
  assert.equal(p.history.allergy_status, "not discussed");
  assert.equal(p.patient.name, "");
  // IOP: the "8" nobody said is removed; method and time added to the value that was said
  const iop = p.examination.filter((e) => /pressure/i.test(e.test));
  assert.deepEqual(iop.map((e) => `${e.test}|${e.eye}|${e.result}`), ["Intraocular pressure (NCT)|RE|16 mmHg at 11 am"]);
  assert.ok(r.removed.some((x) => /8 was not said/.test(x)), r.removed.join("\n"));
  // anti-VEGF injection advised → procedure added and flagged
  assert.deepEqual(p.procedures.map((x) => `${x.kb_id}|${x.eye}`), ["PRC-050|RE"]);
  assert.ok(r.flags.some((f) => /Intravitreal injection/.test(f)));
  // no repeated findings; follow-up only in Review; the past laser is not an advised procedure
  assert.deepEqual(p.clinical_findings.map((f) => f.finding), []);
  assert.deepEqual(p.advice.map((a) => a.text), ["Keep sugar and pressure under control"]);
  assert.equal(p.follow_up.length, 1);
});

test("prescription 1 (glaucoma + early cataract): empty sections are reported; family history has no eye", () => {
  const p = empty();
  p.patient.name = "patient";
  p.history.systemic = [{ condition: "Hypertension", kb_id: "ABR-006", duration: "5 years", treatment: "Amlodipine", evidence: "প্রেশার আছে পাঁচ বছর ধরে অ্যামলোডিপিং খাই" }];
  p.history.ocular = [{ item: "Family history of glaucoma", kb_id: "", eye: "BE", evidence: "আমার মায়ের গ্লুকোমা ছিল" }];
  p.advice = [
    { text: "Use mobile less", kb_id: "", evidence: "মোবাইল কম দেখবেন" },
    { text: "Do not stop drops on your own", kb_id: "", evidence: "ড্রপ নিজে থেকে বন্ধ করবেন না" },
    { text: "Come back in one month", kb_id: "", evidence: "এক মাস পরে আবার আসবেন" },
  ];
  run(GLAUCOMA, p);
  assert.equal(p.patient.name, "");
  assert.equal(p.history.ocular[0].eye, "");
  assert.ok(/one month/i.test(p.follow_up[0].when), JSON.stringify(p.follow_up));
  assert.equal(p.advice.length, 2);
  const gaps = emptySections(empty(), GLAUCOMA);
  assert.equal(gaps.length, 2, gaps.join(" | "));
  // … and the words that were said are now put back: haloes / blur as complaints, both pressures
  assert.ok(p.chief_complaints.some((c) => /halo/i.test(c.complaint)), JSON.stringify(p.chief_complaints));
  assert.deepEqual(p.examination.filter((e) => /pressure/i.test(e.test)).map((e) => `${e.eye} ${e.result}`), ["RE 16 mmHg", "LE 26 mmHg"]);
  // the CDR values a model would write are now recognised as said
  p.examination = [{ test: "Cup-disc ratio", kb_id: "", eye: "LE", result: "0.7", evidence: "শূন্য দশমিক সাত" }, { test: "Intraocular pressure", kb_id: "", eye: "LE", result: "26 mmHg", evidence: "বাঁ চোখে ছাব্বিশ" }];
  const r2 = run(GLAUCOMA, p);
  assert.equal(p.examination.length, 2, r2.removed.join("\n"));
});

test("second run (14:13/14:14): age from a duration, conditions as medicines, repeated finding", () => {
  const p = drAnswer();
  p.patient.age = "12";
  p.history.current_medications = ["Diabetes mellitus", "Hypertension"];
  p.clinical_findings = [{ finding: "Macular edema in right eye", kb_id: "", eye: "RE", evidence: "ম্যাকুলার ইডিমা" }];
  run(DR, p);
  assert.equal(p.patient.age, "");
  assert.deepEqual(p.history.current_medications, []);
  assert.deepEqual(p.clinical_findings, []);
});

test("glaucoma transcript: «ছয় বাই নয়» is 6/9 not a denial; glaucoma and haloes reach the model", () => {
  const a = analyzeTranscript(GLAUCOMA, { language: "bn" }, kb);
  assert.ok(!a.domain.negated.some((n) => /বাই নয়/.test(n)), a.domain.negated.join(" | "));
  const ids = a.detectedTerms.map((d) => d.id);
  for (const id of ["SYM-017", "TST-024", "TST-013"]) assert.ok(ids.includes(id), `${id} missing: ${ids.join(",")}`);
  assert.ok(a.domain.lexicon.some((l) => /গ্লুকোমা/.test(l.heard) && !l.negated));
  // still a real denial
  assert.ok(a.domain.negated.some((n) => /সুগার নেই/.test(n)));
});

test("third run (14:24): unsaid NCT removed, 'OCT of macula' only when macula was said", () => {
  const p = empty();
  p.examination = [{ test: "Intraocular pressure (NCT)", kb_id: "", eye: "LE", result: "26 mmHg", evidence: "বাঁ চোখে ছাব্বিশ" }];
  p.investigations = [{ test: "Optical coherence tomography (OCT) of macula", kb_id: "", eye: "", purpose: "", evidence: "ওসিটি করাতে হবে" }];
  run(GLAUCOMA, p);
  assert.equal(p.examination[0].test, "Intraocular pressure");
  assert.equal(p.investigations[0].test, "Optical coherence tomography (OCT)");
  // the DR visit did say ম্যাকুলা and NCT: both stay
  const q = empty();
  q.examination = [{ test: "Intraocular pressure (NCT)", kb_id: "", eye: "RE", result: "16 mmHg", evidence: "ডান ষোলো" }];
  q.investigations = [{ test: "Optical coherence tomography (OCT) of macula", kb_id: "", eye: "RE", purpose: "", evidence: "ওসিটি ম্যাকুলা" }];
  run(DR, q);
  assert.equal(q.examination[0].test, "Intraocular pressure (NCT)");
  assert.match(q.investigations[0].test, /macula/);
});

test("fourth run (14:37): renamed or wrapped sections from the model are still read", () => {
  const p = coerce({ prescription: { complaints: [{ complaint: "DOV" }], on_examination: [{ test: "Visual acuity", eye: "LE", result: "6/18" }], history: { systemic: [] } } });
  assert.equal(p.chief_complaints.length, 1);
  assert.equal(p.examination[0].result, "6/18");
  const q = coerce({ chief_complaints: [], complaints: [{ complaint: "x" }] });
  assert.equal(q.chief_complaints.length, 1);
});

test("fifth run (15:23): advice left in Bengali is flagged; the doctor's 'প্রেশার দেখব' goes to Review", () => {
  const p = empty();
  p.advice = [
    { text: "mobile কম দেখবেন", kb_id: "", evidence: "মোবাইল কম দেখবেন" },
    { text: "Do not stop drops on your own", kb_id: "", evidence: "ড্রপ নিজে থেকে বন্ধ করবেন না" },
    { text: "প্রেশার দেখব", kb_id: "", evidence: "প্রেশার দেখব" },
  ];
  p.follow_up = [{ when: "1 month", purpose: "" }];
  const r = run(GLAUCOMA, p);
  assert.deepEqual(p.advice.map((a) => a.text), ["mobile কম দেখবেন", "Do not stop drops on your own"]);
  assert.ok(r.flags.some((f) => /mobile কম দেখবেন.*not written in English/.test(f)), r.flags.join("\n"));
  assert.equal(p.follow_up[0].purpose, "Recheck eye pressure");
});

test("bench round 1 (Bedrock 32B): code in a medicine field, wrong tonometer, value-less VA/IOP rows, symptom as finding, OCT purpose", () => {
  const p = empty();
  p.chief_complaints = [{ complaint: "Headache", kb_id: "", eye: "BE", duration: "", character: "", patient_words: "", evidence: "" }];
  p.medications = [{ kb_id: "", generic_name: "Latanoprost", brand_said: "", form: "E/D", strength: "", eye: "LE", dose: "1 drop", frequency: "ABR-068", duration: "", phase: "", instructions: "", evidence: "latanoprost" } as any];
  p.examination = [
    { test: "Schiøtz / iCare / Tono-Pen tonometry", kb_id: "", eye: "RE", result: "16 mmHg", evidence: "ডান ষোলো" },
    { test: "Visual acuity", kb_id: "", eye: "LE", result: "", evidence: "" },
    { test: "Goldmann applanation tonometry", kb_id: "", eye: "BE", result: "Normal", evidence: "" },
  ];
  p.clinical_findings = [{ finding: "Headache", kb_id: "", eye: "BE", evidence: "" }];
  p.investigations = [{ test: "Optical coherence tomography", kb_id: "", eye: "", purpose: "Assessment of macula and optic nerve", evidence: "ওসিটি" }];
  const r = run(GLAUCOMA + " latanoprost at bedtime", p);
  assert.equal(p.medications[0].frequency, "HS");
  assert.ok(r.flags.some((f) => /ABR-068/.test(f)));
  assert.deepEqual(p.examination.map((e) => e.test), ["Intraocular pressure"]);
  assert.deepEqual(p.clinical_findings, []);
  assert.equal(p.investigations[0].purpose, "Assessment of optic nerve");
});

test("bench round 2: a procedure planned only 'if' something happens is advice, and repeated advice is merged", () => {
  const p = empty();
  p.procedures = [{ procedure: "Photodynamic therapy", kb_id: "", eye: "LE", notes: "If conversion to wet AMD occurs", evidence: "যদি এটি ওয়েট বা ভেজা ক্যাটাগরিতে রূপান্তরিত হয়, তবে ফটোডায়নামিক থেরাপি দেওয়া হবে" }];
  p.advice = [
    { text: "Use mobile less", kb_id: "", evidence: "মোবাইল কম দেখবেন" },
    { text: "Limit mobile phone use", kb_id: "", evidence: "মোবাইল কম দেখবেন" },
  ];
  run(GLAUCOMA, p);
  assert.deepEqual(p.procedures, []);
  assert.ok(p.advice.some((a) => /Photodynamic therapy \(LE\) — only if conversion to wet AMD occurs/.test(a.text)), JSON.stringify(p.advice));
  assert.equal(p.advice.filter((a) => /mobile/i.test(a.text)).length, 1);
});

test("bench round 3: IOP said but missing is added, clinic tests are not investigations, 'Come for follow-up after 1 month' is Review", () => {
  const HI = "डॉक्टर: दोनों आँखों की नज़र छह बटा छह है। प्रेशर एन सी टी से दाईं चौदह, बाईं पंद्रह। एक महीने बाद आइए।";
  const p = empty();
  p.investigations = [{ test: "Non-contact tonometry (NCT)", kb_id: "", eye: "", purpose: "", evidence: "एन सी टी" }, { test: "Fundus photography", kb_id: "", eye: "", purpose: "", evidence: "" }];
  p.advice = [{ text: "Come for follow-up after 1 month", kb_id: "", evidence: "एक महीने बाद आइए" }];
  run(HI, p);
  assert.deepEqual(p.examination.map((e) => `${e.test}|${e.eye}|${e.result}`), ["Intraocular pressure (NCT)|RE|14 mmHg", "Intraocular pressure (NCT)|LE|15 mmHg"]);
  assert.deepEqual(p.investigations.map((t) => t.test), ["Fundus photography"]);
  assert.deepEqual(p.advice, []);
  assert.match(p.follow_up[0].when, /1 month/);
});

test("bench round 3: a symptom the doctor only asked about, or the patient denied, is not added back", () => {
  const T = "Doctor: Any headache or vomiting?\nPatient: Mild headache in the evening, but no vomiting.";
  const p = empty();
  run(T, p);
  const names = p.chief_complaints.map((c) => c.complaint.toLowerCase()).join(" | ");
  assert.ok(!/vomit|nausea/.test(names), names);
});

test("bench round 4: a procedure the doctor said is NOT needed is dropped; unnamed symptoms (metamorphopsia) come back; empty exam rows go", () => {
  const T = "Patient: I've noticed progressive metamorphopsia and blurred vision in my left eye.\nDoctor: Since there's no active neovascular membrane, anti-VEGF intravitreal injections are not indicated. We'll perform dynamic retinoscopy.";
  const p = empty();
  p.procedures = [{ procedure: "Intravitreal injection", kb_id: "PRC-050", eye: "LE", notes: "Not required currently", evidence: "anti-VEGF intravitreal injections are not indicated" }];
  p.examination = [{ test: "Dynamic retinoscopy", kb_id: "", eye: "LE", result: "", evidence: "" }];
  run(T, p);
  assert.deepEqual(p.procedures, []);
  assert.deepEqual(p.examination, []);
  assert.ok(p.chief_complaints.some((c) => /metamorphopsia/i.test(c.complaint)), JSON.stringify(p.chief_complaints));
});

test("bench round 5: Bengali review period and drug names in English; a systemic illness never mentioned is removed", () => {
  const p = empty();
  p.follow_up = [{ when: "দেড় মাস পরে", purpose: "" }];
  p.history.systemic = [
    { condition: "Hypothyroidism", kb_id: "", duration: "", treatment: "থাইরক্সিন", evidence: "থাইরয়েড আছে" },
    { condition: "Hypertension", kb_id: "", duration: "", treatment: "", evidence: "" },
  ];
  p.history.current_medications = ["থাইরক্সিন"];
  const T = "রোগী: থাইরয়েড আছে, থাইরক্সিন খাই। ডাক্তার: চোখের প্রেশার মাপব। দেড় মাস পরে আসবেন।";
  run(T, p);
  assert.equal(p.follow_up[0].when, "1.5 months");
  assert.deepEqual(p.history.systemic.map((h) => `${h.condition}|${h.treatment}`), ["Hypothyroidism|Thyroxine"]);
  assert.deepEqual(p.history.current_medications, ["Thyroxine"]);
});
