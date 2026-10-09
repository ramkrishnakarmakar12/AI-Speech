#!/usr/bin/env node
/**
 * Readiness bench: every conversation in evaluation/bench/cases.json is run N times through the real pipeline
 * (same model / settings as the server — MODEL_ENV, LLM_PROVIDER, LLM_MODEL …), scored against its expected
 * facts, and written to evaluation/bench/out/<date-time>/: report.md, results.json, doctor_review.xlsx.
 *
 *   npm run bench                         all cases × 3 runs, from the transcripts (measures extraction)
 *   npm run bench -- --runs 5             more runs per case (consistency)
 *   npm run bench -- --only s9_bn_diabetic_retinopathy,s11_hi_corneal_ulcer
 *   npm run bench -- --group unseen       only the conversations no rule was tuned on
 *   npm run bench -- --audio              cases with an "audio" file go through speech recognition too
 *   npm run bench -- --label bedrock-32b  name the output folder
 *   npm run bench -- --rescore evaluation/bench/out/<folder>
 *        no model calls: the saved prescriptions go through today's checks (postprocess) and today's cases.json again
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { config, ROOT } from "../config.js";
import { analyzeTranscript, extractFromTranscript, runFromAudio, type ExtractionResult } from "../pipeline.js";
import { postProcess } from "../domain/postprocess.js";
import { loadKb } from "../kb/build-kb.js";
import { resolveModel } from "../llm/client.js";
import { rows, scoreCase, type BenchCase, type Score } from "./score.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
};
const RUNS = Math.max(1, Number(flag("runs") ?? 3));
const only = flag("only")?.split(",").map((s) => s.trim());
const group = flag("group");
const useAudio = flag("audio") === "true";
const label = flag("label");

/** Readiness gates (doctor-supervised pilot: the doctor still reviews and signs every prescription). */
export const GATES = {
  unseenRecall: 0.9, // mean fact recall on conversations no rule was tuned on
  worstRun: 0.8, // no single run of any case below this
  critical: 0.95, // numbers, medicines, eye sides
  violations: 0, // denied conditions, drugs never said, wrong procedures
  consistency: 0.9, // facts found in every run / facts found in any run
};

interface RunResult {
  case: string;
  lang: string;
  group: string;
  run: number;
  ok: boolean;
  error?: string;
  score?: Score;
  ms: number;
  repair: boolean;
  truncated: boolean;
  warnings: string[];
  prescription?: ExtractionResult["prescription"];
  transcript?: string;
}

/** Errors that will fail every run the same way (no server, no credentials) — stop instead of repeating them. */
const FATAL = /cannot connect|econnrefused|fetch failed|enotfound|denied access|accessdenied|not authorized|credential|unrecognizedclient|expiredtoken|security token|rejected model|needs the aws sdk|no model is loaded|model .* not found/i;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Re-check and re-score a saved run without calling the model. */
async function rescore(dir: string) {
  const src = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  const saved = JSON.parse(fs.readFileSync(path.join(src, "results.json"), "utf8"));
  const all: BenchCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, "evaluation/bench/cases.json"), "utf8")).cases;
  const kb = loadKb();
  const results: RunResult[] = saved.results;
  for (const r of results) {
    const c = all.find((x) => x.id === r.case);
    if (!c || !r.ok || !r.prescription) continue;
    const transcript = fs.readFileSync(path.join(ROOT, c.file), "utf8");
    const a = analyzeTranscript(transcript, { language: c.lang }, kb);
    const d = a.domain as any;
    const post = postProcess(r.prescription, { heardText: transcript, kb, negatedIds: new Set(a.domain.negatedIds), negatedText: d._negatedText ?? "", positiveIds: new Set<string>(d._positiveIds ?? []) });
    r.warnings = [...r.warnings, ...post.removed.map((x) => `Removed (rescore): ${x}.`), ...post.flags.map((x) => `Check (rescore): ${x}.`)];
    r.score = scoreCase(r.prescription, c);
  }
  const cases = all.filter((c) => results.some((r) => r.case === c.id));
  const outDir = `${src.replace(/[\\/]+$/, "")}-rescore`;
  fs.mkdirSync(outDir, { recursive: true });
  RUNS_OVERRIDE = saved.runs ?? RUNS;
  META = { provider: saved.provider ?? "?", modelEnv: saved.modelEnv ?? "?" };
  const report = renderReport(cases, results, `${saved.model} (saved answers re-checked, no new model calls)`);
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ ...saved, rescoredAt: new Date().toISOString(), results }, null, 1));
  await doctorSheet(cases, results, path.join(outDir, "doctor_review.xlsx"));
  console.log(report.split("\n").slice(0, 40).join("\n"));
  console.log(`\nWrote ${path.relative(ROOT, outDir)}/report.md, results.json, doctor_review.xlsx`);
}
let RUNS_OVERRIDE = 0;
let META: { provider: string; modelEnv: string } | null = null;

