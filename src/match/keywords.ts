/**
 * Stage 2 — general (non-KB) keyword detection.
 * Everyday words a consultation always carries: which eye, numbers, durations, how often, dosage forms,
 * lay symptom words, yes/no, speaker cues. They are common words, so a decent ASR pass should get them
 * right; they are reported on their own and also feed the transcript-accuracy estimate.
 *
 * Each entry lists English forms, romanised Hindi / Bengali forms (only used when the visit is in that
 * language, so English "do" is never read as Hindi "two") and native-script forms (matched on
 * Devanagari/Bengali lines after transliteration, exactly like the medical matcher does).
 */
import { normalize } from "./matcher.js";
import { hasIndicScript } from "./translit.js";

export type KeywordCategory =
  | "eye_side"
  | "eye"
  | "number"
  | "measurement"
  | "time_unit"
  | "time_of_day"
  | "frequency"
  | "dosage_form"
  | "symptom"
  | "negation"
  | "affirmation"
  | "speaker"
  | "follow_up";

interface Entry {
  cat: KeywordCategory;
  key: string;
  en?: string[];
  hi?: string[]; // romanised Hindi / Hinglish
  bn?: string[]; // romanised Bengali
  native?: string[]; // Devanagari / Bengali script
}

const E = (cat: KeywordCategory, key: string, en: string[], hi: string[], bn: string[], native: string[]): Entry => ({ cat, key, en, hi, bn, native });

