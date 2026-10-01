/** Renders an ExtractionResult as an OPD-style prescription draft (Markdown). */
import type { Analysis, ExtractionResult } from "./pipeline.js";
import type { KeywordCategory } from "./match/keywords.js";

const j = (...xs: (string | undefined)[]) => xs.map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
const bullet = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- —");

const TIER_ICON: Record<string, string> = { high: "🟢", medium: "🟡", low: "🟠", unusable: "🔴" };
const KW_LABEL: Record<KeywordCategory, string> = {
  eye_side: "Eye side", eye: "Eye / vision", number: "Numbers", measurement: "Measurements", time_unit: "Durations",
  time_of_day: "Time of day", frequency: "Frequency", dosage_form: "Dosage form", symptom: "Lay symptoms",
  negation: "Negation", affirmation: "Yes / OK", speaker: "Speakers", follow_up: "Follow-up",
};

/** Stage 1 + stage 2 summary (also printed by `npm run analyze` / `transcribe`). */
export function renderQuality(a: Pick<Analysis, "quality" | "keywords" | "policy">): string {
  const q = a.quality;
  const out: string[] = [];
  out.push("## 1. Transcription accuracy");
  const head =
    q.source === "measured"
      ? `measured ${q.measured!.metric} ${Math.round((q.measured!.metric === "WER" ? q.measured!.wer : q.measured!.cer) * 100)}% (WER ${q.measured!.wer}, CER ${q.measured!.cer}) → accuracy ${Math.round(q.score * 100)}% · reference-free estimate ${Math.round(q.estimated * 100)}%`
      : `estimated ${Math.round(q.score * 100)}%`;
  out.push(`${TIER_ICON[q.tier]} **${q.tier.toUpperCase()}** — ${head} · language ${q.language} · ${q.words} words`);
  out.push("\n| Signal | Score | Detail |\n|---|---|---|");
  for (const s of q.signals) out.push(`| ${s.name.replace(/_/g, " ")} | ${s.score === null ? "—" : s.score.toFixed(2)} | ${s.note} |`);
  if (q.issues.length) out.push("\n" + q.issues.map((i) => `- ${i}`).join("\n"));
  out.push(`\n_Medical-term matching: ${a.policy.description}._`);

  out.push("\n## 2. General keywords");
  const k = a.keywords;
  out.push(`${k.totalHits} hits · ${k.perHundredWords} per 100 words · ${k.categoriesFound} kinds`);
  if (k.hits.length) {
    out.push("\n| Kind | Found |\n|---|---|");
    for (const [cat, keys] of Object.entries(k.byCategory))
      out.push(`| ${KW_LABEL[cat as KeywordCategory] ?? cat} | ${keys!.map((key) => { const h = k.hits.find((x) => x.category === cat && x.key === key)!; return `${key} ×${h.count}`; }).join(", ")} |`);
  }
  return out.join("\n");
}

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
  out.push(renderQuality(r) + "\n");
  out.push("## 3. Medical terms → prescription\n");
  if (r.llm.skipped) out.push(`> **No prescription generated** (${r.llm.skipped}). Terms detected in the text are listed at the end for reference.\n`);
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
  const unsure = r.detectedTerms.filter((d) => d.uncertain);
  if (unsure.length) out.push(`\n⚠ Heard where the speech model was unsure: ${unsure.map((d) => `${d.name} (“${d.heardAs}”)`).join(", ")}`);
  if (r.llm.skipped && r.detectedTerms.length) {
    out.push("\n| Heard | KB term | KB id | Category | Score |\n|---|---|---|---|---|");
    for (const d of r.detectedTerms) out.push(`| ${d.heardAs} | ${d.name} | ${d.id} | ${d.category} | ${d.score}${d.uncertain ? " ⚠" : ""} |`);
  }

  out.push(`\n<sub>LLM: ${r.llm.skipped ? "skipped" : r.llm.model} · ${(r.llm.ms / 1000).toFixed(1)} s${r.asr ? ` · ASR: ${r.asr.backend} ${(r.asr.ms / 1000).toFixed(1)} s` : ""}</sub>`);
  return out.join("\n");
}