async function main() {
  if (flag("rescore")) return rescore(flag("rescore")!);
  const all: BenchCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, "evaluation/bench/cases.json"), "utf8")).cases;
  const cases = all.filter((c) => (!only || only.includes(c.id)) && (!group || c.group === group));
  if (!cases.length) throw new Error("No cases match --only / --group");
  const model = await resolveModel().catch(() => config.llm.model);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  const outDir = path.join(ROOT, "evaluation/bench/out", `${stamp}${label ? `-${label}` : ""}`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Bench: ${cases.length} cases × ${RUNS} runs · ${config.modelEnv} · ${config.llm.provider} ${model}${useAudio ? ` · ASR ${config.asr.backend}` : ""}\n→ ${path.relative(ROOT, outDir)}\n`);

  const results: RunResult[] = [];
  let stopped = "";
  for (const c of cases) {
    if (stopped) break;
    const transcript = fs.readFileSync(path.join(ROOT, c.file), "utf8");
    for (let run = 1; run <= RUNS && !stopped; run++) {
      const t0 = Date.now();
      try {
        const audio = useAudio && c.audio ? path.join(ROOT, c.audio) : undefined;
        const r = audio && fs.existsSync(audio) ? await runFromAudio(audio, undefined, c.lang) : await extractFromTranscript(transcript, { language: c.lang, force: true });
        const score = scoreCase(r.prescription, c);
        results.push({
          case: c.id, lang: c.lang, group: c.group, run, ok: true, score, ms: Date.now() - t0,
          repair: r.warnings.some((w) => /second, focused model pass/.test(w)),
          truncated: r.warnings.some((w) => /cut short/.test(w)),
          warnings: r.warnings, prescription: r.prescription, transcript: r.transcript,
        });
        console.log(`  ${c.id.padEnd(32)} run ${run}: ${pct(score.recall).padStart(4)} (${score.hit}/${score.facts}) · critical ${score.criticalHit}/${score.critical} · violations ${score.violations.length} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      } catch (e: any) {
        results.push({ case: c.id, lang: c.lang, group: c.group, run, ok: false, error: e?.message ?? String(e), ms: Date.now() - t0, repair: false, truncated: false, warnings: [] });
        console.log(`  ${c.id.padEnd(32)} run ${run}: ERROR ${e?.message ?? e}`);
        if (FATAL.test(String(e?.message ?? e))) stopped = String(e?.message ?? e);
      }
      fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ model, provider: config.llm.provider, modelEnv: config.modelEnv, runs: RUNS, results }, null, 1));
    }
  }
  if (stopped) {
    const msg =
      `\nStopped: the model could not be reached, so every run would fail the same way.\n  ${stopped}\n\n` +
      (config.llm.provider === "bedrock"
        ? "Bedrock needs AWS credentials on this machine with bedrock:InvokeModel on the model (AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET), and model access enabled in the region."
        : `Start the model server (${config.llm.provider}) and load the model, then run again.`);
    console.error(msg);
    fs.writeFileSync(path.join(outDir, "report.md"), `# Bench stopped\n\n${msg.trim()}\n`);
    process.exitCode = 1;
    return;
  }
  const report = renderReport(cases, results, model);
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  await doctorSheet(cases, results, path.join(outDir, "doctor_review.xlsx"));
  console.log("\n" + report.split("\n").slice(0, 22).join("\n"));
  console.log(`\nWrote ${path.relative(ROOT, outDir)}/report.md, results.json, doctor_review.xlsx`);
}

