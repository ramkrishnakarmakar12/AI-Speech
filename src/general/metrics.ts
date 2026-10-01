/**
 * General transcription accuracy (any topic): transcript vs a reference text the user supplies.
 *
 * Works in the native script — Bengali is compared as Bengali, Hindi as Devanagari — so the score
 * does not depend on our transliteration. Normalisation removes things that are not recognition
 * errors: punctuation (incl. । ॥), case, zero-width joiners, speaker labels, and the digit script
 * (৬ / ६ / 6 all become 6).
 */
import { stripSpeakerLabels } from "../quality/wer.js";

const DIGITS: Record<string, string> = {};
"০১২৩৪৫৬৭৮৯".split("").forEach((d, i) => (DIGITS[d] = String(i)));
"०१२३४५६७८९".split("").forEach((d, i) => (DIGITS[d] = String(i)));

export function normalizeNative(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[০-৯०-९]/g, (d) => DIGITS[d] ?? d)
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, "$1\u0000$2") // keep 1.50 / 6,000 together
    .replace(/[^\p{L}\p{M}\p{N}\u0000\s/%]+/gu, " ")
    .replace(/\u0000/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

export const words = (s: string) => normalizeNative(s).split(" ").filter(Boolean);
export const chars = (s: string) => Array.from(normalizeNative(s).replace(/\s+/g, ""));

export type Op = "ok" | "sub" | "del" | "ins";
export interface AlignedWord {
  op: Op;
  ref?: string;
  hyp?: string;
}

/** Levenshtein alignment with back-trace (words or characters). */
function align<T>(ref: T[], hyp: T[]): { op: Op; r?: T; h?: T }[] {
  const n = ref.length, m = hyp.length;
  const d: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
  const out: { op: Op; r?: T; h?: T }[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      out.push({ op: ref[i - 1] === hyp[j - 1] ? "ok" : "sub", r: ref[i - 1], h: hyp[j - 1] });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      out.push({ op: "del", r: ref[i - 1] });
      i--;
    } else {
      out.push({ op: "ins", h: hyp[j - 1] });
      j--;
    }
  }
  return out.reverse();
}

function editDistance<T>(a: T[], b: T[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export interface AccuracyReport {
  /** word error rate = (S + D + I) / reference words */
  wer: number;
  /** character error rate (spaces ignored) — the fairer number for Bengali/Hindi spelling variants */
  cer: number;
  /** 1 − WER, floored at 0 */
  wordAccuracy: number;
  /** 1 − CER, floored at 0 */
  charAccuracy: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refWords: number;
  hypWords: number;
  /** transcribed characters ÷ reference characters (≪ 100% = audio was skipped) */
  coverage: number;
  /** the word alignment, for a highlighted diff */
  alignment: AlignedWord[];
  /** most frequent word confusions, e.g. "কাছের → চাষ" */
  topErrors: { ref: string; hyp: string; count: number }[];
}

export function accuracy(hypothesis: string, reference: string): AccuracyReport {
  const ref = stripSpeakerLabels(reference);
  const rw = words(ref), hw = words(hypothesis);
  const rc = chars(ref), hc = chars(hypothesis);
  // full alignment is O(n·m) memory; beyond ~4000×4000 words fall back to counts only
  const al = rw.length * hw.length <= 16e6 ? align(rw, hw) : null;
  if (!al) {
    const e = editDistance(hw, rw), c = editDistance(hc, rc);
    const w = rw.length ? e / rw.length : 1, ce = rc.length ? c / rc.length : 1;
    return { wer: round(w), cer: round(ce), wordAccuracy: round(Math.max(0, 1 - w)), charAccuracy: round(Math.max(0, 1 - ce)),
      substitutions: -1, deletions: -1, insertions: -1, refWords: rw.length, hypWords: hw.length,
      coverage: round(rc.length ? hc.length / rc.length : 0), alignment: [], topErrors: [] };
  }
  const count = (op: Op) => al.filter((a) => a.op === op).length;
  const S = count("sub"), D = count("del"), I = count("ins");
  const wer = rw.length ? (S + D + I) / rw.length : hw.length ? 1 : 0;
  const cer = rc.length ? editDistance(hc, rc) / rc.length : hc.length ? 1 : 0;
  const conf = new Map<string, number>();
  for (const a of al) if (a.op === "sub") conf.set(`${a.r}\u0001${a.h}`, (conf.get(`${a.r}\u0001${a.h}`) ?? 0) + 1);
  const topErrors = [...conf.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 15)
    .map(([k, c]) => ({ ref: k.split("\u0001")[0], hyp: k.split("\u0001")[1], count: c }));
  return {
    wer: round(wer),
    cer: round(cer),
    wordAccuracy: round(Math.max(0, 1 - wer)),
    charAccuracy: round(Math.max(0, 1 - cer)),
    substitutions: S,
    deletions: D,
    insertions: I,
    refWords: rw.length,
    hypWords: hw.length,
    coverage: round(rc.length ? hc.length / rc.length : 0),
    alignment: al.map((a) => ({ op: a.op, ref: a.r, hyp: a.h })),
    topErrors,
  };
}

/** How much the LLM changed the raw transcript (character edit ratio) — guards against rewriting. */
export function changeRatio(before: string, after: string): number {
  const a = chars(before), b = chars(after);
  return round(a.length ? editDistance(a, b) / a.length : b.length ? 1 : 0);
}

const round = (x: number) => Math.round(x * 1000) / 1000;