const LEXICON: Entry[] = [
  E("eye_side", "right", ["right", "right eye", "right side"], ["daayi", "dayi", "dahini", "dahina", "daayen"], ["dan", "daan", "dan chokh", "dan dike"], ["दाहिनी", "दाहिना", "दायीं", "दाईं", "दाएं", "दायें", "ডান", "ডানদিকে", "ডান চোখ"]),
  E("eye_side", "left", ["left", "left eye", "left side"], ["baayi", "bayi", "baayen"], ["bam", "baam", "bam chokh", "ba dike"], ["बायीं", "बाईं", "बाएं", "बायें", "बाँयी", "বাম", "বাঁ", "বাঁদিকে", "বাম চোখ"]),
  E("eye_side", "both", ["both", "both eyes", "each eye"], ["dono", "donon", "dono aankh"], ["duto", "dutoi", "dui chokh", "dutoi chokh"], ["दोनों", "दोनो", "দুটো", "দুটোই", "দুই চোখ", "দুচোখ"]),
  E("eye", "eye", ["eye", "eyes", "vision", "sight"], ["aankh", "ankh", "aankhon", "nazar"], ["chokh", "chokhe", "chokher", "drishti"], ["आँख", "आंख", "आँखों", "आंखों", "नज़र", "नजर", "চোখ", "চোখে", "চোখের", "দৃষ্টি"]),

  ...[
    ["1", ["one"], ["ek"], ["ek"], ["एक", "এক"]],
    ["2", ["two"], ["do"], ["dui", "du"], ["दो", "দুই", "দু"]],
    ["3", ["three"], ["teen"], ["tin"], ["तीन", "তিন"]],
    ["4", ["four"], ["char", "chaar"], ["char"], ["चार", "চার"]],
    ["5", ["five"], ["paanch", "panch"], ["panch", "paanch"], ["पांच", "पाँच", "পাঁচ"]],
    ["6", ["six"], ["chhe", "chhah"], ["chhoy", "choy"], ["छह", "छः", "छे", "ছয়"]],
    ["7", ["seven"], ["saat"], ["saat", "sat"], ["सात", "সাত"]],
    ["8", ["eight"], ["aath"], ["aat"], ["आठ", "আট"]],
    ["9", ["nine"], ["nau"], ["noy"], ["नौ", "নয়"]],
    ["10", ["ten"], ["das"], ["dosh", "dash"], ["दस", "দশ"]],
    ["15", ["fifteen"], ["pandrah"], ["ponero"], ["पंद्रह", "পনেরো"]],
    ["half", ["half"], ["aadha", "adha"], ["adh", "aadh"], ["आधा", "আধা"]],
  ].map(([key, en, hi, bn, nat]) => E("number", key as string, en as string[], hi as string[], bn as string[], nat as string[])),

  E("time_unit", "day", ["day", "days", "daily"], ["din", "dino", "roz", "rozana"], ["din", "dine", "diner", "roj", "rojh"], ["दिन", "दिनों", "रोज़", "रोज", "দিন", "দিনে", "দিনের", "রোজ"]),
  E("time_unit", "week", ["week", "weeks"], ["hafta", "hafte", "haftey"], ["saptah", "shoptaho", "hopta"], ["हफ्ता", "हफ़्ता", "हफ्ते", "हफ़्ते", "सप्ताह", "সপ্তাহ", "হপ্তা"]),
  E("time_unit", "month", ["month", "months"], ["mahina", "mahine", "mahino"], ["mas", "mash", "masher"], ["महीना", "महीने", "महीनों", "মাস", "মাসের"]),
  E("time_unit", "year", ["year", "years"], ["saal", "sal", "baras"], ["bochor", "bachhar", "bochhor"], ["साल", "वर्ष", "বছর", "বছরের"]),
  E("time_of_day", "morning", ["morning"], ["subah", "subha"], ["sakal", "sokal", "sakale", "sokale"], ["सुबह", "সকাল", "সকালে"]),
  E("time_of_day", "night", ["night", "bedtime", "at bedtime", "before sleeping"], ["raat", "raat ko", "sone se pehle"], ["rat", "rate", "raate", "ghumonor age"], ["रात", "रात को", "सोने से पहले", "রাত", "রাতে", "ঘুমানোর আগে"]),
  E("time_of_day", "evening", ["evening", "afternoon"], ["shaam", "sham", "dopahar"], ["bikel", "bikele", "sondhe", "dupur"], ["शाम", "दोपहर", "বিকেল", "বিকেলে", "সন্ধ্যা", "দুপুর"]),
  E("frequency", "times", ["times", "time a day", "times a day", "times daily"], ["baar", "bar", "dafa"], ["bar", "baar", "bare"], ["बार", "दफ़ा", "बारी", "বার", "বারে"]),
  E("frequency", "once", ["once", "once a day", "once daily"], ["ek baar"], ["ekbar", "ek bar"], ["एक बार", "একবার", "এক বার"]),
  E("frequency", "twice", ["twice"], ["do baar"], ["dubar", "du bar", "dui bar"], ["दो बार", "দুবার", "দু বার", "দুই বার"]),
  E("frequency", "thrice", ["thrice", "three times"], ["teen baar"], ["tinbar", "tin bar"], ["तीन बार", "তিনবার", "তিন বার"]),
  E("frequency", "four_times", ["four times"], ["char baar"], ["charbar", "char bar"], ["चार बार", "চারবার", "চার বার"]),
  E("frequency", "as_needed", ["as needed", "when needed", "if needed", "whenever needed"], ["zarurat", "jarurat"], ["dorkar hole", "proyojone"], ["ज़रूरत", "जरूरत", "দরকার হলে", "প্রয়োজনে"]),

  E("dosage_form", "drops", ["drop", "drops", "eye drop", "eye drops"], ["drop", "dawai", "dawa"], ["drop", "oshudh", "osudh"], ["ड्रॉप", "ड्रोप", "दवा", "दवाई", "दवाइयां", "ড্রপ", "ওষুধ", "ঔষধ"]),
  E("dosage_form", "tablet", ["tablet", "tablets", "capsule", "pill"], ["goli", "tablet"], ["tablet", "bori", "trablet"], ["गोली", "टैबलेट", "ট্যাবলেট", "বড়ি"]),
  E("dosage_form", "ointment", ["ointment", "gel", "cream"], ["malham", "ointment"], ["molom", "ointment"], ["मलहम", "मरहम", "মলম", "অয়েন্টমেন্ট", "জেল"]),
  E("dosage_form", "glasses", ["glasses", "spectacles", "specs", "lens", "lenses"], ["chashma", "chasma"], ["chosma", "choshma", "chashma"], ["चश्मा", "चश्मे", "চশমা"]),

  E("symptom", "pain", ["pain", "painful", "ache", "aching", "hurts"], ["dard"], ["byatha", "betha", "byetha"], ["दर्द", "ব্যথা", "ব্যাথা"]),
  E("symptom", "itching", ["itch", "itching", "itchy"], ["khujli", "khujali"], ["chulkay", "chulkani", "chulkano"], ["खुजली", "খুজলি", "চুলকায়", "চুলকানি"]),
  E("symptom", "redness", ["red", "redness"], ["laal", "lal"], ["lal", "laal"], ["लाल", "লাল"]),
  E("symptom", "watering", ["watering", "tears", "watery", "tearing"], ["paani", "pani", "aansu"], ["jol", "jal", "jol pore", "jal pore"], ["पानी", "आंसू", "आँसू", "জল", "জল পড়ে", "জল পড়ছে"]),
  E("symptom", "blurred", ["blur", "blurry", "blurred", "hazy", "cloudy", "not clear"], ["dhundhla", "dhundla", "dhundh"], ["jhapsa", "jhaapsa", "ghola"], ["धुंधला", "धुँधला", "धुंध", "ঝাপসা", "ঘোলা"]),
  E("symptom", "burning", ["burning", "burn", "stinging"], ["jalan", "jalna"], ["jala", "jwala", "jala kore"], ["जलन", "জ্বালা", "জ্বালা করে"]),
  E("symptom", "swelling", ["swelling", "swollen", "puffy"], ["sujan", "soojan"], ["fola", "phola"], ["सूजन", "ফোলা"]),
  E("symptom", "discharge", ["discharge", "sticky", "pus"], ["keechad", "kichad"], ["pichuti", "pichuti pore"], ["कीचड़", "पीप", "পিচুটি"]),
  E("symptom", "headache", ["headache"], ["sir dard", "sar dard"], ["matha byatha", "matha dhora"], ["सिर दर्द", "सिरदर्द", "মাথা ব্যথা", "মাথাব্যথা"]),

  E("negation", "no", ["no", "not", "never", "none", "nothing", "dont"], ["nahi", "nahin", "mat"], ["na", "nei", "noy", "nai"], ["नहीं", "नही", "मत", "না", "নেই", "নয়", "নাই"]),
  E("affirmation", "yes", ["yes", "yeah", "okay", "ok"], ["haan", "ha", "ji", "ji haan", "theek"], ["hyan", "ha", "accha", "thik"], ["हाँ", "हां", "जी", "ठीक", "হ্যাঁ", "হাঁ", "আচ্ছা", "ঠিক"]),
  E("speaker", "doctor", ["doctor", "sir", "madam"], ["doctor sahab", "daktar"], ["daktar", "daktarbabu"], ["डॉक्टर", "डाक्टर", "ডাক্তার", "ডাক্তারবাবু"]),
  E("speaker", "patient", ["patient"], ["mareez", "marij"], ["rogi", "rugi"], ["मरीज़", "मरीज", "রোগী"]),
  E("follow_up", "review", ["follow up", "review", "come back", "next visit", "revisit", "check again"], ["phir aana", "dobara", "fir aana", "dikhana"], ["abar asben", "abar dekhaben", "abar asbe"], ["फिर आना", "दोबारा", "फिर से", "आबार", "আবার আসবেন", "আবার দেখাবেন", "আবার"]),
];

