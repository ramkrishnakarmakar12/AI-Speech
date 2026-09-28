/**
 * Converts the Ophthalmology Vocabulary workbook into a normalized knowledge base:
 *   data/kb.json      – every term with id, category, canonical name, aliases, colloquial phrases, details
 *   data/hotwords.txt – vocabulary list used to bias the ASR model toward medical spellings
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "../config.js";
import type { KnowledgeBase, Scenario, Term, TermCategory } from "./types.js";

interface SheetSpec {
  sheet: string;
  category: TermCategory;
  /** header of canonical name column */
  name: string;
  /** headers whose values are abbreviations / synonyms / brands */
  aliasCols?: string[];
  /** headers whose values are lay / colloquial phrases */
  colloquialCols?: string[];
  /** for Rx Abbreviations the "name" is the full form and the abbreviation is the alias */
}

const SPECS: SheetSpec[] = [
  { sheet: "Diseases & Conditions", category: "disease", name: "Disease / Condition", aliasCols: ["Abbreviation / Synonyms"], colloquialCols: ["Colloquial Term (Hindi / Bengali)"] },
  { sheet: "Symptoms & Complaints", category: "symptom", name: "Symptom (Medical Term)", colloquialCols: ["Colloquial (Hindi / Bengali)", "Patient's Words (English)"] },
  { sheet: "Examination & Tests", category: "test", name: "Examination / Test", aliasCols: ["Abbreviation"] },
  { sheet: "Clinical Signs", category: "sign", name: "Clinical Sign / Finding", aliasCols: ["Abbreviation"] },
  { sheet: "Medicines", category: "medicine", name: "Generic Name", aliasCols: ["Example Brands (India, indicative)"] },
  { sheet: "Procedures & Surgery", category: "procedure", name: "Procedure / Surgery", aliasCols: ["Abbreviation"] },
  { sheet: "Optical & Refraction", category: "optical", name: "Term", aliasCols: ["Abbreviation / Notation"] },
  { sheet: "Rx Abbreviations", category: "abbreviation", name: "Full Form", aliasCols: ["Abbreviation"] },
  { sheet: "Counselling & Advice", category: "counselling", name: "Instruction / Phrase Used with Patient" },
  { sheet: "Eye Anatomy", category: "anatomy", name: "Structure" },
];

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return String(v.result ?? "");
    if ("text" in v) return String((v as any).text);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
};

/** Qualifier words that appear in synonym cells but are useless (or harmful) as standalone aliases */
const GENERIC = new Set(
  "mild moderate severe early late advanced acute chronic trauma narrow fine flare hole dust shadow secondary primary external internal diode steroid culture membrane elsewhere accurate inaccurate seasonal perennial oblique blindness dislocation tomography tractional exudative deprivation endoscopic post-cataract well-centred after-cataract indirect direct distance near right left both before after daily weekly monthly redness pain surgery lens drops macula nebula shield trial glasses hospital commercial preparations generic various fortified".split(" "),
);

/** Single lowercase words are only kept as aliases when they look like real medical terms. */
export function usefulAlias(a: string, category: TermCategory): boolean {
  const plain = a.replace(/[)(]/g, "").trim();
  if (!plain || GENERIC.has(plain.toLowerCase())) return false;
  if (category === "medicine") return plain.length >= 3;
  if (/\s/.test(plain)) return true; // multi-word phrase
  if (/[A-Z]{2,}|\d/.test(plain)) return plain.length >= 2; // abbreviation / notation
  return plain.length >= 5;
}

const EMPTY = new Set(["", "—", "-", "–", "n/a", "na", "none"]);

const clean = (s: string) =>
  s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Split a synonyms cell like "Senile cataract, SIC (senile immature cataract)" into alias strings. */
export function splitAliases(raw: string): string[] {
  let s = clean(raw);
  if (EMPTY.has(s.toLowerCase())) return [];
  s = s.replace(/\((H|B)\)/g, "").replace(/\be\.g\.,?\s*/gi, "");
  const out = new Set<string>();
  // pull out parenthetical content as separate aliases: "RE / OD (oculus dexter)"
  const parens = [...s.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const withoutParens = s.replace(/\([^)]*\)/g, " ");
  for (const chunk of [withoutParens, ...parens]) {
    for (const part of chunk.split(/\s+\/\s+|,|;|\s+or\s+/i)) {
      const p = clean(clean(part).replace(/^(graded|also|incl\.?)\s+/i, ""));
      if (p.length >= 1 && p.length <= 60 && !EMPTY.has(p.toLowerCase())) out.add(p);
    }
  }
  return [...out];
}

/** Aliases derived from the canonical name itself, e.g. "Nuclear cataract (nuclear sclerosis)". */
export function nameVariants(name: string): string[] {
  const n = clean(name);
  const out = new Set<string>();
  const trailing = n.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (trailing) {
    out.add(clean(trailing[1]));
    // keep paren content only if it is an abbreviation ("DOV") or a real synonym ("nuclear sclerosis"),
    // not a qualifier like "(distance)"
    for (const p of trailing[2].split(/,|\s+\/\s+|;/).map(clean))
      if (/[A-Z]{2,}/.test(p) || p.split(" ").length >= 2) out.add(p);
  } else if (/\(/.test(n)) {
    out.add(clean(n.replace(/\([^)]*\)/g, " "))); // "Age-related cataract"
    out.add(clean(n.replace(/[()]/g, " "))); // "Age-related senile cataract"
  }
  if (n.includes(" / ")) for (const p of n.split(" / ")) out.add(clean(p.replace(/[()]/g, "")));
  out.delete(n);
  return [...out].filter((x) => x.length >= 2);
}

