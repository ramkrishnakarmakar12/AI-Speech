# Run 2 evaluation: Indic ASR vs Whisper-large-v3

**What changed between the runs**

| | Run 1 (prescription 0–4) | Run 2 (prescription 5, 8, 9, 10, 11) |
|---|---|---|
| ASR backend | `whisper-cli` (Whisper large-v3) for every language | `indic`: Vaani Whisper for hi/bn; English still goes to Whisper large-v3 |
| Bengali model | Whisper large-v3 | `ARTPARK-IISc/whisper-medium-vaani-bengali` |
| Hindi model | Whisper large-v3 | `ARTPARK-IISc/whisper-large-v3-vaani-hindi` |
| English translation fed to LLM | Whisper large-v3 translate pass | **unchanged**: still the Whisper translate pass |
| LLM | qwen/qwen3-vl-4b | qwen/qwen3-vl-4b (unchanged) |
| Language | auto-detect | auto-detect (not picked in the dropdown) |

Ground truth: the *Scripts* Google Doc and `samples/glaucoma_recording_script.txt`. Scoring is in `evaluation/score_run2.py`, with the same labels as the first report.

## 1. Which output is which

| New output | Script | Detected lang | ASR actually used | Run-1 counterpart |
|---|---|---|---|---|
| prescription 5 | Script 1 (BN, presbyopia + dry eye + MGD) | bn ✔ | Vaani-Bengali | prescription (2) |
| prescription 8 | Script 5 (EN, dry AMD) | en ✔ | Whisper large-v3 (English fallback) | prescription (3) |
| prescription 9 | Script 4 (BN, dry AMD) | **hi ✘** | Vaani-**Hindi** | prescription (4) |
| prescription 10 | EN dry eye / digital strain (no script) | en ✔ | Whisper large-v3 (English fallback) | prescription (1) |
| prescription 11 | Script 3 (BN, fungal corneal ulcer), **new** | **pa ✘** (Punjabi) | Whisper large-v3 in Punjabi (no Indic model for pa) | none |

Two of the three Bengali recordings were misdetected, so only **prescription 5** is a clean test of the Bengali model.

## 2. Speech-to-text: Indic vs Whisper-large-v3

| Script | Engine | Coverage* | CER** | Script content present in transcript | ASR time |
|---|---|---|---|---|---|
| Script 1 (BN) | Whisper large-v3 (p2) | 24% | 0.81 | 10/26 (38%) | 136 s |
| Script 1 (BN) | **Vaani-Bengali** (p5) | **54%** | **0.71** | **15/26 (58%)** | 324 s*** |
| Script 4 (BN) | Whisper large-v3, detected hi (p4) | 9% | 0.93 | 0/26 (0%) | 103 s |
| Script 4 (BN) | **Vaani-Hindi**, detected hi (p9) | **46%** | **0.71** | **~15/26 (58%)** | 164 s |
| Script 3 (BN) | Whisper large-v3, detected pa (p11) | 20% | 0.84 | 3/18 (17%) | 110 s |
| Script 5 (EN) | Whisper large-v3 (p3) | — | WER 0.49 | 20/40 key terms | 32 s |
| Script 5 (EN) | Whisper large-v3 (p8) | — | WER 0.36 | 22/40 key terms | 37 s |
| EN dry eye | Whisper large-v3 (p1) | truncated, ends in a "Patient. Patient." loop | — | ~70% of consult | 39 s |
| EN dry eye | Whisper large-v3 (p10) | complete | — | ~95% of consult | 36 s |

\* Coverage = transcribed letters ÷ script letters (spaces removed). Low coverage means content was skipped.
\** CER computed after mapping both texts to one script (Bengali/Gurmukhi → Devanagari by Unicode offset). It is pessimistic for p9 because a Hindi model spells Bengali sounds its own way.
\*** p5 was the first run of the Bengali model, so its time probably includes the one-time ~1.5 GB model download.

