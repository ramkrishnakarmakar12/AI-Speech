# General transcription accuracy — English, Bengali, Hindi

**Test set:** the three general-topic scripts in `recordings/general/`, read aloud and recorded:

| Script | Language | Content | Reference words |
|---|---|---|---|
| `general_en.txt` | English | TV news bulletin (Kolkata rain, coding contest, Puja trains) | 211 |
| `general_bn.txt` | Bengali | Two friends planning a Digha trip (dialogue) | 144 (155 with the spoken speaker names) |
| `general_hi.txt` | Hindi | Cooking video — aloo paratha recipe | 203 |

**Models:** English → Whisper-large-v3 · Bengali / Hindi → IndicConformer-600M (15 s pieces, language selected) ·
English translations → Whisper-large-v3 translate pass.
**Scoring:** `src/general/metrics.ts` (native-script WER/CER, punctuation and digit script ignored). Re-run with
`npx tsx evaluation/general/run1_scripts/measure.ts`. All transcripts used are saved in `evaluation/general/run1_scripts/`.

---

## 1. Headline

| Language | Engine | WER | CER | Real (meaning-changing) errors | Verdict |
|---|---|---|---|---|---|
| **Hindi** | IndicConformer | **4.9%** | **1.2%** | **1** (one dropped "और") | Near-perfect |
| **Bengali** | IndicConformer | **9.0%** | **1.1%** | **2–3** | Excellent |
| **English** | Whisper-large-v3 | **10.2%** | **6.8%** | **2 sentences replaced** | Good, but hallucinates |

(WER/CER shown with the fair reference — see §2 for the strict numbers and why they differ.)

**Character accuracy: Hindi 98.8% · Bengali 98.9% · English 93.2%.**

For comparison, on the ophthalmology consultation scripts the same engines scored CER 25–49% (Bengali) and
WER 33–49% (English). General speech is recognised far better than dense medical jargon — see §6.

---

## 2. Strict vs fair scores

Two things inflate the strict score without being recognition errors:

| Language | Strict WER / CER | Fair WER / CER | What the fair version changes |
|---|---|---|---|
| English | 15.2% / 11.4% | **10.2% / 6.8%** | Numbers written as digits ("7", "120", "8,000", "15th") instead of words — Whisper always writes digits; "E M" → "EM" |
| Bengali | 16.7% / 9.7% | **9.0% / 1.1%** | The speaker names (রিয়া, অমিত) were read aloud, so they are real speech, not labels |
| Hindi | 4.9% / 1.2% | 4.9% / 1.2% | — |

→ **Recommended tool change:** normalise numbers (words ↔ digits) before scoring, so English is not penalised
for writing "120" instead of "one hundred and twenty". Tell readers not to speak the speaker labels, or keep
them in the reference.

---

## 3. English — Whisper-large-v3 (result 1)

**Fair WER 10.2% · CER 6.8% · 15 substitutions, 6 deletions, 0 insertions of 206 words · coverage 97%**

| Type | Script | Transcript | Severity |
|---|---|---|---|
| **Hallucinated sentence** | "The **Metro Railway said that services on the Blue Line ran normally**, but three suburban trains…" | "**The rain is expected to be more severe this afternoon**, but three suburban trains…" | 🔴 invented content — reads fluently, so nobody would notice |
| **Rewritten sentence** | "**Finally, the ticket counters** for the Durga Puja special trains will open…" | "**Passengers** for the **Durgapurja** special trains will open…" | 🔴 meaning changed (and ungrammatical) |
| Place-name spelling | Alipore, Sealdah | Alipur, Sialda | 🟡 phonetic, understandable |
| US spelling | millimetres, cancelled | millimeters, canceled | ⚪ not an error |
| Number format | seven, one hundred and twenty, eight thousand, fifteenth | 7, 120, 8,000, 15th | ⚪ not an error |

**Take-away:** word-level accuracy is high, but Whisper's characteristic failure showed up — it replaced two
sentences with plausible text it made up. WER alone understates how serious that is: 2 of 12 sentences (17%)
carry wrong information.

