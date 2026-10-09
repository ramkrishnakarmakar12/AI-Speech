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
const BN_ALT: Record<string, number> = {
  দু: 2, ছ: 6, চৌদ্দ: 14, বিশ: 20, ত্রিশ: 30, একশো: 100, একশ: 100, শো: 100,
  // spoken / ASR spellings of the same numbers ("বাম আঠেরো" was read as 8 in a real run)
  এগার: 11, তের: 13, চোদ্দো: 14, পনের: 15, ষোল: 16, সতের: 17, আঠেরো: 18, আঠের: 18, আঠার: 18, আঠাশ: 28,
  শূন্য: 0, শুন্য: 0, জিরো: 0,
  // English digits spoken in Bengali script ("ওয়ান পয়েন্ট ফাইভ অ্যাড")
  ওয়ান: 1, থ্রি: 3, ফোর: 4, ফাইভ: 5, সিক্স: 6, সেভেন: 7, এইট: 8, নাইন: 9,
};

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
const HI_ALT: Record<string, number> = { पाँच: 5, छः: 6, छे: 6, सौ: 100, "एक सौ": 100, अट्ठारह: 18, शून्य: 0, जीरो: 0, ज़ीरो: 0, वन: 1, थ्री: 3, फोर: 4, फाइव: 5, सिक्स: 6, सेवन: 7, नाइन: 9 };

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

/** "শূন্য দশমিক চার" / "जीरो पॉइंट सात" / "zero point four" = 0.4, 0.7 (cup–disc ratio, add power) */
const DECIMAL = /^(দশমিক|পয়েন্ট|পয়েন্ট|পইন্ট|দশমলব|दशमलव|पॉइंट|पॉइन्ट|प्वाइंट|point)$/i;
const EN_NUM: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
};

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
  const digitOf = (tok: string | undefined): number | null => {
    if (!tok) return null;
    if (/^\d$/.test(tok)) return Number(tok);
    const v = valueOf(tok);
    return v && v.n < 10 ? v.n : EN_NUM[tok.toLowerCase()] ?? null;
  };
  for (let i = 0; i < toks.length; i++) {
    const lead = valueOf(toks[i]) ?? (EN_NUM[toks[i].toLowerCase()] !== undefined ? { n: EN_NUM[toks[i].toLowerCase()], word: toks[i] } : null);
    // decimal: <number> দশমিক/point <digit> [<digit>]
    if (lead && toks[i + 1] && DECIMAL.test(toks[i + 1]) && digitOf(toks[i + 2]) !== null) {
      let j = i + 2, frac = "";
      while (digitOf(toks[j]) !== null && frac.length < 2) frac += String(digitOf(toks[j++]));
      out.push({ heard: toks.slice(i, j).join(" "), value: Number(`${lead.n}.${frac}`) });
      i = j - 1;
      continue;
    }
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

/**
 * Every number value said in the text — digits (ASCII, Bengali, Devanagari), English number words, Bengali/Hindi
 * number words of any size and decimals (findNumbers() only reports ≥ 11 or numbers with a unit). Used to check
 * that a value in the draft (IOP, visual acuity) was really said.
 */
export function allNumberValues(text: string): Set<number> {
  const out = new Set<number>();
  const ascii = text.replace(/[০-৯]/g, (c) => String(c.charCodeAt(0) - 0x09e6)).replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
  for (const m of ascii.match(/\d+(?:\.\d+)?/g) ?? []) out.add(Number(m));
  for (const h of findNumbers(text)) out.add(h.value);
  const toks = text.toLowerCase().split(/[\s,।.?!;:()"'“”‘’-]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const k = key(toks[i]);
    if (TABLE.has(k)) out.add(TABLE.get(k)!);
    else {
      // a number word with a case ending glued on ("আঠেরোতে", "ষোলোয়")
      const w = WORDS.find((x) => x.length >= 3 && k.startsWith(x) && SUFFIX.test(k.slice(x.length)));
      if (w) out.add(TABLE.get(w)!);
    }
    const en = EN_NUM[toks[i]];
    if (en !== undefined) {
      const next = EN_NUM[toks[i + 1] ?? ""];
      if (en >= 20 && en % 10 === 0 && next !== undefined && next > 0 && next < 10) out.add(en + next);
      out.add(en);
    }
  }
  if (/দেড়|দেড়|ডেড়|डेढ़|डेढ|one and a half/i.test(text)) out.add(1.5);
  if (/আড়াই|আড়াই|ढाई|two and a half/i.test(text)) out.add(2.5);
  return out;
}
