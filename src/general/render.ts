/** Markdown / CSV output for the general transcription accuracy mode. */
import type { GeneralResult } from "./run.js";
import type { AlignedWord } from "./metrics.js";

const pct = (x: number | undefined | null) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(1)}%`);

/** ~~wrong~~ **heard** style diff; deletions shown as [missing: …], insertions as {+extra} */
export function diffMarkdown(al: AlignedWord[], max = 400): string {
  const out: string[] = [];
  for (const a of al.slice(0, max)) {
    if (a.op === "ok") out.push(a.ref!);
    else if (a.op === "sub") out.push(`~~${a.ref}~~→**${a.hyp}**`);
    else if (a.op === "del") out.push(`[missing: ${a.ref}]`);
    else out.push(`{+${a.hyp}}`);
  }
  if (al.length > max) out.push(`… (${al.length - max} more words)`);
  return out.join(" ");
}

export function renderGeneral(r: GeneralResult): string {
  const L: string[] = [];
  L.push(`# Transcription accuracy${r.name ? ` — ${r.name}` : ""}`, "");
  L.push(`**Accuracy: ${pct(r.accuracy.value)}** (${r.accuracy.source})`, "");
  L.push("| | |", "|---|---|");
  L.push(`| Language | ${r.language ?? "auto"} |`);
  if (r.asr) L.push(`| ASR | ${r.asr.backend}${r.asr.model ? ` · ${r.asr.model}` : ""} · ${(r.asr.ms / 1000).toFixed(1)} s${r.asr.durationSec ? ` for ${r.asr.durationSec} s of audio` : ""} |`);
  L.push(`| Heuristic estimate (no reference, no LLM) | ${pct(r.heuristic.estimated)} · ${r.heuristic.tier} |`);
  if (r.llm) L.push(`| LLM estimate | ${r.llm.estimatedAccuracy}% · ${r.llm.quality} (${r.llm.model}, ${(r.llm.ms / 1000).toFixed(1)} s) |`);
  if (r.measured) {
    const m = r.measured.raw;
    L.push(`| **Measured, raw ASR** | WER ${pct(m.wer)} · CER ${pct(m.cer)} · word acc. ${pct(m.wordAccuracy)} · char acc. ${pct(m.charAccuracy)} |`);
    L.push(`| Errors (raw) | ${m.substitutions} substituted · ${m.deletions} missing · ${m.insertions} extra · ${m.refWords} reference words · coverage ${pct(m.coverage)} |`);
    if (r.measured.corrected) {
      const c = r.measured.corrected;
      L.push(`| **Measured, after LLM correction** | WER ${pct(c.wer)} · CER ${pct(c.cer)} → LLM ${r.measured.llmHelped ? "**helped**" : "**did not help**"} |`);
    }
  }
  L.push("");
  if (r.llm?.summary) L.push(`**LLM summary:** ${r.llm.summary}`, "");
  if (r.llm?.warnings.length) L.push(...r.llm.warnings.map((w) => `> ⚠ ${w}`), "");
  if (r.heuristic.issues.length) L.push("**Heuristic issues:**", ...r.heuristic.issues.map((i) => `- ${i}`), "");
  if (r.llm?.issues.length) {
    L.push("## Problems found by the LLM", "", "| Type | In transcript | Probably |", "|---|---|---|");
    for (const i of r.llm.issues) L.push(`| ${i.type} | ${i.text.replace(/\|/g, "/")} | ${(i.suggestion || "—").replace(/\|/g, "/")} |`);
    L.push("");
  }
  if (r.measured?.raw.topErrors.length) {
    L.push("## Most frequent word errors (reference → heard)", "", "| Reference | Heard | Times |", "|---|---|---|");
    for (const e of r.measured.raw.topErrors) L.push(`| ${e.ref} | ${e.hyp} | ${e.count} |`);
    L.push("");
  }
  if (r.measured?.raw.alignment.length) L.push("## Word diff (raw ASR vs reference)", "", diffMarkdown(r.measured.raw.alignment), "");
  L.push("## Raw transcript", "", r.transcript || "_(empty)_", "");
  if (r.llm) L.push(`## LLM-corrected transcript${r.llm.correctionUsed ? "" : " (not used — rewrote too much)"}`, "", r.llm.correctedText, "");
  return L.join("\n");
}

const CSV_HEAD = ["file", "language", "asr_model", "audio_s", "asr_s", "heuristic", "llm_estimate", "llm_model", "llm_s", "wer_raw", "cer_raw", "word_acc_raw", "char_acc_raw", "coverage", "wer_llm", "cer_llm", "llm_helped", "accuracy", "accuracy_source"];
const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function csvRow(r: GeneralResult): string {
  const m = r.measured?.raw, c = r.measured?.corrected;
  return [r.name, r.language, r.asr?.model ?? r.asr?.backend, r.asr?.durationSec, r.asr ? (r.asr.ms / 1000).toFixed(1) : "", r.heuristic.estimated,
    r.llm ? r.llm.estimatedAccuracy / 100 : "", r.llm?.model, r.llm ? (r.llm.ms / 1000).toFixed(1) : "", m?.wer, m?.cer, m?.wordAccuracy, m?.charAccuracy, m?.coverage,
    c?.wer, c?.cer, r.measured?.llmHelped, r.accuracy.value, r.accuracy.source].map(cell).join(",");
}
export const csvHeader = () => CSV_HEAD.join(",");

export function renderBatch(results: GeneralResult[], setup: string): string {
  const L = [`# Transcription accuracy — batch report`, "", `_${setup} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}_`, ""];
  L.push("| File | Lang | Audio | Heuristic | LLM estimate | WER raw | CER raw | Coverage | WER after LLM | LLM helped? |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const m = r.measured?.raw, c = r.measured?.corrected;
    L.push(`| ${r.name} | ${r.language ?? "auto"} | ${r.asr?.durationSec ?? "—"} s | ${pct(r.heuristic.estimated)} | ${r.llm ? r.llm.estimatedAccuracy + "%" : "—"} | ${pct(m?.wer)} | ${pct(m?.cer)} | ${pct(m?.coverage)} | ${pct(c?.wer)} | ${r.measured?.llmHelped == null ? "—" : r.measured.llmHelped ? "yes" : "no"} |`);
  }
  const withRef = results.filter((r) => r.measured);
  if (withRef.length) {
    const mean = (f: (r: GeneralResult) => number | undefined) => {
      const v = withRef.map(f).filter((x): x is number => x != null && Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    };
    L.push("", `**Averages over ${withRef.length} file(s) with a reference:** WER ${pct(mean((r) => r.measured!.raw.wer))} · CER ${pct(mean((r) => r.measured!.raw.cer))} · ` +
      `LLM estimate ${pct(mean((r) => (r.llm ? r.llm.estimatedAccuracy / 100 : undefined)))} vs measured char accuracy ${pct(mean((r) => r.measured!.raw.charAccuracy))}`);
  }
  L.push("", "Per-file details are in the `.md` files next to this report.");
  return L.join("\n");
}