export interface KeywordHit {
  category: KeywordCategory;
  key: string;
  /** distinct spoken forms that matched */
  heardAs: string[];
  count: number;
}

export interface KeywordReport {
  hits: KeywordHit[];
  byCategory: Partial<Record<KeywordCategory, string[]>>;
  totalHits: number;
  words: number;
  /** keyword hits per 100 transcript words */
  perHundredWords: number;
  categoriesFound: number;
}

interface Compiled {
  entry: Entry;
  forms: { norm: string; scope: "latin-en" | "latin-hi" | "latin-bn" | "indic" }[];
}
let compiled: Compiled[] | null = null;

function compile(): Compiled[] {
  if (compiled) return compiled;
  compiled = LEXICON.map((entry) => {
    const forms: Compiled["forms"] = [];
    const add = (arr: string[] | undefined, scope: Compiled["forms"][number]["scope"]) =>
      (arr ?? []).forEach((f) => {
        const norm = normalize(f);
        if (norm) forms.push({ norm, scope });
      });
    add(entry.en, "latin-en");
    add(entry.hi, "latin-hi");
    add(entry.bn, "latin-bn");
    add(entry.native, "indic");
    return { entry, forms };
  });
  return compiled;
}

const countIn = (padded: string, needle: string) => {
  let n = 0;
  for (let i = padded.indexOf(needle); i >= 0; i = padded.indexOf(needle, i + 1)) n++;
  return n;
};

