# Bengali speech-to-text: Whisper-large-v3 vs Vaani vs IndicConformer

**Scope:** Bengali recordings only, Scripts 1, 3 and 4 from the *Scripts* Google Doc. Every result from the three evaluation rounds is included (prescriptions 2, 4, 5, 9, 11, 12, 14, 16, 17, 18).

**Held constant:**
- LLM: `qwen/qwen3-vl-4b` via LM Studio.
- English "helper" translation given to the LLM: Whisper-large-v3's translate pass, in every run.

**New in this round (prescriptions 16–18):**
- IndicConformer-600M with the **15-second, silence-aligned pieces** fix.
- **Bengali selected in the dropdown** (language detected correctly for all three).

Scoring: `evaluation/score_bengali.py`. The labels and gold items are the same as in the earlier reports.

---

## 1. Models compared

| | Whisper-large-v3 | Vaani | IndicConformer-600M |
|---|---|---|---|
| Model id | `ggml-large-v3.bin` (whisper.cpp) | `ARTPARK-IISc/whisper-medium-vaani-bengali` (hi: `…-large-v3-vaani-hindi`) | `ai4bharat/indic-conformer-600m-multilingual` |
| Design | Multilingual Whisper, general data | Whisper fine-tuned on Indian speech (Vaani dataset) | Conformer (RNNT/CTC), trained on 22 Indian languages |
| Runs on the M4 | Apple GPU (Metal) | Apple GPU (MPS, fp16) | CPU (onnxruntime) |
| Licence | MIT | MIT / Apache-2.0 | MIT (gated) |

## 2. Transcript quality (speech → Bengali text)

### 2.1 Error rates against the script

| Script | Whisper-large-v3 | Vaani | IndicConformer (30 s pieces) | **IndicConformer (15 s pieces)** |
|---|---|---|---|---|
| **Script 1**: presbyopia, dry eye, MGD | CER 0.81 · WER 0.83 · coverage 24% | CER 0.71 · WER 0.78 · coverage 54% | CER 0.80 · coverage 21% | **CER 0.25 · WER 0.28 · coverage 101%** |
| **Script 4**: dry AMD (jargon-heavy) | CER 0.92 · coverage 10% *(detected as hi)* | CER 0.69 · coverage 50% *(as hi)* | CER 0.94 · coverage 6% *(as hi)* | **CER 0.49 · WER 0.56 · coverage 59%** |
| **Script 3**: fungal corneal ulcer | CER 0.84 · coverage 20% *(detected as pa)* | not run | not run | **CER 0.31 · WER 0.50 · coverage 101%** |

- **CER** = character error rate; **WER** = word error rate. Lower is better: 0.25 means 1 wrong character in 4.
- **Coverage** = transcribed letters ÷ script letters (spaces removed). 100% means nothing was skipped.
- Runs in another script (Devanagari/Gurmukhi) were mapped to one script before comparing.

### 2.2 Clinical content captured (the number that matters)

"Content present" = how many of the script's clinical facts can still be recognised in the transcript: name, complaints, history, findings, numbers, diagnosis, drugs, advice, follow-up.

| Script | Whisper-large-v3 | Vaani | **IndicConformer (15 s)** |
|---|---|---|---|
| Script 1 (26 facts) | 10 (38%) | 15 (58%) | **22 (85%)** |
| Script 4 (28 facts) | 0 (0%) | ~16 (58%) | **20 (71%)** |
| Script 3 (18 facts) | 3 (17%) | — | **17 (94%)** |

### 2.3 What IndicConformer got right (Script 1, prescription 16)

For the first time, **every number in the examination survived**:

> দূরের দৃষ্টি দু চোখে **ছয় বাই ছয়** · কাছের দৃষ্টি **এন আঠেরো প্লাস ওয়ান পয়েন্ট ফাইভ অ্যাড দিলে এন সিক্স** · **টিআর ব্রেক আপ টাইম** দু চোকে **পাঁচ সেকেন্ড** · সিনেমার (Schirmer) টেস্ট **দশ মিলিমিটার** · **মেবোমিয়ান গ্ল্যান্ড প্লাগিং** ও বেরফাই টেরিস (blepharitis) · **প্রেস বায়ু পিয়া** · চশমা … **প্লেন**, **প্লাস ওয়ান পয়েন্ট ফাইভ অ্যাড**, **প্রোগ্রেসিভ লেন্স**, **অ্যান্টি রিফ্লেকটিভ কোটিং** · **কার্বক্সিমিথাইল সেলুলস ড্রপ দু চোখে দিনে চারবার তিন মাস**

