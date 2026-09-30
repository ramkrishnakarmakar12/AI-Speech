/**
 * Reference-based accuracy: WER / CER between an ASR transcript and a known script
 * (e.g. the recording scripts in evaluation/scripts). Used when a reference is supplied;
 * otherwise accuracy is estimated without one (see accuracy.ts).
 */
import { normalize } from "../match/matcher.js";

/** Remove "Doctor:", "ডাক্তার:", "मरीज़:" style speaker labels — ASR never writes them. */
export function stripSpeakerLabels(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/^\s*[^\s:：]{1,20}(?:\s+[^\s:：]{1,20}){0,2}\s*[:：]\s*/u, ""))
    .join("\n");
}

function editDistance<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (ai === b[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Letters/digits only, native script kept (CER must not depend on our transliteration). */
const charSeq = (s: string) => Array.from(s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ""));

export interface ErrorRates {
  wer: number;
  cer: number;
  refWords: number;
  refChars: number;
}

export function errorRates(hypothesis: string, reference: string): ErrorRates {
  const ref = stripSpeakerLabels(reference);
  const rw = normalize(ref).split(" ").filter(Boolean);
  const hw = normalize(hypothesis).split(" ").filter(Boolean);
  const rc = charSeq(ref);
  const hc = charSeq(hypothesis);
  return {
    wer: rw.length ? editDistance(hw, rw) / rw.length : 0,
    cer: rc.length ? editDistance(hc, rc) / rc.length : 0,
    refWords: rw.length,
    refChars: rc.length,
  };
}
