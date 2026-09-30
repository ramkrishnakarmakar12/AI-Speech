/**
 * Learning from the clinic's own doctors.
 *
 * Every prescription a doctor approves in the UI is stored in data/approved/ together with its transcript.
 * They are used in two ways:
 *   1. Few-shot examples (now): the most similar approved visits (same language, most shared KB terms)
 *      are shown to the LLM, so it copies this clinic's mapping and wording.
 *   2. Fine-tuning data (later): `npm run export-training` writes chat-format JSONL for a LoRA fine-tune of
 *      Qwen3-4B-Instruct (MLX on the Mac, or Bedrock/SageMaker) — see scripts/finetune-mlx.md.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Prescription } from "../llm/schema.js";

export interface ApprovedExample {
  id: string;
  savedAt: string;
  language: string;
  transcript: string;
  english?: string;
  prescription: Prescription;
  termIds: string[];
  doctor?: string;
}

export function saveApproved(ex: Omit<ApprovedExample, "id" | "savedAt">): ApprovedExample {
  fs.mkdirSync(config.paths.approvedDir, { recursive: true });
  const full: ApprovedExample = { id: `rx-${new Date().toISOString().replace(/[:.]/g, "-")}`, savedAt: new Date().toISOString(), ...ex };
  fs.writeFileSync(path.join(config.paths.approvedDir, `${full.id}.json`), JSON.stringify(full, null, 2));
  return full;
}

export function loadApproved(): ApprovedExample[] {
  if (!fs.existsSync(config.paths.approvedDir)) return [];
  return fs
    .readdirSync(config.paths.approvedDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(config.paths.approvedDir, f), "utf8")) as ApprovedExample;
      } catch {
        return null;
      }
    })
    .filter((x): x is ApprovedExample => !!x?.prescription && !!x.transcript);
}

/** Prescription without empty fields / rows — keeps the example short in the prompt. */
export function compact(p: Prescription): unknown {
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]).filter(([, x]) => x !== undefined && x !== "" && !(Array.isArray(x) && !x.length) && !(x && typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length)));
      return Object.keys(o).length ? o : undefined;
    }
    return v === "" ? undefined : v;
  };
  const { terms: _t, ...rest } = p as any;
  return strip(rest) ?? {};
}

export function pickExamples(language: string | null | undefined, termIds: string[], n = config.llm.fewShot): ApprovedExample[] {
  if (n <= 0) return [];
  const want = new Set(termIds);
  return loadApproved()
    .map((ex) => ({ ex, score: ex.termIds.filter((t) => want.has(t)).length + (ex.language === language ? 2 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.ex.savedAt.localeCompare(a.ex.savedAt))
    .slice(0, n)
    .map((x) => x.ex);
}

export function examplesSection(exs: ApprovedExample[], maxTranscript = 700, maxJson = 1800): string {
  if (!exs.length) return "";
  return (
    "APPROVED EXAMPLES FROM THIS CLINIC (doctor-verified; follow how they map speech to terms and fields — never copy their content into this patient)\n" +
    exs
      .map((ex, i) => {
        const t = ex.transcript.length > maxTranscript ? ex.transcript.slice(0, maxTranscript) + " …" : ex.transcript;
        const j = JSON.stringify(compact(ex.prescription));
        return `### Example ${i + 1} (${ex.language})\nTranscript: ${t}\nApproved prescription: ${j.length > maxJson ? j.slice(0, maxJson) + " …" : j}`;
      })
      .join("\n\n")
  );
}