In Script 3 (p18), the drug names come through phonetically but recognisably:
- *নিয়াতম আয়সন … প্রতী এক ঘন্টা* = natamycin hourly
- *মকসি প্লসা … দিনে কারবার* = moxifloxacin 4×/day
- *আয়াত্রুপিয়ান … দিনে দুবার* = atropine twice daily
- *হাইপোপি* = hypopyon
- *ফাং আলকেরা তাইত্রিস সন্দেহ* = fungal keratitis suspected

### 2.4 What IndicConformer still gets wrong

| Type | Examples |
|---|---|
| Names | শর্মিষ্ঠা বসু → *সয়স*. বয়স আটচল্লিশ → *সয়স আট* (age lost) |
| Similar-sounding words | কাছের → *চাষ*, বালি → *মালি*, চালশে → *চাষে*, শিরমার → *সিনেমার*, থাইরক্সিন → *থাইরয়েডার* |
| Numbers in Script 3 | ৬/৬০, ৬/৯ → *সাত ভাগছি … ভাগড়ছি* (VA lost) |
| Skipped stretch (Script 4) | PVD/retinal tear sentence, tropicamide, indirect ophthalmoscopy, drusen, and the whole treatment paragraph (anti-VEGF, AREDS2, Amsler grid, PDT) are missing. That is why coverage is 59%, not ~100% |
| English terms said inside Bengali | Handled well in Script 1 (TBUT, progressive, anti-reflective); weaker in Script 4's dense jargon |

### 2.5 Speed (Apple M4)

| Script | Whisper-large-v3 | Vaani | IndicConformer (15 s) |
|---|---|---|---|
| Script 1 | 136 s | 324 s | **46 s** |
| Script 4 | 103 s | 164 s | 74 s |
| Script 3 | 110 s | — | not recorded (the output has no `asr` block) |

IndicConformer is the **fastest** despite running on the CPU. Earlier IndicConformer times (281 s) included the one-time model download.

### 2.6 Transcript verdict

**IndicConformer-600M, with 15-second pieces and the language set to Bengali, is clearly the best of the three.**

| Measure | Compared with Whisper-large-v3 | Compared with Vaani |
|---|---|---|
| Character errors (CER), Script 1 | about 3× fewer (0.81 → 0.25) | about 3× fewer (0.71 → 0.25) |
| Clinical facts captured, all 3 scripts | 18% → **82%** | 58% → 78% |
| Speed, Script 1 | 3× faster (136 s → 46 s) | 7× faster (324 s → 46 s) |
| Repeating-text loops | none (Whisper loops badly) | none |

Vaani's figures cover only Scripts 1 and 4 (no Script 3 run). The 30-second-piece problem and the wrong-language problem both explained the earlier poor IndicConformer results. Neither is a model weakness.

---

## 3. Prescription quality (transcript → structured prescription)

### 3.1 Scores per run

| Script | ASR | Output | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | F1 | KB-id | Med fields |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Script 1 | Whisper-large-v3 | p2 | 23 | 4 | 4 | 14 | 1 | 6 | 57% | 35% | 0.43 | 1/5 | n/a |
| Script 1 | Vaani-Bengali | p5 | 23 | 2 | 2 | 13 | 6 | 6 | 40% | 17% | 0.24 | n/a | steroid invented |
| Script 1 | IndicConformer, 30 s | p12 | 23 | 0 | 0 | 15 | 8 | 3 | 0% | 0% | 0.00 | 1/4 | n/a |
| Script 1 | **IndicConformer, 15 s** | **p16** | 23 | **8** | **8** | **2** | 5 | 8 | **67%** | **70%** | **0.68** | 6/10 | 3/6 |
| Script 4 | Whisper-large-v3 (as hi) | p4 | 25 | 0 | 0 | 25 | 0 | 4 | 0% | 0% | 0.00 | 0/1 | n/a |
| Script 4 | Vaani-Hindi (as hi) | p9 | 25 | 0 | 0 | 14 | 11 | 6 | 0% | 0% | 0.00 | 3/8 | n/a |
| Script 4 | IndicConformer (as hi) | p14 | 25 | 0 | 0 | 22 | 3 | 3 | 0% | 0% | 0.00 | 0/2 | n/a |
| Script 4 | **IndicConformer, 15 s, bn** | **p17** | 25 | 1 | 5 | 7 | **12** | 2 | 75% | 24% | 0.36 | 0/6 | n/a |
| Script 3 | Whisper-large-v3 (as pa) | p11 | 18 | 0 | 1 | 16 | 1 | 2 | 33% | 6% | 0.10 | 0/4 | n/a |
| Script 3 | **IndicConformer, 15 s, bn** | **p18** | 18 | 0 | 3 | **1** | **14** | 2 | 60% | 17% | 0.26 | 1/2 | n/a |