### English audio decoded as Bengali (part 2 — wrong language setting)

The same English recording run with **language = Bengali** produced English written phonetically in Bengali
letters: *গুড ইভেনিং এন্ড ওয়েলকম টু দা সি নেন্ট কলকাতা … প্রিয়া সেন হেস ওন এ ন্যাশনল কবরিং কম্পিটিশন …*

- Names and numbers mostly survive (বেহালা, সাল্ট লেক, দুর্গাপুর, প্রিয়া সেন, এইট থাউসেন্ড, ট্যু লাখ রুপিস, দুর্গা পূজা, ফিফটিনথ অক্টোবর).
- Many words are mangled or dropped (*থরেন্জ অলর্টেল ফ্রাইডে* = "orange alert until Friday", *কবরিং* = "coding", *হেলথ* = "held").
- It cannot be scored against the English script and is **not usable** downstream.

→ Confirms the rule from the medical tests: **always select the correct language**; IndicConformer will
faithfully transliterate whatever it hears into the script of the selected language.

---

## 4. Bengali — IndicConformer (result 2)

**Fair WER 9.0% · CER 1.1% · 9 substitutions, 5 deletions, 0 insertions of 155 words · coverage 100%**

Almost every "word error" is a spelling variant or a word-joining difference — the character error rate is only 1.1%.

| Script | Transcript | Kind | Meaning changed? |
|---|---|---|---|
| কী রে | কিরে | joined + কী/কি spelling | no |
| আটকে ছিল | আটকেছিল | joined | no |
| চা টা | চাটা | joined | no |
| দিঘা | দীঘা | spelling variant (both used) | no |
| ঠান্ডা | ঠাণ্ডা | spelling variant | no |
| বেরোবি | বেরবি | colloquial spelling | no |
| **ভাঁড়ের** (clay-cup) | **ভাড়ের** | missing chandrabindu | 🟡 yes — ভাড়ের reads as "of rent/fare" |
| **চপ বল** ("order a chop") | **চপ্বল** | joined into a non-word | 🟡 yes |
| **মাছ ভাজা** (fish fry) | **মাঝভাজা** | মাছ→মাঝ + joined | 🟡 yes |

**Take-away:** effectively perfect content — every name, number, day and time (শনিবার, সকাল দশটায়, ভোর ছটার
ট্রেন, তিন হাজার টাকা, বিকেল চারটের মধ্যে) is right. The 3 meaning changes are single-letter slips.
Word-joining explains why WER (9%) looks much worse than CER (1.1%) — for Bengali, **CER is the number to trust**.

---

## 5. Hindi — IndicConformer (result 3)

**WER 4.9% · CER 1.2% · 8 substitutions, 1 deletion, 1 insertion of 203 words · coverage 100%**

| Script | Transcript | Kind | Meaning changed? |
|---|---|---|---|
| हूँ, गेहूँ | हूं, गेहूं | chandrabindu vs anusvara (both accepted) | no |
| गरम ×3, गरमा | गर्म ×3, गर्मा | spelling variant | no |
| यह | ये | colloquial form | no |
| छीलकर | छील कर | split | no |
| **और** चैनल को | चैनल को | word dropped | ⚪ minor |

**Take-away:** the Hindi transcript is correct in every content word — all quantities (चार आलू, आधा चम्मच,
दो कप, पंद्रह मिनट, दो चम्मच) and all steps. Every counted "error" is an accepted spelling variant.

---

## 6. English translations (Whisper translate pass)

The pipeline also produces an English translation of Bengali/Hindi audio. Judged by meaning, sentence by sentence:

### Bengali → English (section 2): **~60% of sentences correct — 5 meaning errors**

