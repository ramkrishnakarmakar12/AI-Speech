// Re-computes the numbers in general_accuracy_report.md.   npx tsx evaluation/general/run1_scripts/measure.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accuracy } from "../../../src/general/metrics.js";
const D = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(D, "../../../recordings/general");
const rd = (f: string) => fs.readFileSync(f, "utf8");
const rows: [string, string, string][] = [
  ["EN · Whisper vs script", "general_en.whisper.txt", path.join(R, "general_en.txt")],
  ["EN · Whisper vs script (numbers as digits)", "general_en.whisper.txt", path.join(D, "general_en.ref-numbers-as-digits.txt")],
  ["BN · IndicConformer vs script", "general_bn.conformer.txt", path.join(R, "general_bn.txt")],
  ["BN · IndicConformer vs script (names spoken)", "general_bn.conformer.txt", path.join(D, "general_bn.ref-names-spoken.txt")],
  ["HI · IndicConformer vs script", "general_hi.conformer.txt", path.join(R, "general_hi.txt")],
];
for (const [name, hyp, ref] of rows) {
  const a = accuracy(rd(path.join(D, hyp)), rd(ref));
  console.log(`${name.padEnd(46)} WER ${(a.wer * 100).toFixed(1)}%  CER ${(a.cer * 100).toFixed(1)}%  S/D/I ${a.substitutions}/${a.deletions}/${a.insertions}  ref words ${a.refWords}`);
}
