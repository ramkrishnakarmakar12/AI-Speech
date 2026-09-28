/**
 * Rough Devanagari (Hindi) and Bengali script → Roman transliteration, used only for term matching.
 * The sheet's colloquial terms are written in Roman ("Motiyabind", "Chokh lal"), and Whisper writes
 * Hindi/Bengali audio in native script ("मोतियाबिंद", "চোখ লাল"). This bridges the two.
 */

// Offsets inside each Unicode block (Devanagari U+0900, Bengali U+0980 share the same layout)
const VOWELS: Record<number, string> = {
  0x05: "a", 0x06: "aa", 0x07: "i", 0x08: "ee", 0x09: "u", 0x0a: "oo", 0x0b: "ri",
  0x0f: "e", 0x10: "ai", 0x13: "o", 0x14: "au", 0x0d: "e", 0x11: "o",
};
const CONSONANTS: Record<number, string> = {
  0x15: "k", 0x16: "kh", 0x17: "g", 0x18: "gh", 0x19: "ng",
  0x1a: "ch", 0x1b: "chh", 0x1c: "j", 0x1d: "jh", 0x1e: "ny",
  0x1f: "t", 0x20: "th", 0x21: "d", 0x22: "dh", 0x23: "n",
  0x24: "t", 0x25: "th", 0x26: "d", 0x27: "dh", 0x28: "n",
  0x2a: "p", 0x2b: "ph", 0x2c: "b", 0x2d: "bh", 0x2e: "m",
  0x2f: "y", 0x30: "r", 0x32: "l", 0x33: "l", 0x35: "v",
  0x36: "sh", 0x37: "sh", 0x38: "s", 0x39: "h",
  0x5c: "r", 0x5d: "rh", 0x5e: "f", 0x5f: "y", 0x58: "q", 0x59: "kh", 0x5a: "g", 0x5b: "z",
  0xdc: "r", 0xdd: "rh", 0xdf: "y", // Bengali ড় ঢ় য়
};
const MATRAS: Record<number, string> = {
  0x3e: "a", 0x3f: "i", 0x40: "i", 0x41: "u", 0x42: "u", 0x43: "ri",
  0x47: "e", 0x48: "ai", 0x4b: "o", 0x4c: "au", 0x45: "e", 0x49: "o",
};
const VIRAMA = 0x4d;
const NUKTA = 0x3c;
const ANUSVARA = 0x02;
const CANDRABINDU = 0x01;
const VISARGA = 0x03;
const DIGITS0 = 0x66;

const isBengali = (cp: number) => cp >= 0x0980 && cp <= 0x09ff;

function blockOffset(cp: number): number | null {
  if (cp >= 0x0900 && cp <= 0x097f) return cp - 0x0900;
  if (cp >= 0x0980 && cp <= 0x09ff) return cp - 0x0980;
  return null;
}

export const hasIndicScript = (s: string) => /[ऀ-৿]/.test(s);

export function transliterate(input: string): string {
  let out = "";
  const cps = [...input].map((c) => c.codePointAt(0)!);
  /** true when the output so far ends in a vowel sound or a consonant cluster (virama) */
  let prevOpen = false;
  for (let i = 0; i < cps.length; i++) {
    const off = blockOffset(cps[i]);
    if (off === null) {
      out += String.fromCodePoint(cps[i]);
      prevOpen = false;
      continue;
    }
    const cons = CONSONANTS[off];
    if (cons !== undefined) {
      out += cons;
      // look ahead: nukta, matra, virama → otherwise inherent "a"
      let j = i + 1;
      if (blockOffset(cps[j] ?? 0) === NUKTA) j++;
      const next = blockOffset(cps[j] ?? 0);
      if (next !== null && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        i = j;
        prevOpen = true;
      } else if (next === VIRAMA) {
        i = j;
        prevOpen = true;
        // Bengali ya-phala (C + ্ + য) is not pronounced as "y": ক্যা → "ka", প্যা → "pa"
        if (isBengali(cps[i]) && blockOffset(cps[j + 1] ?? 0) === 0x2f) {
          i = j + 1;
          const m = blockOffset(cps[i + 1] ?? 0);
          if (m !== null && MATRAS[m] !== undefined) {
            out += MATRAS[m];
            i++;
          }
        }
      } else {
        // schwa deletion: none at word end ("motiyabind"), none in V-C(a)-C+vowel ("dikhta", "chulkay", "dhundhla")
        const atWordEnd = next === null || (CONSONANTS[next] === undefined && VOWELS[next] === undefined && next !== ANUSVARA && next !== CANDRABINDU);
        let k = j;
        if (!atWordEnd && CONSONANTS[next!] !== undefined) {
          k = j + 1;
          if (blockOffset(cps[k] ?? 0) === NUKTA) k++;
        }
        const nextHasVowel: boolean = !atWordEnd && CONSONANTS[next!] !== undefined && MATRAS[blockOffset(cps[k] ?? 0) ?? -1] !== undefined;
        const drop: boolean = atWordEnd || (prevOpen && nextHasVowel);
        out += drop ? "" : "a";
        prevOpen = !drop;
        i = j - 1;
      }
      continue;
    }
    prevOpen = true;
    // Bengali অ্যা (æ, as in "অ্যালার্জি" allergy) → "a"
    if (off === 0x05 && isBengali(cps[i]) && blockOffset(cps[i + 1] ?? 0) === VIRAMA && blockOffset(cps[i + 2] ?? 0) === 0x2f) {
      out += "a";
      i += 2;
      if (blockOffset(cps[i + 1] ?? 0) === 0x3e) i++;
      continue;
    }
    if (VOWELS[off] !== undefined) out += off === 0x05 && isBengali(cps[i]) ? "o" : VOWELS[off];
    else if (off === ANUSVARA || off === CANDRABINDU) out += "n";
    else if (off === VISARGA) out += "h";
    else if (off >= DIGITS0 && off <= DIGITS0 + 9) out += String(off - DIGITS0);
    else if (off === 0x64 || off === 0x65) out += ". "; // danda
    // other signs dropped
  }
  return out;
}
