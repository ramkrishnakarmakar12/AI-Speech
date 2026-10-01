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

/**
 * Approved examples are shown only when they share a DIAGNOSIS with this visit (not just any term), and only
 * the term-mapping parts are shown. In the LEF evaluation a single dry-eye example made the model copy its
 * advice ("warm compress", "20-20-20") into a cataract patient.
 */
export function pickExamples(language: string | null | undefined, termIds: string[], n = config.llm.fewShot): ApprovedExample[] {
  if (n <= 0) return [];
  const want = new Set(termIds);
  const dxIds = (ex: ApprovedExample) => (ex.prescription.diagnosis ?? []).map((d) => d.kb_id).filter(Boolean);
  return loadApproved()
    .map((ex) => {
      const sharedDx = dxIds(ex).filter((id) => want.has(id)).length;
      return { ex, sharedDx, score: sharedDx * 3 + ex.termIds.filter((t) => want.has(t)).length + (ex.language === language ? 1 : 0) };
    })
    .filter((x) => x.sharedDx > 0)
    .sort((a, b) => b.score - a.score || b.ex.savedAt.localeCompare(a.ex.savedAt))
    .slice(0, n)
    .map((x) => x.ex);
}

/** Only the parts that teach speech → term mapping; never the patient, advice, follow-up or numbers to copy. */
function mappingOnly(p: Prescription): unknown {
  const pick = (rows: any[] | undefined, keys: string[]) => (rows ?? []).map((r) => Object.fromEntries(keys.filter((k) => r?.[k]).map((k) => [k, r[k]])));
  return compact({
    chief_complaints: pick(p.chief_complaints, ["complaint", "kb_id", "eye", "patient_words"]),
    diagnosis: pick(p.diagnosis, ["condition", "kb_id", "eye"]),
    medications: pick(p.medications, ["generic_name", "brand_said", "kb_id", "form", "frequency", "eye", "status", "start_when"]),
    procedures: pick(p.procedures, ["procedure", "kb_id", "eye"]),
    investigations: pick(p.investigations, ["test", "kb_id", "eye"]),
  } as any);
}

export function examplesSection(exs: ApprovedExample[], maxTranscript = 600, maxJson = 1200): string {
  if (!exs.length) return "";
  return (
    "APPROVED MAPPING EXAMPLES FROM THIS CLINIC (doctor-verified; they show how spoken words map to terms and fields. " +
    "They are a DIFFERENT patient: never copy their complaints, findings, numbers, medicines or advice into this prescription)\n" +
    exs
      .map((ex, i) => {
        const t = ex.transcript.length > maxTranscript ? ex.transcript.slice(0, maxTranscript) + " …" : ex.transcript;
        const j = JSON.stringify(mappingOnly(ex.prescription));
        return `### Example ${i + 1} (${ex.language})\nTranscript excerpt: ${t}\nTerm mapping: ${j.length > maxJson ? j.slice(0, maxJson) + " …" : j}`;
      })
      .join("\n\n")
  );
}