/**
 * Detect general keywords. `language` (en/hi/bn) decides whether romanised Hindi/Bengali forms are tried
 * on Latin-script lines; native-script lines always use the native forms.
 */
export function detectKeywords(text: string, language?: string | null): KeywordReport {
  const lines = text.split("\n");
  const indic = ` ${normalize(lines.filter(hasIndicScript).join(" "))} `;
  const latin = ` ${normalize(lines.filter((l) => !hasIndicScript(l)).join(" "))} `;
  const words = (indic + latin).split(" ").filter(Boolean).length;
  const lang = (language ?? "").toLowerCase();
  const hits = new Map<string, KeywordHit>();
  const add = (cat: KeywordCategory, key: string, heard: string, n: number) => {
    const id = `${cat}:${key}`;
    const h = hits.get(id) ?? { category: cat, key, heardAs: [], count: 0 };
    h.count += n;
    if (!h.heardAs.includes(heard)) h.heardAs.push(heard);
    hits.set(id, h);
  };

  for (const { entry, forms } of compile()) {
    // "right" and "right eye" are the same mention: an entry counts its most frequent form, not the sum
    let best = 0;
    const heard: string[] = [];
    for (const f of forms) {
      let n = 0;
      if (f.scope === "indic") n = countIn(indic, ` ${f.norm} `);
      else if (f.scope === "latin-en") n = countIn(latin, ` ${f.norm} `) + (f.norm.length >= 4 ? countIn(indic, ` ${f.norm} `) : 0);
      else if ((f.scope === "latin-hi" && lang === "hi") || (f.scope === "latin-bn" && lang === "bn")) n = countIn(latin, ` ${f.norm} `);
      if (n) {
        best = Math.max(best, n);
        heard.push(f.norm);
      }
    }
    if (best) heard.forEach((h, i) => add(entry.cat, entry.key, h, i === 0 ? best : 0));
  }

  // Digits and clinical notation: "7", "2.5", "6/36", "16 mmhg", "0.5%"
  const all = (indic + latin).split(" ").filter(Boolean);
  all.forEach((t, i) => {
    if (/^\d+\/\d+$/.test(t) || /^\d+:\d+$/.test(t) || /^\d+(\.\d+)?%$/.test(t)) add("measurement", t.includes("/") ? "fraction" : t.includes(":") ? "ratio" : "percent", t, 1);
    else if (/^\d+(\.\d+)?$/.test(t)) {
      if (/^(mmhg|mm|mg|ml|d|diopter|dioptre|diopters)$/.test(all[i + 1] ?? "")) add("measurement", all[i + 1] === "mmhg" ? "pressure" : "unit", `${t} ${all[i + 1]}`, 1);
      else add("number", "digits", t, 1);
    }
  });

  const list = [...hits.values()].sort((a, b) => b.count - a.count);
  const byCategory: KeywordReport["byCategory"] = {};
  for (const h of list) (byCategory[h.category] ??= []).push(h.key);
  const totalHits = list.reduce((s, h) => s + h.count, 0);
  return {
    hits: list,
    byCategory,
    totalHits,
    words,
    perHundredWords: words ? +((100 * totalHits) / words).toFixed(1) : 0,
    categoriesFound: Object.keys(byCategory).length,
  };
}

const AGREEMENT_CATS: KeywordCategory[] = ["eye_side", "number", "time_unit", "frequency", "dosage_form", "symptom"];

/**
 * How well the native transcript and Whisper's English translation agree on everyday facts
 * (which eye, numbers, durations …). Two independent passes that disagree point at a poor transcript.
 * Returns null when there is too little to compare.
 */
export function keywordAgreement(native: KeywordReport, english: KeywordReport): number | null {
  const keys = (r: KeywordReport) => new Set(r.hits.filter((h) => AGREEMENT_CATS.includes(h.category) && h.key !== "digits").map((h) => `${h.category}:${h.key}`));
  const a = keys(native);
  const b = keys(english);
  const union = new Set([...a, ...b]);
  if (union.size < 3) return null;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / union.size;
}