### 3.2 Best configuration of each model, all three scripts combined

| Model | Gold facts | Found | FP | Precision | Recall | Facts lost in ASR | Facts missed by LLM |
|---|---|---|---|---|---|---|---|
| Whisper-large-v3 (p2, p4, p11) | 66 | 9 | 12 | 43% | 14% | 55 (83%) | 2 |
| Vaani (p5, p9; no Script 3 run) | 48 | 4 | 12 | 25% | 8% | 27 (56%) | 17 |
| **IndicConformer 15 s (p16, p17, p18)** | 66 | **25** | 12 | **68%** | **38%** | **10 (15%)** | **31** |

**The bottleneck has moved.** With Whisper, 83% of facts were lost in speech-to-text. With IndicConformer only 15% are, and **the LLM now loses more facts (31) than the ASR does (10)**. If the LLM captured everything in the transcript, IndicConformer's recall ceiling would be about **85%**.

### 3.3 Prescription 16 (Script 1): the best Bengali prescription so far

Correct or nearly correct:

- **Complaints:** reading difficulty for 6 months (BE) and dryness with burning (BE)
- **Tests and diagnosis:** TBUT 5 s BE, meibomian gland plugging, presbyopia BE, dry eye BE
- **Glasses:** plano BE +1.50 add, progressive lenses
- **Medicine:** carboxymethylcellulose BE for 3 months
- **Advice and follow-up:** clean the lid margins, 20-20-20, return in 1.5 months

Still wrong:

| Problem | Cause |
|---|---|
| Patient "Soyus", age **60** | ASR lost the name; the LLM invented the age |
| **Cataract** (complaint + finding) and **Corneal opacity/"Itching"** (complaint) | Lexical matcher: *চোখে ছয়* ("6/6 in the eyes") → cataract; *চোখে জেল* ("gel in the eyes") → corneal opacity |
| **Glaucoma / POAG** (complaint, finding, diagnosis) | "your pressure" from the **Whisper English translation** |
| **Thyroid eye disease** diagnosis | "Thyroid is there" in the translation; the patient only has hypothyroidism |
| CMC listed **3 times**, as "Gel", 0.5%, "4 times daily … once daily", "apply before bed" | LLM merged the QID drop with the bedtime gel; strength invented; duplicate rows |
| Schirmer 10 mm recorded as "Slit lamp: 10 mm" coded TBUT | LLM field mix-up |
| VA 6/6, near vision N18→N6, blepharitis, warm compress (became "wash eyes"), "blink often" (became "take deep breaths") | Present in the Bengali transcript but missed, or overwritten by the translation's wording |

### 3.4 Prescriptions 17 and 18: good transcripts, broken LLM output

Both transcripts are the best we've had for these scripts, yet the prescriptions are nearly empty:

- **p17 (Script 4):** the LLM wrote one complaint containing the right Bengali words (খাপ ছাড়া বা পাকা দেখা, আলোক ঝরকি, কালো ফুটকি), then **"Nausea" four times**. The nausea comes from the Whisper translation's "constipation, nausea…" loop, repeated ×40. All six rows are coded SYM-046 "Nausea / vomiting". No diagnosis, tests, OCT, AREDS2 or follow-up, even though dry AMD, SD-OCT, ellipsoid zone, FA and the 3-month OCT were all in the transcript.
- **p18 (Script 3):** the name *Gopal Mandal* is correct. After that, **"Itching" ×9** (coded DIS-053 corneal ulcer), then the LLM's own loop guard cut it off. **Natamycin, moxifloxacin, atropine, scraping, "stop the shop drop", dark glasses, blood-sugar test and the 2-day review are all missing**, though all of them were in the transcript. The translation it was given ("The patient has a fever" ×9) is pure hallucination.