**What the Indic models got right that Whisper didn't**

- **Script 1 (Vaani-Bengali):**
  - *মেয়ে বোমিয়ান গ্লাইন বলগিং ও ব্রফারিট্রীস* = meibomian gland plugging + blepharitis
  - *চালছী* = chalshe/presbyopia
  - *ড্রাই* … *ডিসপাংশন* = dry eye, MGD
  - *চশমা* = glasses
  - *গরম শেঁক* = warm compress
  - *পাতার ধার পরিষ্কার* = lid hygiene
  - *বিশ মিনিট … বিশ সেকেন্ড* = 20-20-20
  - *ঘন ঘন পলক* = blink often
- **Script 4, even through the Hindi model:**
  - *पोस्टेरियर विटियर्स डिटचमेंट पीवीडी* (PVD)
  - *ड्राई एज रिलेटेड मैकुला डिजेनरेशन* (dry AMD)
  - *स्पेक्ट्रल डोमेन ऑप्टिकल … टोमोग्राफी*, *एलिपसाइड जोन* (SD-OCT, ellipsoid zone)
  - *कोरोइदाल … स्कुलाइज़ेशन* (choroidal neovascularization)
  - *फ्लुरिसिन … ग्रफि* (fluorescein angiography)
  - *कॉटन हुल स्पॉट* (cotton wool spot)
  - *तीन माह … ओसीटी स्कैन … वाइड … फोटोग्राफी* (OCT + wide-field photography in 3 months)

  Whisper-large-v3 produced none of this for the same audio.

**What is still wrong with Indic ASR**

- **Patient identity and numbers are missing.** The opening lines and all numbers (6/6, N18→N6, +1.50, TBUT 5 s, Schirmer 10 mm) are absent or garbled. The Bengali word *বয়স* (age) came through as *বয়স্কত*.
- **Broken characters in p5** (`�`, `¨`, `¯`, `§`). My last change caused this: `no_repeat_ngram_size=4` bans 4-token repeats, and in Bengali 4 byte-level tokens are only 1–2 letters. **This is now fixed** (section 6).
- **p9 skipped a middle chunk:** exam, tropicamide, drusen, the anti-VEGF sentence, AREDS2 and Amsler grid.
- **Slower:** Vaani-Hindi (large-v3 size) took 164 s against 103 s for Whisper on the same file.

**English (Whisper in both runs):** p8 and p10 are better than p3 and p1: lower WER, and the dry-eye consult is complete. Nothing in the English model changed, so this is run-to-run variance rather than an improvement. p8 also **dropped the whole first patient turn** (metamorphopsia, blurred vision, asthenopia, photophobia, photopsia, LE).

**ASR verdict**

- On the same Bengali audio, the Vaani models capture roughly **twice as much** as Whisper-large-v3 (coverage 24%→54% and 9%→46%; content 38%→58% and 0%→58%).
- They are the right direction, but still not accurate enough to prescribe from. Names, numbers and whole chunks are lost.

## 3. End-to-end prescription accuracy

