/**
 * Bengali / Hindi number words → digits, as notes for the LLM.
 *
 * Number words from 1–100 are irregular in both languages (আটান্ন = 58, উনসত্তর = 69, अट्ठावन = 58), and the
 * LLM converted them wrongly (LEF evaluation: "আটান্ন" → age 69). Converting them here, deterministically,
 * and listing the results in the prompt removes that guesswork. The transcript itself is not changed.
 */
const BN: string[] = [
  "", "এক", "দুই", "তিন", "চার", "পাঁচ", "ছয়", "সাত", "আট", "নয়", "দশ",
  "এগারো", "বারো", "তেরো", "চোদ্দ", "পনেরো", "ষোলো", "সতেরো", "আঠারো", "উনিশ", "কুড়ি",
  "একুশ", "বাইশ", "তেইশ", "চব্বিশ", "পঁচিশ", "ছাব্বিশ", "সাতাশ", "আটাশ", "উনত্রিশ", "তিরিশ",
  "একত্রিশ", "বত্রিশ", "তেত্রিশ", "চৌত্রিশ", "পঁয়ত্রিশ", "ছত্রিশ", "সাঁইত্রিশ", "আটত্রিশ", "উনচল্লিশ", "চল্লিশ",
  "একচল্লিশ", "বিয়াল্লিশ", "তেতাল্লিশ", "চুয়াল্লিশ", "পঁয়তাল্লিশ", "ছেচল্লিশ", "সাতচল্লিশ", "আটচল্লিশ", "উনপঞ্চাশ", "পঞ্চাশ",
  "একান্ন", "বাহান্ন", "তিপ্পান্ন", "চুয়ান্ন", "পঞ্চান্ন", "ছাপ্পান্ন", "সাতান্ন", "আটান্ন", "উনষাট", "ষাট",
  "একষট্টি", "বাষট্টি", "তেষট্টি", "চৌষট্টি", "পঁয়ষট্টি", "ছেষট্টি", "সাতষট্টি", "আটষট্টি", "উনসত্তর", "সত্তর",
  "একাত্তর", "বাহাত্তর", "তিয়াত্তর", "চুয়াত্তর", "পঁচাত্তর", "ছিয়াত্তর", "সাতাত্তর", "আটাত্তর", "উনআশি", "আশি",
  "একাশি", "বিরাশি", "তিরাশি", "চুরাশি", "পঁচাশি", "ছিয়াশি", "সাতাশি", "অষ্টআশি", "উননব্বই", "নব্বই",
  "একানব্বই", "বিরানব্বই", "তিরানব্বই", "চুরানব্বই", "পঁচানব্বই", "ছিয়ানব্বই", "সাতানব্বই", "আটানব্বই", "নিরানব্বই",
];
const BN_ALT: Record<string, number> = { দু: 2, ছ: 6, চৌদ্দ: 14, বিশ: 20, ত্রিশ: 30, একশো: 100, একশ: 100, শো: 100 };

const HI: string[] = [
  "", "एक", "दो", "तीन", "चार", "पांच", "छह", "सात", "आठ", "नौ", "दस",
  "ग्यारह", "बारह", "तेरह", "चौदह", "पंद्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस", "बीस",
  "इक्कीस", "बाईस", "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस", "तीस",
  "इकतीस", "बत्तीस", "तैंतीस", "चौंतीस", "पैंतीस", "छत्तीस", "सैंतीस", "अड़तीस", "उनतालीस", "चालीस",
  "इकतालीस", "बयालीस", "तैंतालीस", "चवालीस", "पैंतालीस", "छियालीस", "सैंतालीस", "अड़तालीस", "उनचास", "पचास",
  "इक्यावन", "बावन", "तिरपन", "चौवन", "पचपन", "छप्पन", "सत्तावन", "अट्ठावन", "उनसठ", "साठ",
  "इकसठ", "बासठ", "तिरसठ", "चौंसठ", "पैंसठ", "छियासठ", "सड़सठ", "अड़सठ", "उनहत्तर", "सत्तर",
  "इकहत्तर", "बहत्तर", "तिहत्तर", "चौहत्तर", "पचहत्तर", "छिहत्तर", "सतहत्तर", "अठहत्तर", "उन्यासी", "अस्सी",
  "इक्यासी", "बयासी", "तिरासी", "चौरासी", "पचासी", "छियासी", "सत्तासी", "अट्ठासी", "नवासी", "नब्बे",
  "इक्यानवे", "बानवे", "तिरानवे", "चौरानवे", "पचानवे", "छियानवे", "सत्तानवे", "अट्ठानवे", "निन्यानवे",
];
const HI_ALT: Record<string, number> = { पाँच: 5, छः: 6, छे: 6, सौ: 100, "एक सौ": 100 };

