/**
 * Negation in Bengali, Hindi and English consultations: "সুগার প্রেশার নেই", "अस्थमा नहीं है",
 * "no vomiting", "asthma nahi hai". A negated condition must not become a complaint, a history item
 * or a drug-caution warning.
 *
 * Only EXISTENCE negators count. Inability is a symptom, not a denial:
 *   "কাছের জিনিস পড়তে পারছি না" (I can't read near things) and "दिखाई नहीं देता" (I can't see) stay positive.
 */

export interface NegatedSpan {
  phrase: string;
  start: number;
  end: number;
  negator: string;
}

const CLAUSE = /[।॥?!.,;:\n]+/u;
/** Bengali / Hindi: the negator follows the noun ("সুগার নেই", "शुगर नहीं है") */
const AFTER_NEG_BN = new Set(["নেই", "নাই", "নয়", "নেইতো", "নেই।"]);
const AFTER_NEG_HI = new Set(["नहीं", "नही", "नहीँ"]);
const HI_INABILITY = /^(पा|पाता|पाती|पाते|पाया|दिख|दिखता|दिखती|दिखाई|देख|देता|देती|सक|सकता|सकती|सकते|हो)$/;
const HI_BE = /^(है|हैं|था|थी|थे|हुआ|हुई)$/;
/** English / romanised: "no X", "without X", "denies X"; romanised Hindi/Bengali "X nahi (hai)", "X nei" */
const BEFORE_NEG_EN = new Set(["no", "without", "denies", "deny", "denied", "never", "negative"]);
const AFTER_NEG_ROMAN = new Set(["nahi", "nahin", "nai", "nei", "nahi.", "nei."]);
const EN_INABILITY = /^(can'?t|cannot|unable|couldn'?t)$/i;

interface Tok {
  w: string;
  start: number;
  end: number;
}

function tokens(clause: string, offset: number): Tok[] {
  const out: Tok[] = [];
  for (const m of clause.matchAll(/[^\s"'“”‘’()]+/gu)) out.push({ w: m[0], start: offset + m.index!, end: offset + m.index! + m[0].length });
  return out;
}

export function findNegations(text: string): NegatedSpan[] {
  const spans: NegatedSpan[] = [];
  let offset = 0;
  for (const clause of text.split(CLAUSE)) {
    const at = text.indexOf(clause, offset);
    offset = at >= 0 ? at + clause.length : offset;
    const toks = tokens(clause, at >= 0 ? at : 0);
    toks.forEach((t, i) => {
      const w = t.w.toLowerCase();
      const push = (from: number, to: number) => {
        const part = toks.slice(Math.max(0, from), Math.min(toks.length, to));
        if (!part.length) return;
        spans.push({ phrase: part.map((x) => x.w).join(" "), start: part[0].start, end: part.at(-1)!.end, negator: t.w });
      };
      if (AFTER_NEG_BN.has(t.w)) push(i - 3, i);
      else if (AFTER_NEG_HI.has(t.w)) {
        const prev = toks[i - 1]?.w ?? "";
        const next = toks[i + 1]?.w ?? "";
        if (HI_INABILITY.test(prev)) return; // "दिखाई नहीं देता" = can't see
        if (!next || HI_BE.test(next)) push(i - 3, i);
      } else if (AFTER_NEG_ROMAN.has(w)) push(i - 3, i);
      else if (BEFORE_NEG_EN.has(w)) {
        if (EN_INABILITY.test(toks[i - 1]?.w ?? "")) return;
        // "no vomiting", "no sugar", "no discharge or pain" (stop at "but")
        const stop = toks.findIndex((x, j) => j > i && /^(but|however|except)$/i.test(x.w));
        push(i + 1, Math.min(i + 5, stop > i ? stop : i + 5));
      } else if (/^(don'?t|doesn'?t|haven'?t|hasn'?t|didn'?t)$/i.test(w) && /^(have|has|had|get|feel)$/i.test(toks[i + 1]?.w ?? "")) push(i + 2, i + 5);
    });
  }
  return spans;
}

/** Is this position (a lexicon hit) inside a negated span? */
export const insideNegation = (start: number, end: number, spans: NegatedSpan[]) => spans.some((s) => start >= s.start && end <= s.end);