| Run | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | Strict acc. | F1 | Med-field | KB-id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| p2 BN Script 1 · Whisper-large-v3 | 23 | 4 | 4 | 14 | 1 | 6 | 57% | 35% | 17% | 0.43 | n/a | 1/5 |
| **p5 BN Script 1 · Vaani-Bengali** | 23 | 2 | 2 | 13 | **6** | 6 | 40% | 17% | 9% | 0.24 | n/a | n/a (empty) |
| p4 BN Script 4 · Whisper-large-v3 (hi) | 25 | 0 | 0 | 25 | 0 | 4 | 0% | 0% | 0% | 0.00 | n/a | 0/1 |
| **p9 BN Script 4 · Vaani-Hindi (hi)** | 25 | 0 | 0 | 14 | **11** | 6 | 0% | 0% | 0% | 0.00 | n/a | 3/8 |
| p11 BN Script 3 · Whisper-large-v3 (pa) | 18 | 0 | 1 | 16 | 1 | 2 | 33% | 6% | 0% | 0.10 | n/a | 0/4 |
| p3 EN Script 5 · Whisper-large-v3 | 25 | 10 | 10 | 4 | 1 | 3 | 87% | 80% | 40% | 0.83 | 1/2 | 12/18 |
| p8 EN Script 5 · Whisper-large-v3 | 25 | 12 | 5 | 7 | 1 | 5 | 77% | 68% | 48% | 0.72 | 1/2 | 14/20 |
| p1 EN dry eye · Whisper-large-v3 | 16 | 13 | 3 | 0 | 0 | 3 | 84% | 100% | 81% | 0.91 | 4/6 | 7/9 |
| p10 EN dry eye · Whisper-large-v3 | 19 | 11 | 7 | 0 | 1 | 3 | 86% | 95% | 58% | 0.90 | 3/6 | 7/11 |