/** Spelling-insensitive key: drop chandrabindu/anusvara/nukta and unify য়/য, ড়/ড. */
const key = (w: string) =>
  w.normalize("NFC").replace(/[ঁँंং़়]/g, "").replace(/য়/g, "য").replace(/ড়/g, "ড").replace(/ड़/g, "ड");

const TABLE = new Map<string, number>();
BN.forEach((w, i) => w && TABLE.set(key(w), i));
HI.forEach((w, i) => w && TABLE.set(key(w), i));
for (const [w, n] of Object.entries({ ...BN_ALT, ...HI_ALT })) TABLE.set(key(w), n);
const WORDS = [...TABLE.keys()].sort((a, b) => b.length - a.length);

/** Units that make a 1–10 number worth reporting (on their own, এক/দুই are too common to annotate). */
const UNIT = /^(বছর|বছরের|মাস|মাসের|দিন|দিনে|সপ্তাহ|ঘণ্টা|ঘন্টা|মিনিট|ফোঁটা|ফোটা|বার|বারে|सال|साल|महीने|महीना|दिन|हफ्ते|हफ़्ते|घंटे|मिनट|बूंद|बार)/;

/** endings speech recognition glues onto a number word; anything else (বিশেষ, তিনি) is a different word */
const SUFFIX = /^(ছে|ের|এর|ে|টা|টি|ও|তে|য|ই|वां|वीं|वें)?$/;

export interface NumberHit {
  heard: string;
  value: number;
}

/** Number words in the transcript with their value, e.g. «আটান্ন» = 58, «একশো আটচল্লিশ» = 148, «আট বছর» = 8. */
export function findNumbers(text: string): NumberHit[] {
  const toks = text.split(/[\s,।.?!;:()"'“”‘’-]+/).filter(Boolean);
  const out: NumberHit[] = [];
  const valueOf = (tok: string): { n: number; word: string } | null => {
    const k = key(tok);
    if (TABLE.has(k)) return { n: TABLE.get(k)!, word: tok };
    // a number word with a suffix glued on by speech recognition ("আটান্নছে", "বছরের")
    const w = WORDS.find((x) => x.length >= 3 && k.startsWith(x) && (x.length >= 5 || SUFFIX.test(k.slice(x.length))));
    return w ? { n: TABLE.get(w)!, word: tok } : null;
  };
  for (let i = 0; i < toks.length; i++) {
    const a = valueOf(toks[i]);
    if (!a) continue;
    let n = a.n, heard = toks[i], j = i;
    // "একশো আটচল্লিশ" / "एक सौ बीस" → 148 / 120 ; "দুশো" style hundreds are rare in clinic talk
    if (n === 100 || (n < 10 && toks[i + 1] && key(toks[i + 1]) === key("শো")) || (n < 10 && toks[i + 1] === "सौ")) {
      const hundreds = n === 100 ? 1 : n;
      if (n !== 100) j++;
      const b = toks[j + 1] ? valueOf(toks[j + 1]) : null;
      n = hundreds * 100 + (b && b.n < 100 ? b.n : 0);
      if (b && b.n < 100) j++;
      heard = toks.slice(i, j + 1).join(" ");
    }
    const unit = toks[j + 1] && UNIT.test(toks[j + 1]) ? toks[j + 1] : "";
    if (n >= 11 || unit) out.push({ heard: unit ? `${heard} ${unit}` : heard, value: n });
    i = j;
  }
  const seen = new Set<string>();
  return out.filter((h) => !seen.has(h.heard) && seen.add(h.heard)).slice(0, 30);
}

/** Prompt section, or "" when nothing was found. */
export function numbersNote(text: string): string {
  const hits = findNumbers(text);
  if (!hits.length) return "";
  return (
    "NUMBERS (number words in the transcript, decoded — use these values for age, durations, VA and pressure)\n" +
    hits.map((h) => `- «${h.heard}» = ${h.value}`).join("\n")
  );
}
