/**
 * npm run export-training → data/training/{train,valid}.jsonl
 * Chat-format rows (system + user prompt exactly as at inference + the doctor-approved prescription),
 * ready for `mlx_lm.lora` on the Mac (scripts/finetune-mlx.md) or a Bedrock / SageMaker fine-tune.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { loadKb } from "../kb/build-kb.js";
import { selectCandidates } from "../match/matcher.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "../llm/prompt.js";
import { analyzeTranscript } from "../pipeline.js";
import { loadApproved } from "./examples.js";

export function exportTraining(validShare = 0.1): { train: number; valid: number; dir: string } {
  const kb = loadKb();
  const exs = loadApproved();
  if (!exs.length) throw new Error(`No approved prescriptions yet in ${path.relative(process.cwd(), config.paths.approvedDir)} — approve drafts in the web UI first.`);
  const rows = exs.map((ex) => {
    const a = analyzeTranscript(ex.transcript, { language: ex.language, english: ex.english }, kb);
    const user = buildUserPrompt({
      transcript: ex.transcript,
      english: a.domain.translation.used ? ex.english : undefined,
      language: ex.language,
      candidates: selectCandidates(a.matches, config.llm.maxCandidates, 8),
      kb,
      indexCategories: [],
      scenarios: [],
    });
    return JSON.stringify({ messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }, { role: "assistant", content: JSON.stringify(ex.prescription) }] });
  });
  // deterministic split: every 10th row to validation (at least one when there are 2+)
  const nValid = rows.length >= 2 ? Math.max(1, Math.round(rows.length * validShare)) : 0;
  const valid = rows.filter((_, i) => nValid && i % Math.ceil(rows.length / nValid) === 0).slice(0, nValid);
  const train = rows.filter((r) => !valid.includes(r));
  fs.mkdirSync(config.paths.trainingDir, { recursive: true });
  fs.writeFileSync(path.join(config.paths.trainingDir, "train.jsonl"), train.join("\n") + "\n");
  fs.writeFileSync(path.join(config.paths.trainingDir, "valid.jsonl"), (valid.length ? valid : train.slice(0, 1)).join("\n") + "\n");
  return { train: train.length, valid: valid.length, dir: config.paths.trainingDir };
}