Both runs show the warning *"The model's answer was cut short (the model started repeating itself)"*. The 4B vision-language model falls into loops when fed a long Bengali transcript together with a looping English translation.

---

## 4. False positives across all Bengali runs

| False positive | Runs | Source |
|---|---|---|
| **Prednisolone / Dexamethasone (steroids)** | p2, p5 | LLM, from garbage translation. **Gone with IndicConformer** |
| Thyroid eye disease | p2, p5, p12, p16 | "Thyroid is there" in the Whisper translation |
| POAG / PACG | p5, p12, p16 | "your pressure" in the Whisper translation |
| Corneal opacity | p2, p16 | Matcher: *চোখে জেল* / "barfractase" |
| Cataract | p16 | Matcher: *চোখে ছয়* (6/6) |
| Nausea / constipation / fever | p4, p9, p14, p17 | Whisper translation loop |
| "Itching" ×9 | p18 | LLM repetition loop |
| Invented name/age | p5 "Ashan Bhusun", p16 "Soyus, 60", p9/p4 "Dr. Babu" | Greetings (আসুন বসুন) read as names |
| Duplicate rows | p5 (Pred ×3), p16 (CMC ×3), p17 (Nausea ×4), p18 (Itching ×9) | LLM repetition |

**Most Bengali false positives (roughly two in three) trace back to the Whisper English translation.** With IndicConformer transcripts, that translation is now the single largest source of errors.

---

## 5. Conclusions

1. **Use IndicConformer-600M for Bengali (and Hindi).** It's the most accurate (CER 0.25–0.49), the most complete (82% of facts on average), the fastest (46–74 s), and it doesn't loop.
2. **Always pick the language.** Every auto-detected Bengali run failed (hi, hi, hi, pa). Every run with Bengali selected worked.
3. **The Whisper English translation must go.** It's now actively harmful: thyroid eye disease, glaucoma, nausea, "fever", "take deep breaths" and "wash eyes" all come from it. qwen3 can read Bengali directly, as p16's Bengali `patient_words` show.
4. **The LLM is now the bottleneck.** qwen3-vl-4b missed 31 facts that were in the transcript, and it looped in 2 of 3 runs.

## 6. Recommended next changes (in priority order)

| # | Change | Expected effect |
|---|---|---|
| 1 | **Don't send the Whisper translation when the Indic backend is used**, or at least drop it when it repeats itself | Removes most Bengali false positives and the nausea/itching loops |
| 2 | **Switch the LLM** to `Qwen3-4B-Instruct-2507` (text-only, same size, so it fits the Mac that crashed on 8B) | Fewer loops; better at reading Bengali |
| 3 | **Remove duplicate rows** after the LLM responds (same drug/complaint/eye → keep one) | Cleans CMC ×3, Itching ×9 and similar |
| 4 | **Stop the matcher from suggesting diseases from short Bengali phrases** (*চোখে ছয়*, *চোখে জেল*): require ≥ 2 content words or a higher score for Indic-script matches | Removes cataract and corneal-opacity false positives |
| 5 | **Keep a medicine only if its name is in the transcript** | Guards against the steroid hallucinations seen earlier |
| 6 | **Make the language dropdown required** for audio (no auto) | Prevents the hi/pa misdetections |
| 7 | Re-run Script 4 with `INDIC_CHUNK_S=10` to see if the skipped treatment paragraph comes back | Tests whether coverage 59% → ~100% |

**Bottom line:** speech recognition for Bengali is now largely solved by IndicConformer: 85% of clinical facts reach the transcript, against 18% with Whisper-large-v3. The remaining gap is the LLM step. Fixes 1–3 above should raise Bengali prescription recall from 38% to well above 60%, going by prescription 16, where the LLM already reached 70%.