| Bengali said | Whisper translation | Correct meaning |
|---|---|---|
| পরের শনিবার আমরা দিঘা যাচ্ছি | "I'm going to Digha." | **Next Saturday we** are going to Digha |
| শনিবার? | "**Sunday**?" | **Saturday**? |
| ভোর ছটার ট্রেন | "The 6th train **in the afternoon**" | The **6 a.m.** train |
| বিকেল চারটের মধ্যে পৌঁছে যাব | "I'll be there **in a minute**" | I'll arrive **by 4 p.m.** |
| মনে করে ছাতা আনিস | "**I think you brought** an umbrella" | **Remember to bring** an umbrella |
| দুটো ডিমের চপ বল | "two egg chop **balls**" | order two egg chops (বল = "say/order") |
| কখন বেরোবি | "When will you **come**?" | When will you **leave**? |
| চা টা খা | "Now **eat** the tea" | Drink your tea (Bengali uses "খাওয়া" for both) |

The Bengali **transcript** of the same audio had all of these right (শনিবার, ভোর ছটার, বিকেল চারটের, মনে করে ছাতা আনিস).
The translation — not the recognition — introduced every day/time error.

### Hindi → English ("in eng"): **~90% of sentences correct — 2 minor errors**

| Hindi said | Whisper translation | Correct meaning |
|---|---|---|
| बीच में दो चम्मच आलू का मसाला रखिए | "**In the meantime**, keep 2 tsp…" | Put 2 tsp of filling **in the middle** |
| ऊपर से थोड़ा घी लगाइए | "Grease **the pan** with some ghee" | Brush a little ghee **on top (of the paratha)** |

Quantities, steps and times are all correct.

**Translation verdict:** Hindi → English is usable. **Bengali → English is not reliable** — it got the day, both
times and an instruction wrong on clean audio. This matches the medical tests (where it looped into
"constipation…"). For any downstream use (LLM extraction, summaries), feed the **native transcript**, not the
Whisper translation.

---

## 7. General vs medical speech

| | General scripts (this test) | Ophthalmology scripts (earlier tests) |
|---|---|---|
| Bengali · IndicConformer CER | **1.1%** | 25% (Script 1), 31% (Script 3), 49% (Script 4) |
| Hindi · IndicConformer CER | **1.2%** | — |
| English · Whisper WER | **10.2%** (fair) | 33% (glaucoma), 36–49% (AMD script) |
| Typical errors | spelling variants, word joining, 2 hallucinated sentences | medical terms misheard (metamorphopsia → "metamorphosis", Amsler → "amstrad"), names, numbers |

The engines are strong on everyday vocabulary; accuracy drops sharply on medical terminology, English drug and
test names inside Bengali sentences, and unfamiliar proper names. Part of the gap may also be recording
conditions (these general scripts were read clearly by one speaker at a time).

---

## 8. Conclusions and recommendations

1. **IndicConformer is production-grade for general Hindi and Bengali** — ~99% character accuracy, all names,
   numbers, days and times correct.
2. **Whisper-large-v3 is good for general English but can invent sentences.** 2 of 12 sentences were replaced by
   fluent, wrong text. Keep a human check, or compare against a second pass/model for important audio.
3. **Do not use the Whisper Bengali → English translation** for anything that matters; it changed days and times
   the transcript had right. Hindi → English is acceptable.
4. **Always set the language** — English audio under "Bengali" becomes unusable transliteration.
5. **Scoring tool improvements** (small code changes, can do next):
   - normalise numbers (words ↔ digits) before WER, so English isn't penalised for "120" vs "one hundred and twenty";
   - add a Bengali/Hindi spelling-variant table (কী/কি, দিঘা/দীঘা, ঠান্ডা/ঠাণ্ডা, हूँ/हूं, गरम/गर्म …) and
     report a "normalised WER" alongside the strict one;
   - flag possible hallucinations: a run of ≥ 5 consecutive substituted words (like the Metro sentence) as its own
     error type in the report.
6. **For medical use**, the gap is vocabulary, not the engines: feed the knowledge-base terms as hotwords/prompt
   where the engine supports it, and prefer the native transcript over the translation for the LLM step.

_Note: the LLM (Qwen3) review estimates are not part of this report — the outputs pasted were the raw
transcripts and translations. Run `npm run general -- recordings/general/general_bn.m4a --lang bn` (etc.) to add
the LLM estimate and see whether its correction improves the score._
