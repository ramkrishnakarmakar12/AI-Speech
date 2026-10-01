/**
 * Lexical candidate retrieval: finds which knowledge-base terms are mentioned in a transcript.
 * Handles exact phrases, abbreviations (case-sensitive), ASR misspellings (fuzzy), brand → generic,
 * colloquial Hindi/Bengali phrases and long patient phrasings (token overlap).
 * The LLM only sees these candidates, which keeps prompts small and grounds output to KB ids.
 */
import type { KnowledgeBase, Scenario, Term } from "../kb/types.js";
import { hasIndicScript, transliterate } from "./translit.js";

export interface Match {
  term: Term;
  score: number; // 0..1
  form: string; // KB surface form that matched
  heardAs: string; // span from transcript
  kind: "exact" | "abbr" | "fuzzy" | "overlap";
  count: number;
  /** heard in a part of the audio the ASR itself was unsure about (stage-1 low-confidence words) */
  uncertain?: boolean;
}

/** Stage-3 thresholds; set per transcript-accuracy tier by policyFor() in quality/accuracy.ts */
export interface MatchOptions {
  /** min fuzzy similarity on Latin-script (English / romanised) text. Default 0.8 */
  fuzzyMinLatin?: number;
  /** min fuzzy similarity on Devanagari/Bengali text (after transliteration). Default 0.8 */
  fuzzyMinIndic?: number;
}

const STOP = new Set(
  "a an the and or of to in on at for with is are was were be been it its this that my your i you he she we they me him her them do does did have has had not no yes can cant cannot from by as but so if then than there here what when where which who how very also just like get got one some any all more less much many".split(
    " ",
  ),
);

/**
 * Phonetic key so spellings from different scripts/ASR passes meet:
 * "moksiphloksasin" (from Devanagari) ≈ "moxifloxacin", "chokh" ≈ "chok", "aankh" ≈ "ankh".
 */
export function phoneticKey(s: string, loose = false): string {
  let k = s;
  if (loose) k = k.replace(/sch/g, "s").replace(/sh/g, "s"); // Schirmer ≈ শিরমার "shirmar"
  k = k
    .replace(/ph/g, "f")
    .replace(/x/g, "ks")
    .replace(/ck/g, "k")
    .replace(/c(?!h)/g, "k")
    .replace(/q/g, "k")
    .replace(/w/g, "v")
    .replace(/v/g, "b") // Bengali has no v: ভার্নাল = vernal
    .replace(/z/g, "j")
    .replace(/([kgcjtdpb])h/g, "$1")
    .replace(/ee|ii/g, "i")
    .replace(/oo|uu/g, "u")
    .replace(/aa/g, "a")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
  // loose (romanised Hindi/Bengali only): vowel clusters differ most between scripts,
  // "drai ai" ≈ "dry eye". Too permissive for real English text ("do you" ≈ "dry eye").
  return loose ? k.replace(/[aeiou]{2,}/g, (m) => (m.includes("i") ? "i" : m[0])) : k;
}

/** consonant skeleton of a phonetic key (keeps the first letter) — catches vowel-heavy transliteration drift */
const skeleton = (k: string) => k[0] + k.slice(1).replace(/[aeiou]/g, "");

export function normalize(s: string): string {
  if (hasIndicScript(s)) s = transliterate(s);
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/(\d)\.(\d)/g, "$1<dot>$2")
    .replace(/([a-z0-9])\/([a-z0-9])/g, "$1<sl>$2")
    .replace(/([a-z0-9]):([a-z0-9])/g, "$1<co>$2")
    .replace(/[^a-z0-9%+<>]+/g, " ")
    .replace(/<dot>/g, ".")
    .replace(/<sl>/g, "/")
    .replace(/<co>/g, ":")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) => (s ? s.split(" ") : []);

