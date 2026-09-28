/** Renders an ExtractionResult as an OPD-style prescription draft (Markdown). */
import type { ExtractionResult } from "./pipeline.js";

const j = (...xs: (string | undefined)[]) => xs.map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
const bullet = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- —");

export function renderMarkdown(r: ExtractionResult): string {
  const p = r.prescription;
  const ref = (section: string, i: number) => r.kbRefs[`${section}.${i}`];
  const tag = (section: string, i: number) => {
    const k = ref(section, i);
    return k ? ` \`${k.id}\`` : " ⚠︎`not in KB`";
  };
  const out: string[] = [];

  out.push("# Prescription draft");
  out.push("_Auto-generated from the consultation audio/transcript. Must be reviewed and signed by the treating ophthalmologist._\n");
  const pt = [p.patient.name, p.patient.age && `${p.patient.age}`, p.patient.sex].filter(Boolean).join(" · ");
  out.push(`**Patient:** ${pt || "—"}\n`);

  out.push("## C/o");
  out.push(bullet(p.chief_complaints.map((c, i) => j(c.complaint, c.eye, c.duration && `× ${c.duration}`, c.character && `(${c.character})`) + tag("chief_complaints", i))));

  const hx = [
    ...p.history.systemic.map((h, i) => j("k/c/o", h.condition, h.duration && `× ${h.duration}`, h.treatment && `— ${h.treatment}`) + tag("history.systemic", i)),
    ...p.history.ocular.map((h, i) => j("H/o", h.item, h.eye) + tag("history.ocular", i)),
    ...(p.history.current_medications.length ? [`Current meds: ${p.history.current_medications.join(", ")}`] : []),
    ...(p.history.allergies.length ? [`Allergies: ${p.history.allergies.join(", ")}`] : []),
  ];
  out.push("\n## History");
  out.push(bullet(hx));

  out.push("\n## O/E");
  out.push(bullet([...p.examination.map((e, i) => j(e.test, e.eye, e.result && `: ${e.result}`) + tag("examination", i)), ...p.clinical_findings.map((f, i) => j(f.finding, f.eye) + tag("clinical_findings", i))]));

  out.push("\n## Diagnosis");
  out.push(
    bullet(
      p.diagnosis.map((d, i) => {
        const icd = ref("diagnosis", i)?.reference?.["ICD-10 (indicative)"];
        return j(d.condition, d.grade_or_notes && `(${d.grade_or_notes})`, d.eye, d.certainty === "provisional" ? "— provisional" : "", icd && `[ICD-10 ${icd}]`) + tag("diagnosis", i);
      }),
    ),
  );

  out.push("\n## Rx");
  if (!p.medications.length) out.push("—");
  p.medications.forEach((m, i) => {
    const line = j(m.form, m.generic_name, m.strength, m.brand_said && `(${m.brand_said})`, "—", m.dose, m.frequency, m.eye, m.duration && `× ${m.duration}`, m.phase && `[${m.phase}]`);
    out.push(`${i + 1}. ${line}${tag("medications", i)}${m.instructions ? `  \n   _${m.instructions}_` : ""}`);
    const usual = ref("medications", i)?.reference?.["Typical Prescription Usage"];
    if (usual) out.push(`   <sub>KB typical usage: ${usual}</sub>`);
  });

  if (p.procedures.length) {
    out.push("\n## Procedure / Surgery advised");
    out.push(bullet(p.procedures.map((x, i) => j(x.procedure, x.eye, x.notes && `— ${x.notes}`) + tag("procedures", i))));
  }
  if (p.investigations.length) {
    out.push("\n## Investigations");
    out.push(bullet(p.investigations.map((x, i) => j(x.test, x.eye, x.purpose && `— ${x.purpose}`) + tag("investigations", i))));
  }
  if (p.glasses.length) {
    out.push("\n## Glasses");
    out.push("| Eye | Sph | Cyl | Axis | Add | Notes |\n|---|---|---|---|---|---|");
    for (const g of p.glasses) out.push(`| ${g.eye} | ${g.sph || "—"} | ${g.cyl || "—"} | ${g.axis || "—"} | ${g.add || "—"} | ${g.notes || ""} |`);
  }
  out.push("\n## Advice");
  out.push(bullet(p.advice.map((a) => a.text)));
  out.push("\n## Review");
  out.push(bullet(p.follow_up.map((f) => j(f.when, f.purpose && `— ${f.purpose}`))));

  if (r.warnings.length) {
    out.push("\n## Check before signing");
    out.push(bullet(r.warnings));
  }

  out.push("\n## Terminology detected");
  out.push("| Heard | Term | KB id | Category |\n|---|---|---|---|");
  const seen = new Set<string>();
  for (const t of p.terms) {
    const k = t.kb_id || t.heard;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`| ${t.heard} | ${t.canonical} | ${t.kb_id || "—"} | ${t.category} |`);
  }

  out.push(`\n<sub>LLM: ${r.llm.model} · ${(r.llm.ms / 1000).toFixed(1)} s${r.asr ? ` · ASR: ${r.asr.backend} ${(r.asr.ms / 1000).toFixed(1)} s` : ""}</sub>`);
  return out.join("\n");
}
