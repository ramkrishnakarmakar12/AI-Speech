import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.js";
import { findFact, rows, scoreCase, type BenchCase } from "../src/bench/score.js";
import type { Prescription } from "../src/llm/schema.js";

const cases: BenchCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, "evaluation/bench/cases.json"), "utf8")).cases;

test("bench: every case file exists and every pattern compiles", () => {
  for (const c of cases) {
    assert.ok(fs.existsSync(path.join(ROOT, c.file)), c.file);
    for (const f of c.facts) for (const p of f.all) new RegExp(p, "iu");
    for (const x of c.forbid) new RegExp(x.pattern, "iu");
  }
});

test("bench: facts are matched per row and per eye; forbidden items are caught", () => {
  const p = {
    patient: { name: "", age: "", sex: "" },
    chief_complaints: [{ complaint: "Diminution of vision", kb_id: "", eye: "RE", duration: "2 months", character: "", patient_words: "" }],
    history: { systemic: [{ condition: "Diabetes mellitus", kb_id: "", duration: "12 years", treatment: "" }, { condition: "Hypothyroidism", kb_id: "", duration: "", treatment: "" }], ocular: [], current_medications: [], allergies: [] },
    examination: [
      { test: "Visual acuity", kb_id: "", eye: "RE", result: "6/18" },
      { test: "Visual acuity", kb_id: "", eye: "LE", result: "6/18" },
      { test: "Intraocular pressure (NCT)", kb_id: "", eye: "RE", result: "16 mmHg at 11 am" },
    ],
    clinical_findings: [], diagnosis: [], medications: [], procedures: [], investigations: [], glasses: [], advice: [], follow_up: [{ when: "1 month", purpose: "" }], terms: [],
  } as unknown as Prescription;
  const dr = cases.find((c) => c.id === "s9_bn_diabetic_retinopathy")!;
  const s = scoreCase(p, dr);
  assert.ok(s.hits.includes("VA RE 6/18"));
  assert.ok(s.missed.includes("VA LE 6/12"), "an LE row with the RE value is not the LE fact");
  assert.ok(s.hits.includes("IOP RE 16") && s.hits.includes("IOP at 11 am") && s.hits.includes("Follow-up 1 month"));
  assert.ok(s.violations.some((v) => /Denied thyroid/.test(v)));
  // BE fact satisfied by an RE row and an LE row
  assert.ok(findFact({ label: "x", in: ["exam"], all: ["6/18"], eye: "BE" }, rows(p)));
});