export function summarise(cases: BenchCase[], results: RunResult[]) {
  const per = cases.map((c) => {
    const rs = results.filter((r) => r.case === c.id && r.ok && r.score);
    const recalls = rs.map((r) => r.score!.recall);
    const anyHit = new Set(rs.flatMap((r) => r.score!.hits));
    const allHit = [...anyHit].filter((h) => rs.every((r) => r.score!.hits.includes(h)));
    const missCount: Record<string, number> = {};
    for (const r of rs) for (const m of r.score!.missed) missCount[m] = (missCount[m] ?? 0) + 1;
    return {
      c, rs, recalls,
      mean: mean(recalls),
      min: recalls.length ? Math.min(...recalls) : 0,
      critical: rs.reduce((a, r) => a + r.score!.criticalHit, 0) / Math.max(1, rs.reduce((a, r) => a + r.score!.critical, 0)),
      violations: rs.flatMap((r) => r.score!.violations.map((v) => `run ${r.run}: ${v}`)),
      stability: anyHit.size ? allHit.length / anyHit.size : 0,
      missCount,
      errors: results.filter((r) => r.case === c.id && !r.ok).length,
      repairs: rs.filter((r) => r.repair).length,
      secs: mean(rs.map((r) => r.ms / 1000)),
    };
  });
  const unseen = per.filter((p) => p.c.group === "unseen");
  const scope = unseen.length ? unseen : per;
  const allRuns = per.flatMap((p) => p.rs);
  const crit = allRuns.reduce((a, r) => a + r.score!.criticalHit, 0) / Math.max(1, allRuns.reduce((a, r) => a + r.score!.critical, 0));
  const gates = [
    { name: `Mean fact recall on ${unseen.length ? "unseen" : "all"} conversations ≥ ${pct(GATES.unseenRecall)}`, value: mean(scope.map((p) => p.mean)), pass: mean(scope.map((p) => p.mean)) >= GATES.unseenRecall, fmt: pct },
    { name: `Worst single run ≥ ${pct(GATES.worstRun)}`, value: Math.min(...per.map((p) => p.min)), pass: Math.min(...per.map((p) => p.min)) >= GATES.worstRun, fmt: pct },
    { name: `Numbers, medicines, eye sides (critical facts) ≥ ${pct(GATES.critical)}`, value: crit, pass: crit >= GATES.critical, fmt: pct },
    { name: "Forbidden items (denied conditions, unsaid drugs …) = 0", value: per.reduce((a, p) => a + p.violations.length, 0), pass: per.every((p) => !p.violations.length), fmt: String },
    { name: `Consistency across runs ≥ ${pct(GATES.consistency)}`, value: mean(per.map((p) => p.stability)), pass: mean(per.map((p) => p.stability)) >= GATES.consistency, fmt: pct },
    { name: "No failed runs (errors)", value: per.reduce((a, p) => a + p.errors, 0), pass: per.every((p) => !p.errors), fmt: String },
  ];
  return { per, gates };
}

