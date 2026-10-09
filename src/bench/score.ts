/**
 * Bench scoring: a prescription is flattened to one text row per item, per section; each expected fact must be
 * found in ONE row (all its patterns + its eye), each forbidden pattern must match no row.
 */
import type { Prescription } from "../llm/schema.js";

export type Section =
  | "patient" | "complaints" | "history" | "exam" | "diagnosis" | "medications" | "procedures"
  | "investigations" | "advice" | "follow_up" | "glasses";

export interface Fact { label: string; in: Section[]; all: string[]; eye?: "RE" | "LE" | "BE"; critical?: boolean }
export interface Forbid { label: string; in: Section[]; pattern: string }
export interface BenchCase { id: string; lang: string; file: string; group: string; audio?: string; facts: Fact[]; forbid: Forbid[] }

export interface Score {
  facts: number;
  hit: number;
  recall: number;
  critical: number;
  criticalHit: number;
  hits: string[];
  missed: string[];
  violations: string[];
  /** which row matched each found fact (for the doctor sheet) */
  matchedRows: Record<string, string>;
}

const j = (...xs: (string | undefined | null)[]) => xs.map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
const eyeTag = (e?: string) => (e ? `[${e}]` : "");

/** One text row per prescription item, grouped by section. */
export function rows(p: Prescription): Record<Section, string[]> {
  const h = p.history;
  return {
    patient: [j(p.patient.name && `name ${p.patient.name}`, p.patient.age && `age ${p.patient.age}`, p.patient.sex && `sex ${p.patient.sex}`)].filter(Boolean),
    complaints: p.chief_complaints.map((c) => j(eyeTag(c.eye), c.complaint, c.duration && `× ${c.duration}`, c.character)),
    history: [
      ...h.systemic.map((x) => j("k/c/o", x.condition, x.duration && `× ${x.duration}`, x.treatment && `— ${x.treatment}`)),
      ...h.ocular.map((x) => j(eyeTag(x.eye), "H/o", x.item)),
      ...(h.current_medications.length ? [`Current medications: ${h.current_medications.join(", ")}`] : []),
      ...(h.allergies.length ? [`Allergies: ${h.allergies.join(", ")}`] : h.allergy_status === "none known" ? ["No known drug allergy"] : []),
    ],
    exam: [
      ...p.examination.map((e) => j(eyeTag(e.eye), e.test, e.result && `: ${e.result}`)),
      ...p.clinical_findings.map((f) => j(eyeTag(f.eye), f.finding)),
    ],
    diagnosis: p.diagnosis.map((d) => j(eyeTag(d.eye), d.condition, d.grade_or_notes && `(${d.grade_or_notes})`, d.certainty === "provisional" ? "provisional" : "")),
    medications: p.medications.map((m) => j(eyeTag(m.eye), m.form, m.generic_name, m.brand_said && `(${m.brand_said})`, m.strength, m.dose, m.frequency, m.duration && `× ${m.duration}`, m.start_when, m.instructions)),
    procedures: p.procedures.map((x) => j(eyeTag(x.eye), x.procedure, x.notes)),
    investigations: p.investigations.map((x) => j(eyeTag(x.eye), x.test, x.purpose && `— ${x.purpose}`)),
    advice: p.advice.map((a) => a.text),
    follow_up: p.follow_up.map((f) => j(f.when, f.purpose && `— ${f.purpose}`)),
    glasses: p.glasses.map((g) => j(`[${g.eye}]`, g.sph && `sph ${g.sph}`, g.cyl && `cyl ${g.cyl}`, g.axis && `axis ${g.axis}`, g.add && `add ${g.add}`, g.notes)),
  };
}

const re = (p: string) => new RegExp(p, "iu");
const eyeOf = (row: string) => row.match(/^\[(RE|LE|BE)\]/)?.[1] ?? "";

/** The row that satisfies a fact, or "" — eye BE also accepts one RE row and one LE row. */
export function findFact(f: Fact, r: Record<Section, string[]>): string {
  const pool = f.in.flatMap((s) => r[s] ?? []);
  const textOk = (row: string) => f.all.every((p) => re(p).test(row));
  if (!f.eye) return pool.find(textOk) ?? "";
  const ok = pool.filter(textOk);
  const exact = ok.find((row) => eyeOf(row) === f.eye || (f.eye !== "BE" && eyeOf(row) === "BE"));
  if (exact) return exact;
  if (f.eye === "BE") {
    const right = ok.find((row) => eyeOf(row) === "RE");
    const left = ok.find((row) => eyeOf(row) === "LE");
    if (right && left) return `${right} + ${left}`;
  }
  return "";
}

export function scoreCase(p: Prescription, c: BenchCase): Score {
  const r = rows(p);
  const hits: string[] = [], missed: string[] = [], matchedRows: Record<string, string> = {};
  let critical = 0, criticalHit = 0;
  for (const f of c.facts) {
    const row = findFact(f, r);
    if (f.critical) critical++;
    if (row) {
      hits.push(f.label);
      matchedRows[f.label] = row;
      if (f.critical) criticalHit++;
    } else missed.push(f.label);
  }
  const violations: string[] = [];
  for (const x of c.forbid) {
    const row = x.in.flatMap((s) => r[s] ?? []).find((row) => re(x.pattern).test(row));
    if (row) violations.push(`${x.label} — "${row}"`);
  }
  return { facts: c.facts.length, hit: hits.length, recall: hits.length / Math.max(1, c.facts.length), critical, criticalHit, hits, missed, violations, matchedRows };
}