(p1 and p10 are each scored against their own transcript; p10's transcript is longer, so it has more gold items.)

### The key finding: better ASR did **not** reach the prescription

The Bengali transcripts improved, but the Bengali prescriptions got **worse or stayed empty**. The "Missed by LLM" column shows why: it jumped from 1 to 6 (p5) and from 0 to 11 (p9).

The cause is the **English translation**. In the `indic` backend the English text given to the LLM still comes from the Whisper large-v3 *translate* pass, and on Bengali audio that pass is a hallucination loop:

- **p5:** "There is also maibomian gland plugging and barfractase" ×5. This is identical, word for word, to Run 1's translation.
- **p9:** "I have been suffering from constipation, nausea in my stomach, and constipation in my chest" ×40.

The 4B LLM reads the English and ignores the better Bengali/Devanagari transcript. For p9 it returned an empty prescription even though the transcript contained PVD, dry AMD, SD-OCT, ellipsoid zone, FA and the 3-month OCT follow-up.

### False positives and hallucinations in Run 2

**Dangerous**

1. **p5: Prednisolone acetate 0.5%, three times over** (1 drop nightly × 1 month). The patient needs lubricants; the "gel at night" instruction became a steroid.
2. **p5: POAG and PACG diagnosed**, from the lexical matcher hearing "your pressure" in the translation. Also **Thyroid eye disease** again, when the patient only has hypothyroidism.
3. **p8: Dexamethasone intravitreal implant** again, this time from "abstract date for home surgery" (Amsler grid for home monitoring). It happened in both runs: the same Whisper mishearing, the same invented drug.

**Clinical-record errors**

4. p5: patient name "Ashan Bhusun", taken from *আসুন বসুন* ("come in, sit down"). IOP "normal" invented, twice.
5. p8: PVD recorded as a finding (it was only to be ruled out). "No subretinal fluid" and "no cotton wool spots" coded as positive signs (negation lost).
6. p10: denied photophobia recorded as a complaint (SYM-045 wind/dust) again. Artificial tears listed twice and coded MED-028 Nepafenac again. Advice "2 hours outdoors daily" (a KB text) was never said.
7. p11: age 40 instead of 45 (*পঁয়তাল্লিশ*). "Three times" frequency invented.
8. p9: patient "Dr. Babu", plus constipation and nausea terms.

**Improvements seen in Run 2 (LLM side, English)**

- **KB codes:** p8 used the correct KB ids for dry AMD (DIS-104) and Goldmann applanation (TST-015); both were wrong in p3. KB-id accuracy rose to 70% (from 67%). p10 mapped "right eye" to OPT-001 correctly (it was swapped before).
- **Follow-up:** p8 recovered the 3-month OCT + fundus photography follow-up that p3 lost.
- **Anti-VEGF:** p8 listed anti-VEGF as "not indicated" instead of prescribing it.

## 4. Summary scores

| | Run 1 (Whisper-large-v3) | Run 2 (indic) |
|---|---|---|
| English precision / recall | 81% / 85% (p0, p1, p3) | 81% / 80% (p8, p10) |
| Bengali ASR content captured | 19% (p2, p4) | **58%** (p5, p9, same audio) |
| Bengali prescription precision / recall | 44% / 17% | 26% / 8% (p5, p9, p11) |
| Dangerous hallucinated drugs | 3 (2 steroids + Dex implant) | 4 (Prednisolone ×3 rows + Dex implant) |
| Language misdetected | 1 of 2 Bengali | 2 of 3 Bengali (hi, pa) |

## 5. Root causes (ranked)

1. **Garbage English translation overrides the transcript.** The Whisper large-v3 translate pass loops on Bengali, and the LLM trusts it over the Indic transcript. This single issue wiped out the ASR gain.
2. **Auto language detection is unreliable for Bengali**: it picked hi, then pa. Punjabi has no Indic model, so p11 fell back to Whisper in Punjabi.
3. **No drug-name check.** Prednisolone and the Dex implant pass grounding because their KB ids exist, even though neither word was said.
4. **Lexical matcher over-fires on noisy text**: "your pressure" gave POAG/PACG; *আসুন বসুন* became a patient name.
5. **Small LLM (qwen3-vl-4b)**: duplicate rows, negation errors, and KB text pasted as advice.
6. Vaani output quality was hurt by the `no_repeat_ngram_size` setting (now fixed), and chunks are sometimes skipped.

## 6. Fix already applied

**`src/asr/indic_asr.py`**:

- Removed `no_repeat_ngram_size=4`. It broke Bengali letters into `�`/`¨`/`¯`.
- Added `collapse_repeats()`, which removes loops *after* decoding: any phrase repeated 3+ times in a row is kept once, and stray `�` characters are stripped.
- Tested on the loops seen in p2 and p4.

## 7. Recommendations (in priority order)

| # | Change | Why |
|---|---|---|
| 1 | **Always pick the language in the dropdown** for Bengali/Hindi | Prevents the hi/pa misdetection (2 of 3 Bengali runs) |
| 2 | **Drop the Whisper translation when it loops** (repeated-sentence ratio > 40%) or whenever the Indic backend is used, and let the LLM read the Indic transcript directly (qwen3 reads Bengali/Devanagari) | Unlocks the ASR gain; p9 had ~15 items that never reached the prescription |
| 3 | **When auto-detect returns anything other than en/hi/bn**, stop and ask for the language instead of guessing | p11 (pa) |
| 4 | **Drug hallucination guard**: keep a medication only if its name, brand or a phonetic alias occurs in the transcript | Removes Prednisolone ×3 and the Dex implant |
| 5 | **Negation handling** (no, not, without, nahi, nei, na) for complaints, signs and cautions | Photophobia, SRF and CWS false positives |
| 6 | Try **IndicConformer-600M** (`ai4bharat/indic-conformer-600m-multilingual`) for Bengali, compared on the same 3 recordings | Conformer/CTC does not loop the way Whisper-style decoders do; likely better coverage |
| 7 | **Upgrade the LLM** to Qwen3-4B-Instruct-2507, or 8B if RAM allows | Duplicates, negation, KB-text pasting |
| 8 | Re-record or re-run Script 3 with language = Bengali | No valid result yet for the corneal-ulcer case |

**Bottom line**

- **Indic ASR clearly beats Whisper-large-v3 on Bengali speech**: about 2× the content captured, and it recovers terms Whisper completely missed.
- **The prescriptions didn't improve yet**, because the looping Whisper English translation is still what the LLM reads, and two recordings were auto-detected as the wrong language.
- **Fix #1–#4 before the next test round.** Without them, the ASR gain can't show up in the output.
- **English is unchanged** (~81% precision, 80–85% recall). It is still a draft that needs a doctor's review, and the "Amsler grid → Dexamethasone implant" hallucination repeated in both runs.