function splitColloquial(raw: string, header: string): string[] {
  const s = clean(raw);
  if (EMPTY.has(s.toLowerCase())) return [];
  // Patient's own English words: keep the phrase whole (it contains " / " alternatives)
  if (/patient/i.test(header)) {
    return s
      .split(/"\s*[,;]\s*"|"\s*\/\s*"/)
      .map(clean)
      .filter(Boolean);
  }
  return splitAliases(s);
}

export async function buildKb(xlsxPath = config.paths.xlsx): Promise<KnowledgeBase> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const terms: Term[] = [];
  const counts: Record<string, number> = {};

  for (const spec of SPECS) {
    const ws = wb.getWorksheet(spec.sheet);
    if (!ws) {
      console.warn(`⚠ sheet not found: ${spec.sheet} (skipped)`);
      continue;
    }
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, col) => (headers[col] = clean(cellText(c.value))));
    const col = (h: string) => headers.findIndex((x) => x === h);
    const nameCol = col(spec.name);
    if (nameCol < 0) throw new Error(`Column "${spec.name}" not found in sheet "${spec.sheet}". Headers: ${headers.join(" | ")}`);

    ws.eachRow((row, r) => {
      if (r === 1) return;
      const get = (c: number) => (c > 0 ? clean(cellText(row.getCell(c).value)) : "");
      const id = get(1);
      const name = get(nameCol);
      if (!id || !name) return;

      const aliases = new Set<string>(nameVariants(name));
      for (const h of spec.aliasCols ?? []) for (const a of splitAliases(get(col(h)))) aliases.add(a);
      const colloquial = new Set<string>();
      for (const h of spec.colloquialCols ?? []) for (const a of splitColloquial(get(col(h)), h)) colloquial.add(a);

      const details: Record<string, string> = {};
      headers.forEach((h, c) => {
        if (!h || c === 1 || c === nameCol) return;
        const v = get(c);
        if (v && !EMPTY.has(v.toLowerCase())) details[h] = v;
      });

      // "Dry eye disease" is usually said as just "dry eye"
      if (spec.category === "disease" && / disease$/i.test(name)) aliases.add(clean(name).replace(/ disease$/i, ""));
      // medicines are usually spoken by their first word: "Timolol" for "Timolol maleate"
      if (spec.category === "medicine") {
        const head = clean(name).split(/[\s(/+]/)[0];
        const vague = /^(sodium|vitamin|intravitreal|intracameral|intraocular|hydroxypropyl|polyethylene|silicone|paraffin|omega-3|tea-tree|viscoelastic)$/i;
        if (head.length >= 6 && !name.includes("+") && !vague.test(head) && head.toLowerCase() !== clean(name).toLowerCase()) aliases.add(head);
      }
      aliases.delete(name);
      for (const a of [...aliases]) if (!usefulAlias(a, spec.category)) aliases.delete(a);
      terms.push({ id, category: spec.category, name: clean(name), aliases: [...aliases], colloquial: [...colloquial], details });
      counts[spec.category] = (counts[spec.category] ?? 0) + 1;
    });
  }

  // Conversation scenarios → used as few-shot style examples for the LLM
  const scenarios: Scenario[] = [];
  const sws = wb.getWorksheet("Conversation Scenarios");
  if (sws) {
    sws.eachRow((row, r) => {
      if (r === 1) return;
      const g = (c: number) => clean(cellText(row.getCell(c).value));
      if (!g(1)) return;
      scenarios.push({ id: g(1), scenario: g(2), complaint: g(3), history: g(4), exam: g(5), diagnosis: g(6), plan: g(7), advice: g(8) });
    });
  }
  counts.scenario = scenarios.length;

  return { source: path.basename(xlsxPath), builtAt: new Date().toISOString(), counts, terms, scenarios };
}

/** Vocabulary string used to bias ASR decoding toward correct medical spellings. */
export function buildHotwords(kb: KnowledgeBase, maxChars: number): string {
  const pick: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const k = s.toLowerCase();
    if (s.length < 3 || seen.has(k) || /[()"]/.test(s)) return;
    seen.add(k);
    pick.push(s);
  };
  // Priority: medicines (generic, then brands) > diseases > procedures > tests > signs
  const order: TermCategory[] = ["medicine", "disease", "procedure", "test", "sign", "anatomy"];
  const byCat = (c: TermCategory) => kb.terms.filter((t) => t.category === c);
  for (const c of order) for (const t of byCat(c)) add(t.name.replace(/\s*\(.*\)/, ""));
  for (const t of byCat("medicine")) t.aliases.forEach(add);
  for (const c of ["disease", "procedure", "test"] as TermCategory[])
    for (const t of byCat(c)) t.aliases.filter((a) => /[A-Z]{2,}/.test(a) || a.length > 5).forEach(add);

  let out = "";
  for (const w of pick) {
    const next = out ? `${out}, ${w}` : w;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}

export async function buildAndSave(): Promise<KnowledgeBase> {
  const kb = await buildKb();
  fs.mkdirSync(path.dirname(config.paths.kb), { recursive: true });
  fs.writeFileSync(config.paths.kb, JSON.stringify(kb, null, 2));
  fs.writeFileSync(config.paths.hotwords, buildHotwords(kb, 20_000));
  return kb;
}

let cached: KnowledgeBase | null = null;
export function loadKb(): KnowledgeBase {
  if (cached) return cached;
  if (!fs.existsSync(config.paths.kb)) throw new Error(`Knowledge base not built. Run: npm run build-kb`);
  cached = JSON.parse(fs.readFileSync(config.paths.kb, "utf8")) as KnowledgeBase;
  return cached;
}
