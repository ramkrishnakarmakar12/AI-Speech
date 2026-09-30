import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadKb } from "../src/kb/build-kb.js";
import { findMatches } from "../src/match/matcher.js";
import { detectKeywords } from "../src/match/keywords.js";
import { assessTranscript, loopRatio, policyFor } from "../src/quality/accuracy.js";
import { errorRates, stripSpeakerLabels } from "../src/quality/wer.js";
import { analyzeTranscript } from "../src/pipeline.js";

const kb = loadKb();
const sample = (f: string) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), "utf8");

test("stage 1: clean transcripts score high", () => {
  for (const [f, lang] of [["cataract_consult.txt", "en"], ["hindi_consult.txt", "hi"], ["bengali_consult.txt", "bn"]]) {
    const q = assessTranscript(sample(f), { language: lang });
    assert.equal(q.tier, "high", `${f}: ${q.estimated}`);
  }
});

test("stage 1: loops, wrong language and wrong script are caught", () => {
  const loop = "Doctor good morning. " + "Patient. ".repeat(60);
  assert.ok(loopRatio(loop.toLowerCase().replace(/\./g, "").split(" ").filter(Boolean)) > 0.5);
  assert.ok(["low", "unusable"].includes(assessTranscript(loop, { language: "en" }).tier));

  // Bengali audio decoded as Punjabi (Gurmukhi) — seen in output/
  const pa = "ਡਾਕਤਾਰ ਨਮਸਕਾਰ ਬੀਸੋਨ ਆਪਨਾਰ ਨਾਮਾਰ ਬੈਸ ਬ੍ਲੂਨ ਰੋਗੀ ਨਮਸਕਾਰ ਡਾਕਤਾਰ ਬਾਬੁ ਆਮਾਰ ਨਾਮ ਗੋਪਾਲ ਮੰਦਲ ਬੈਸ ਪੀਨੀ ਤਾਲੀਸ";
  assert.equal(assessTranscript(pa, { language: "pa" }).tier, "unusable");

  // A Bengali visit forced to Bengali but written in Devanagari
  const q = assessTranscript(sample("hindi_consult.txt"), { language: "bn" });
  assert.ok(q.tier !== "high" && q.issues.some((i) => /script/.test(i)), q.issues.join(" | "));
});

test("stage 1: low ASR confidence pulls the score down", () => {
  const t = sample("cataract_consult.txt");
  const good = assessTranscript(t, { language: "en", asr: { confidence: 0.9, lowConfidenceRatio: 0.03 } });
  const bad = assessTranscript(t, { language: "en", asr: { confidence: 0.45, lowConfidenceRatio: 0.5 } });
  assert.equal(good.tier, "high");
  assert.ok(bad.score < good.score && bad.tier !== "high");
});

test("stage 1: reference gives measured WER/CER", () => {
  assert.equal(stripSpeakerLabels("Doctor: hello there\nডাক্তার: বলুন"), "hello there\nবলুন");
  const e = errorRates("the left eye is red", "Doctor: the right eye is red");
  assert.equal(e.wer, 0.2);
  const q = assessTranscript("the left eye is red since two days and it waters a lot at night doctor", {
    language: "en",
    reference: "Patient: the right eye is red since two days and it waters a lot at night doctor",
  });
  assert.equal(q.source, "measured");
  assert.equal(q.measured?.metric, "WER");
  assert.ok(Math.abs(q.score - (1 - 1 / 16)) < 0.01);
});

test("stage 2: general keywords in English, Hindi and Bengali", () => {
  const en = detectKeywords("Put the drops in the left eye three times a day for 7 days, review after one week", "en");
  assert.deepEqual(en.byCategory.eye_side, ["left"]);
  assert.ok(en.byCategory.time_unit?.includes("day") && en.byCategory.time_unit?.includes("week"));
  assert.ok(en.byCategory.dosage_form?.includes("drops") && en.byCategory.follow_up?.includes("review"));
  assert.ok(en.hits.some((h) => h.category === "number" && h.key === "digits"));

  const hi = detectKeywords("दाहिनी आँख में दिन में चार बार दवा डालें, एक हफ्ते बाद फिर आना", "hi");
  assert.ok(hi.byCategory.eye_side?.includes("right") && hi.byCategory.time_unit?.includes("week") && hi.byCategory.frequency?.includes("four_times"));

  const bn = detectKeywords(sample("bengali_consult.txt"), "bn");
  assert.ok(bn.byCategory.eye_side?.includes("both") && bn.byCategory.symptom?.includes("itching") && bn.byCategory.frequency?.includes("twice"));

  // English "do" must not be read as Hindi "two" in an English visit
  assert.ok(!detectKeywords("what do you do", "en").byCategory.number);
});

test("stage 3: matcher strictness follows the accuracy tier", () => {
  const names = (t: string, tier: "high" | "medium" | "low") => findMatches(t, kb, { fuzzyMinLatin: policyFor(tier).fuzzyMinLatin }).map((m) => m.term.name);
  // a heavily misheard drug name is only recovered when stage 1 says the transcript is noisy
  assert.ok(!names("nepafinic drops", "medium").includes("Nepafenac"));
  assert.ok(names("nepafinic drops", "low").includes("Nepafenac"));
  // ordinary ASR misspellings are still caught on clean transcripts (no regression)
  assert.ok(names("brimonadin drops", "high").some((n) => n.startsWith("Brimonidine")));
  assert.equal(findMatches("moxi flox acin", kb)[0].term.name, "Moxifloxacin", "defaults unchanged");
  assert.ok(policyFor("low").cautionLlm && policyFor("low").candidateMin < policyFor("medium").candidateMin);
  assert.ok(policyFor("unusable").skipLlm);
});

test("pipeline: analysis runs the stages in order and flags unsure terms", () => {
  const a = analyzeTranscript("Doctor: use moxifloxacin drops in the right eye four times a day for one week. Patient: okay doctor, thank you so much for the help today.", {
    language: "en",
    asr: { confidence: 0.8, lowConfidenceRatio: 0.1, words: [{ w: "moxifloxacin", p: 0.3 }], durationSec: 12 },
  });
  assert.ok(a.quality.signals.find((s) => s.name === "confidence")?.score !== null);
  assert.ok(a.keywords.byCategory.eye_side?.includes("right"));
  const moxi = a.detectedTerms.find((d) => d.name === "Moxifloxacin");
  assert.ok(moxi?.uncertain, "term heard in a low-confidence word is flagged");
  assert.equal(a.policy.tier, a.quality.tier);
});