/** Levenshtein with early exit when distance exceeds `max`. */
export function lev(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

interface Form {
  term: Term;
  raw: string;
  norm: string;
  toks: string[];
  joined: string; // norm without spaces (for fuzzy)
  pkey: string; // phonetic key of joined
  pkeyLoose: string; // loose phonetic key (for romanised Indic text)
  sk: string; // consonant skeleton of pkey
  mode: "abbr" | "phrase" | "overlap";
  content: string[]; // content tokens (overlap mode)
  weight: number;
}

let formCache: { kb: KnowledgeBase; forms: Form[] } | null = null;

function buildForms(kb: KnowledgeBase): Form[] {
  if (formCache?.kb === kb) return formCache.forms;
  const forms: Form[] = [];
  const seen = new Set<string>();
  for (const term of kb.terms) {
    const surfaces: [string, number][] = [
      [term.name, 1],
      ...term.aliases.map((a) => [a, 0.95] as [string, number]),
      ...term.colloquial.map((c) => [c, 0.9] as [string, number]),
    ];
    for (const [raw, weight] of surfaces) {
      const norm = normalize(raw);
      if (!norm || norm.length < 2) continue;
      const key = term.id + "|" + norm;
      if (seen.has(key)) continue;
      seen.add(key);
      const toks = tokens(norm);
      // Short abbreviations (RE, OD, AT, PE, NS…) collide with English words → require exact case.
      const isAbbr = raw.replace(/[^A-Za-z]/g, "").length <= 4 && /[A-Z]{2}/.test(raw) && toks.length <= 2;
      const content = toks.filter((t) => !STOP.has(t) && t.length > 2);
      const mode: Form["mode"] = isAbbr ? "abbr" : toks.length >= 5 ? "overlap" : "phrase";
      if (mode === "overlap" && content.length < 3) continue;
      forms.push({ term, raw, norm, toks, joined: toks.join(""), pkey: phoneticKey(toks.join("")), pkeyLoose: phoneticKey(toks.join(""), true), sk: skeleton(phoneticKey(toks.join(""))), mode, content, weight });
    }
  }
  formCache = { kb, forms };
  return forms;
}

/**
 * Lines written in Devanagari/Bengali script are matched with looser phonetic rules than
 * English lines (the English translation is usually appended to the same text).
 */
export function findMatches(transcript: string, kb: KnowledgeBase, opts: MatchOptions = {}): Match[] {
  const lines = transcript.split("\n");
  const indic = lines.filter(hasIndicScript).join("\n");
  const latin = lines.filter((l) => !hasIndicScript(l)).join("\n");
  const fLatin = opts.fuzzyMinLatin ?? 0.8;
  const fIndic = opts.fuzzyMinIndic ?? 0.8;
  if (!indic.trim()) return matchCore(latin, kb, false, fLatin);
  if (!latin.trim()) return matchCore(indic, kb, true, fIndic);
  const best = new Map<string, Match>();
  for (const m of [...matchCore(latin, kb, false, fLatin), ...matchCore(indic, kb, true, fIndic)]) {
    const cur = best.get(m.term.id);
    if (!cur || m.score > cur.score) best.set(m.term.id, m);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.count - a.count);
}

function matchCore(transcript: string, kb: KnowledgeBase, loose: boolean, fuzzyMin = 0.8): Match[] {
  const forms = buildForms(kb);
  const normT = normalize(transcript);
  const tt = tokens(normT);
  const padded = ` ${normT} `;
  // Original-case tokens for abbreviation matching
  const rawToks = new Set(transcript.split(/[^A-Za-z0-9/:+]+/).filter(Boolean));
  const rawText = transcript;

  // Pre-compute n-gram windows (joined without spaces) for fuzzy matching
  const windows = new Map<number, { s: string; k: string; sk: string; span: string }[]>();
  for (let n = 1; n <= 5; n++) {
    const arr: { s: string; k: string; sk: string; span: string }[] = [];
    for (let i = 0; i + n <= tt.length; i++) {
      const w = tt.slice(i, i + n);
      const s = w.join("");
      const k = phoneticKey(s, loose);
      arr.push({ s, k, sk: skeleton(k), span: w.join(" ") });
    }
    windows.set(n, arr);
  }
  const tokenSet = new Set(tt);

  const best = new Map<string, Match>();
  const record = (f: Form, score: number, heardAs: string, kind: Match["kind"], count = 1) => {
    const s = Math.min(1, score * f.weight);
    const cur = best.get(f.term.id);
    if (!cur || s > cur.score) best.set(f.term.id, { term: f.term, score: s, form: f.raw, heardAs, kind, count: Math.max(count, cur?.count ?? 0) });
    else cur.count = Math.max(cur.count, count);
  };

  for (const f of forms) {
    if (f.mode === "abbr") {
      const variants = [f.raw, f.raw.replace(/\./g, "")];
      const hit = variants.find((v) => (v.includes(" ") || /[/:+]/.test(v) ? rawText.includes(v) : rawToks.has(v)));
      if (hit) record(f, 0.9, hit, "abbr");
      continue;
    }

    if (f.mode === "overlap") {
      // coverage of content words inside a local window of the transcript
      const need = f.content;
      if (need.filter((t) => tokenSet.has(t)).length / need.length < 0.6) continue;
      const win = Math.max(need.length * 3, 12);
      let bestCov = 0;
      let bestSpan = "";
      for (let i = 0; i < tt.length; i += 2) {
        const slice = tt.slice(i, i + win);
        const set = new Set(slice);
        const cov = need.filter((t) => set.has(t)).length / need.length;
        if (cov > bestCov) {
          bestCov = cov;
          bestSpan = slice.join(" ");
        }
      }
      if (bestCov >= 0.6) record(f, 0.5 + 0.35 * bestCov, bestSpan, "overlap");
      continue;
    }

    // exact phrase
    const needle = ` ${f.norm} `;
    let idx = padded.indexOf(needle);
    if (idx >= 0) {
      let count = 0;
      while (idx >= 0) {
        count++;
        idx = padded.indexOf(needle, idx + 1);
      }
      record(f, 1, f.norm, "exact", count);
      continue;
    }

    // fuzzy (ASR misspellings, split words: "lata no prost" → latanoprost)
    const L = f.joined.length;
    const isName = f.raw === f.term.name;
    if (L < (isName || f.toks.length > 1 ? 6 : 7) || f.toks.length > 4) continue;
    const maxD = L >= 12 ? 3 : L >= 8 ? 2 : 1;
    let bestSim = 0;
    let bestSpan = "";
    for (let n = Math.max(1, f.toks.length - 1); n <= Math.min(5, f.toks.length + 2); n++) {
      for (const w of windows.get(n)!) {
        if (Math.abs(w.s.length - L) > maxD + 2) continue;
        if (w.s[0] !== f.joined[0] && f.pkey[0] !== w.k[0] && (L < 9 || w.s.slice(-3) !== f.joined.slice(-3))) continue;
        let d = Math.min(lev(w.s, f.joined, maxD), lev(w.k, loose ? f.pkeyLoose : f.pkey, maxD));
        // long words: compare consonant skeletons ("kanjantibaitis" ≈ "conjunctivitis")
        let skeletonHit = false;
        if (d > maxD && f.sk.length >= 7) {
          const skMax = f.sk.length >= 12 ? 2 : 1;
          if (lev(w.sk, f.sk, skMax) <= skMax) {
            d = maxD;
            skeletonHit = true;
          }
        }
        if (d <= maxD) {
          // joining/splitting words is a common ASR error, but demands a closer match
          let sim = 1 - d / Math.max(L, w.s.length) - (n !== f.toks.length && d > 0 ? 0.06 : 0);
          // same consonant skeleton ("karniyal alsar" ≈ "corneal ulcer"): transliteration drift, not a different word
          if (skeletonHit) sim = Math.max(sim, 0.82);
          if (sim > bestSim) {
            bestSim = sim;
            bestSpan = w.span;
          }
        }
      }
    }
    if (bestSim >= fuzzyMin) record(f, 0.95 * bestSim, bestSpan, "fuzzy");
  }

  // Drop fuzzy/overlap hits whose transcript span sits inside a stronger match's span
  // (e.g. "flox acin" → Ofloxacin inside "moxi flox acin" → Moxifloxacin)
  const all = [...best.values()].sort((a, b) => b.score - a.score || b.count - a.count);
  return all.filter(
    (m) =>
      m.kind === "exact" ||
      m.kind === "abbr" ||
      !all.some((o) => o !== m && o.score >= m.score && o.kind !== "overlap" && o.heardAs.length > m.heardAs.length && o.heardAs.includes(m.heardAs)),
  );
}

/** Pick candidates for the LLM: best matches, capped, with a per-category floor so nothing is crowded out. */
export function selectCandidates(matches: Match[], max: number, minScore = 0.6): Match[] {
  const strong = matches.filter((m) => m.score >= minScore);
  if (strong.length <= max) return strong;
  const byCat = new Map<string, Match[]>();
  for (const m of strong) byCat.set(m.term.category, [...(byCat.get(m.term.category) ?? []), m]);
  const out = new Set<Match>();
  const floor = Math.max(3, Math.floor(max / (byCat.size * 2)));
  for (const arr of byCat.values()) arr.slice(0, floor).forEach((m) => out.add(m));
  for (const m of strong) {
    if (out.size >= max) break;
    out.add(m);
  }
  return [...out].sort((a, b) => b.score - a.score);
}

/** Choose the conversation scenario(s) most similar to what was matched — used as a style example. */
export function pickScenarios(matches: Match[], kb: KnowledgeBase, k = 1): Scenario[] {
  const keys = matches
    .filter((m) => ["disease", "medicine", "procedure", "symptom"].includes(m.term.category))
    .flatMap((m) => [m.term.name, ...m.term.aliases].map(normalize))
    .filter((s) => s.length >= 3);
  const scored = kb.scenarios.map((s) => {
    const text = ` ${normalize(Object.values(s).join(" "))} `;
    const score = keys.reduce((acc, k) => acc + (text.includes(` ${k} `) ? 1 : 0), 0);
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.s);
}