function renderReport(cases: BenchCase[], results: RunResult[], model: string): string {
  const { per, gates } = summarise(cases, results);
  const ready = gates.every((g) => g.pass);
  const o: string[] = [];
  o.push(`# AI Speech readiness bench — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  o.push(`Model: **${model}** (${META?.provider ?? config.llm.provider}, MODEL_ENV=${META?.modelEnv ?? config.modelEnv}) · ${cases.length} conversations × ${RUNS_OVERRIDE || RUNS} runs · input: ${useAudio ? "audio where available, else transcript" : "transcripts (speech recognition not measured)"}\n`);
  o.push(`## Verdict: ${ready ? "✅ meets the gates for a doctor-supervised pilot" : "❌ not ready yet"}\n`);
  o.push("| Gate | Result | |\n|---|---|---|");
  for (const g of gates) o.push(`| ${g.name} | ${g.fmt(g.value as number)} | ${g.pass ? "✅" : "❌"} |`);
  o.push("\n_A pilot still means every prescription is a draft the doctor reviews and signs._\n");

  o.push("## Per conversation\n");
  o.push(`| Case | Lang | Group | Facts | ${Array.from({ length: RUNS_OVERRIDE || RUNS }, (_, i) => `Run ${i + 1}`).join(" | ")} | Mean | Worst | Critical | Consistency | Violations | 2nd pass | Avg s |`);
  o.push(`|---|---|---|---|${"---|".repeat(RUNS_OVERRIDE || RUNS)}---|---|---|---|---|---|---|`);
  for (const p of per)
    o.push(`| ${p.c.id} | ${p.c.lang} | ${p.c.group} | ${p.c.facts.length} | ${Array.from({ length: RUNS_OVERRIDE || RUNS }, (_, i) => { const r = p.rs.find((x) => x.run === i + 1); return r ? pct(r.score!.recall) : "error"; }).join(" | ")} | **${pct(p.mean)}** | ${pct(p.min)} | ${pct(p.critical)} | ${pct(p.stability)} | ${p.violations.length} | ${p.repairs} | ${p.secs.toFixed(0)} |`);

  o.push("\n## By language and group\n");
  o.push("| Slice | Conversations | Mean recall | Worst run | Critical |\n|---|---|---|---|---|");
  const slice = (name: string, ps: typeof per) => {
    if (!ps.length) return;
    const runs = ps.flatMap((p) => p.rs);
    const crit = runs.reduce((a, r) => a + r.score!.criticalHit, 0) / Math.max(1, runs.reduce((a, r) => a + r.score!.critical, 0));
    o.push(`| ${name} | ${ps.length} | ${pct(mean(ps.map((p) => p.mean)))} | ${pct(Math.min(...ps.map((p) => p.min)))} | ${pct(crit)} |`);
  };
  for (const l of ["en", "bn", "hi"]) slice(`Language ${l}`, per.filter((p) => p.c.lang === l));
  for (const g of ["unseen", "earlier-eval", "tuned"]) slice(`Group ${g}`, per.filter((p) => p.c.group === g));
  slice("All", per);

  o.push("\n## What was missed or wrong\n");
  for (const p of per) {
    const misses = Object.entries(p.missCount).sort((a, b) => b[1] - a[1]);
    if (!misses.length && !p.violations.length && !p.errors) continue;
    o.push(`### ${p.c.id}`);
    for (const [f, n] of misses) {
      const fact = p.c.facts.find((x) => x.label === f);
      o.push(`- missed${fact?.critical ? " **(critical)**" : ""}: ${f} — ${n}/${p.rs.length} runs`);
    }
    for (const v of p.violations) o.push(`- ❌ forbidden: ${v}`);
    for (const r of results.filter((x) => x.case === p.c.id && !x.ok)) o.push(`- ⚠ run ${r.run} failed: ${r.error}`);
    o.push("");
  }
  o.push("Groups: **unseen** = conversations no rule was written for (the honest test) · **earlier-eval** = scripts from earlier evaluation rounds · **tuned** = the 9 Oct transcripts the latest fixes were written against.");
  return o.join("\n");
}

/** One sheet line per prescription line, with the automatic check and an empty column for the doctor's verdict. */
async function doctorSheet(cases: BenchCase[], results: RunResult[], file: string) {
  const wb = new ExcelJS.Workbook();
  const review = wb.addWorksheet("Review", { views: [{ state: "frozen", ySplit: 1 }] });
  review.columns = [
    { header: "Case", key: "case", width: 30 }, { header: "Run", key: "run", width: 6 }, { header: "Section", key: "section", width: 15 },
    { header: "Prescription line", key: "line", width: 70 }, { header: "Automatic check", key: "auto", width: 40 },
    { header: "Doctor: Correct / Minor fix / Wrong", key: "verdict", width: 22 }, { header: "Comment", key: "comment", width: 40 },
  ];
  const missed = wb.addWorksheet("Missed facts", { views: [{ state: "frozen", ySplit: 1 }] });
  missed.columns = [
    { header: "Case", key: "case", width: 30 }, { header: "Run", key: "run", width: 6 }, { header: "Expected fact", key: "fact", width: 50 },
    { header: "Critical", key: "critical", width: 9 }, { header: "Doctor: really missing? (Yes / No)", key: "verdict", width: 22 }, { header: "Comment", key: "comment", width: 40 },
  ];
  for (const r of results.filter((x) => x.ok && x.prescription)) {
    const c = cases.find((x) => x.id === r.case)!;
    const byRow = new Map<string, string[]>();
    for (const [lab, row] of Object.entries(r.score!.matchedRows)) for (const part of row.split(" + ")) byRow.set(part, [...(byRow.get(part) ?? []), lab]);
    const bad = new Map(r.score!.violations.map((v) => [v.slice(v.indexOf('"') + 1, -1), v.split(" — ")[0]]));
    for (const [section, lines] of Object.entries(rows(r.prescription!))) {
      for (const line of lines) {
        const auto = bad.has(line) ? `FORBIDDEN: ${bad.get(line)}` : byRow.has(line) ? `✓ ${byRow.get(line)!.join("; ")}` : "not in the expected list — doctor to judge";
        const row = review.addRow({ case: r.case, run: r.run, section, line, auto });
        row.getCell("verdict").dataValidation = { type: "list", allowBlank: true, formulae: ['"Correct,Minor fix,Wrong"'] };
        if (auto.startsWith("FORBIDDEN")) row.getCell("auto").font = { color: { argb: "FFC00000" }, bold: true };
      }
    }
    for (const f of r.score!.missed) {
      const row = missed.addRow({ case: r.case, run: r.run, fact: f, critical: c.facts.find((x) => x.label === f)?.critical ? "yes" : "" });
      row.getCell("verdict").dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] };
    }
  }
  for (const ws of [review, missed]) ws.getRow(1).font = { bold: true };
  const { per, gates } = summarise(cases, results);
  const sum = wb.addWorksheet("Summary");
  sum.addRow(["Gate", "Result", "Pass"]).font = { bold: true };
  for (const g of gates) sum.addRow([g.name, g.fmt(g.value as number), g.pass ? "yes" : "no"]);
  sum.addRow([]);
  sum.addRow(["Case", "Lang", "Group", "Mean recall", "Worst run", "Critical", "Consistency", "Violations"]).font = { bold: true };
  for (const p of per) sum.addRow([p.c.id, p.c.lang, p.c.group, pct(p.mean), pct(p.min), pct(p.critical), pct(p.stability), p.violations.length]);
  sum.columns.forEach((col) => (col.width = 26));
  await wb.xlsx.writeFile(file);
}

if (process.argv[1] && /bench[\\/]run\.ts$/.test(process.argv[1])) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
