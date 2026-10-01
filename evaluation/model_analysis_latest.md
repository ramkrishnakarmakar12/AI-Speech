# AI Speech → Prescription: full evaluation, all models and iterations

**Covers prescriptions 0–22** (5 test rounds, 3 speech models, 2 LLMs, 3 languages).
**Scoring:** `evaluation/score_all.py`. It uses the same gold facts and labels as every earlier report, so all numbers are directly comparable.
**Ground truth:** the *Scripts* Google Doc (Scripts 1–5) and `samples/glaucoma_recording_script.txt`. The English dry-eye recording has no script, so it is scored against its own transcript.

---

## 1. What changed in each round

| Round | Outputs | Speech model | LLM | Change being tested |
|---|---|---|---|---|
| 1 | p0–p4 | Whisper-large-v3 (all languages) | qwen3-vl-4b | Baseline |
| 2 | p5, p8–p11 | **Vaani** for hi/bn; Whisper for en | qwen3-vl-4b | Indian-trained Whisper fine-tunes |
| 3 | p12–p15 | **IndicConformer-600M** for hi/bn (30 s pieces) | qwen3-vl-4b | Conformer model (loop-free) |
| 4 | p16–p19 | IndicConformer, **15 s silence-aligned pieces**, **Bengali selected** | qwen3-vl-4b | Chunking fix + manual language |
| 5 | p20–p22 | IndicConformer 15 s | **Qwen3-4B-Instruct-2507 8-bit (MLX)** | LLM swap on identical transcripts |

**Identical re-runs.** p13 = p8, p15 = p10, p19 = p16 and p22 = p20 are byte-for-byte identical to the earlier run, including the prescription. So:
- The pipeline is **deterministic**: the same audio and model always give the same output.
- Round 5 is a **clean A/B test of the LLM**. p16 and p20 used the same Script 1 transcript; p17 and p21 used the same Script 4 transcript.

Fixes made along the way:
- Streaming, timeouts and loop guard for the LLM
- The IndicConformer onnx symlink fix
- The torchvision/pipeline import fix
- Vaani broken-letter fix
- 15 s chunking with decoder fallback
- Clean exit on macOS
- LM Studio model auto-selection that prefers text models

---

## 2. Speech-to-text results

### 2.1 English: Whisper-large-v3 (the only English model used)

| Recording | Run | WER | Key medical terms kept | Issue |
|---|---|---|---|---|
| Glaucoma | p0 | 0.33 | 27/36 (75%) | Dropped the IOP / C:D / diagnosis sentences |
| Script 5 AMD | p3 | 0.49 | 20/40 (50%) | metamorphopsia → "metamorphosis in my blood pressure", Amsler → "amstrad" |
| Script 5 AMD | p8 | 0.36 | 22/40 (55%) | Whole first patient turn missing; Amsler → "abstract date" |
| Dry eye | p1 | — | ~70% | Truncated, ending in a "Patient. Patient." loop |
| Dry eye | p10 | — | ~95% | Complete |

English speech-to-text is **good for conversation, weak on dense jargon**. It drops a sentence or turn now and then.

### 2.2 Bengali: all three models on the same recordings

| Script | Whisper-large-v3 | Vaani | IndicConformer 30 s | **IndicConformer 15 s** |
|---|---|---|---|---|
| Script 1 (presbyopia/dry eye) | CER 0.81, cov 24% | CER 0.71, cov 54% | CER 0.80, cov 21% | **CER 0.25, cov 101%** |
| Script 4 (dry AMD) | CER 0.92, cov 10% *(hi)* | CER 0.69, cov 50% *(hi)* | CER 0.94, cov 6% *(hi)* | **CER 0.49, cov 59%** |
| Script 3 (corneal ulcer) | CER 0.84, cov 20% *(pa)* | — | — | **CER 0.31, cov 101%** |
| **Clinical facts reaching the transcript** | **18%** | **58%** | ~21% | **82%** |
| Speed, Script 1 | 136 s | 324 s | 281 s* | **46 s** |

- **CER** = character error rate (lower is better).
- **cov** = share of the script's letters present.
- *(hi)* / *(pa)* = auto-detect chose Hindi / Punjabi instead of Bengali.
- \* includes the one-time model download.

**Winner: IndicConformer-600M with 15-second pieces and Bengali selected.** Compared with Whisper-large-v3 it has 3× fewer character errors, 4.5× more clinical content and is 3× faster.

What it still misses:
- names (শর্মিষ্ঠা → *সয়স*) and age
- look-alike words (কাছের → *চাষ*, বালি → *মালি*, শিরমার → *সিনেমার*)
- Script 3's visual acuity numbers
- one skipped paragraph in Script 4: treatment (AREDS2, Amsler, anti-VEGF) and exam details

---

## 3. LLM comparison: qwen3-vl-4b vs Qwen3-4B-Instruct-2507 (8-bit)

Same transcripts, same prompt, only the LLM changed.

### 3.1 Scores

| | Script 1: VL-4B (p16) | Script 1: **Instruct (p20)** | Script 4: VL-4B (p17) | Script 4: **Instruct (p21)** |
|---|---|---|---|---|
| Correct / Partial | 8 / 8 | 7 / 7 | 1 / 5 | 3 / 6 |
| Missed by LLM | 5 | 7 | 12 | 9 |
| False positives | 8 | **4** | **2** | 11 |
| Precision | 67% | **78%** | **75%** | 45% |
| Recall | **70%** | 61% | 24% | **36%** |
| F1 | 0.68 | 0.68 | 0.36 | **0.40** |
| LLM time | **97 s** | 286 s | **48 s** | 186 s |

**Both scripts together:** VL-4B scores precision 69% / recall 46% / F1 0.55. Instruct scores precision 61% / recall 48% / F1 0.53, and takes 3.3× longer (average 236 s vs 72 s).

### 3.2 What changed in practice

**Script 1: Instruct is cleaner and clinically safer.**

| | VL-4B (p16) | Instruct (p20) |
|---|---|---|
| Cataract / corneal opacity / glaucoma complaints and diagnoses | ✘ present | ✔ **gone** |
| Thyroid eye disease *diagnosis* | ✘ present | ✔ gone (still in history as "Thyroid disease" coded DIS-149) |
| Invented age | "60" | "At 8" (copied from the ASR's *সয়স আট*) |
| "Take deep breaths" (from the translation) | ✘ | ✔ gone |
| 20-20-20 **and** blink often | half (20-20-20 only) | ✔ both |
| Computer work → eye strain | missed | ✔ captured |
| Presbyopia diagnosis | ✔ | ✘ **missed** |
| Glasses | plano +1.50 add BE, PAL | +1.5 D add, **RE only**, PAL |
| CMC | ×3 rows, gel 0.5%, confused frequency | ×2 rows, gel 0.5%, "4/day once daily" + a second "twice daily / wash eyes" row |
| New errors | — | **Diabetes** added (negation lost: *সুগার প্রেশার … নেই*); "Normal IOP" (from the translation's "Your pressure is normal"); burning coded as "Itching" |

**Script 4: Instruct extracts more, but invents more.**

| | VL-4B (p17) | Instruct (p21) |
|---|---|---|
| Output shape | 1 complaint + "Nausea" ×4, then a loop cut-off | Full structure: exam, investigations, advice, follow-up |
| Correct items | Mr. Sharma; symptom words | Mr. Sharma, VA done, OCT, FA, fundus photo, "supplements", **3-month OCT + photo follow-up** |
| Diagnosis | none | ✘ **Diabetic macular edema** (provisional) + ✘ **Dry eye disease** (from *শুষ্ক বা ড্রাই এজ* = "dry age-related") |
| Invented history | — | ✘ constipation, nausea, chest pain (Whisper translation), ✘ optic nerve atrophy, ✘ retinal detachment, ✘ vitreous haemorrhage |
| Medications | none | 2 **empty** medication rows |
| Dry AMD | missed | missed (the correct diagnosis is still never written) |

### 3.3 LLM verdict

- **Neither 4B model is good enough on its own.** Swapping VL-4B for Instruct-2507 moved F1 from 0.55 to 0.53, essentially unchanged.
- **Instruct is safer on Script 1** (half the false positives, no invented diagnoses) but **worse on Script 4** (11 false positives, including 3 serious invented retinal diagnoses).
- **Instruct 8-bit is 3–4× slower** on the M4 (3–5 minutes per prescription).
- **Both are misled by the same input:** the looping Whisper English translation. "Constipation/nausea", "Your pressure is normal" and "wash eyes / deep breath" appear in both models' outputs.
- **Both still repeat themselves.** p20's terms list repeats "dus chokhe…" 4× and triggered the loop warning.

---

## 4. End-to-end scores, every run

| Output | Round | Lang | Script | ASR | LLM | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | F1 | LLM time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| p0 | 1 | EN | Glaucoma | Whisper-large-v3 | qwen3-vl-4b | 25 | 14 | 6 | 5 | 0 | 7 | 74% | 80% | 0.77 | 80 s |
| p1 | 1 | EN | Dry eye | Whisper-large-v3 | qwen3-vl-4b | 16 | 13 | 3 | 0 | 0 | 3 | 84% | 100% | 0.91 | 84 s |
| p3 | 1 | EN | Script 5 AMD | Whisper-large-v3 | qwen3-vl-4b | 25 | 10 | 10 | 4 | 1 | 3 | 87% | 80% | 0.83 | 80 s |
| p2 | 1 | BN | Script 1 | Whisper-large-v3 | qwen3-vl-4b | 23 | 4 | 4 | 14 | 1 | 6 | 57% | 35% | 0.43 | 55 s |
| p4 | 1 | BN | Script 4 | Whisper-large-v3 (hi) | qwen3-vl-4b | 25 | 0 | 0 | 25 | 0 | 4 | 0% | 0% | 0.00 | 23 s |
| p5 | 2 | BN | Script 1 | Vaani-Bengali | qwen3-vl-4b | 23 | 2 | 2 | 13 | 6 | 6 | 40% | 17% | 0.24 | 46 s |
| p9 | 2 | BN | Script 4 | Vaani-Hindi (hi) | qwen3-vl-4b | 25 | 0 | 0 | 14 | 11 | 6 | 0% | 0% | 0.00 | 42 s |
| p11 | 2 | BN | Script 3 | Whisper-large-v3 (pa) | qwen3-vl-4b | 18 | 0 | 1 | 16 | 1 | 2 | 33% | 6% | 0.10 | 14 s |
| p8 (= p13) | 2 | EN | Script 5 AMD | Whisper-large-v3 | qwen3-vl-4b | 25 | 12 | 5 | 7 | 1 | 5 | 77% | 68% | 0.72 | 88 s |
| p10 (= p15) | 2 | EN | Dry eye | Whisper-large-v3 | qwen3-vl-4b | 19 | 11 | 7 | 0 | 1 | 3 | 86% | 95% | 0.90 | 67 s |
| p12 | 3 | BN | Script 1 | IndicConformer 30 s | qwen3-vl-4b | 23 | 0 | 0 | 15 | 8 | 3 | 0% | 0% | 0.00 | 25 s |
| p14 | 3 | BN | Script 4 | IndicConformer (hi) | qwen3-vl-4b | 25 | 0 | 0 | 22 | 3 | 3 | 0% | 0% | 0.00 | 14 s |
| p16 (= p19) | 4 | BN | Script 1 | IndicConformer 15 s | qwen3-vl-4b | 23 | 8 | 8 | 2 | 5 | 8 | 67% | 70% | 0.68 | 97 s |
| p17 | 4 | BN | Script 4 | IndicConformer 15 s | qwen3-vl-4b | 25 | 1 | 5 | 7 | 12 | 2 | 75% | 24% | 0.36 | 48 s |
| p18 | 4 | BN | Script 3 | IndicConformer 15 s | qwen3-vl-4b | 18 | 0 | 3 | 1 | 14 | 2 | 60% | 17% | 0.26 | 36 s |
| p20 (= p22) | 5 | BN | Script 1 | IndicConformer 15 s | Qwen3-4B-Instruct-2507 8-bit | 23 | 7 | 7 | 2 | 7 | 4 | 78% | 61% | 0.68 | 286 s |
| p21 | 5 | BN | Script 4 | IndicConformer 15 s | Qwen3-4B-Instruct-2507 8-bit | 25 | 3 | 6 | 7 | 9 | 11 | 45% | 36% | 0.40 | 186 s |

### 4.1 Progress by configuration

| Configuration | Gold | Found | FP | Lost in ASR | Missed by LLM | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|
| EN · Whisper + VL-4B (round 1) | 66 | 56 | 13 | 9 | 1 | 81% | 85% | 0.83 |
| EN · Whisper + VL-4B (round 2) | 44 | 35 | 8 | 7 | 2 | 81% | 80% | 0.80 |
| BN · Whisper-large-v3 + VL-4B | 66 | 9 | 12 | **55** | 2 | 43% | 14% | 0.21 |
| BN · Vaani + VL-4B | 48 | 4 | 12 | 27 | 17 | 25% | 8% | 0.12 |
| BN · IndicConformer 15 s + VL-4B | 66 | 25 | 12 | **10** | 31 | 68% | 38% | 0.49 |
| BN · IndicConformer 15 s + VL-4B (Scripts 1+4) | 48 | 22 | 10 | 9 | 17 | 69% | 46% | 0.55 |
| BN · IndicConformer 15 s + Instruct-2507 (Scripts 1+4) | 48 | 23 | 15 | 9 | 16 | 61% | 48% | **0.53** |

**Bengali F1 went from 0.21 to 0.55 (2.6×), driven by the speech-model change.** Facts lost in speech-to-text fell from 83% to about 15%. The LLM step now loses 16–17 facts per two scripts, about twice what the ASR loses.

---

## 5. False positives across the project

| False positive | Runs | Source | Status |
|---|---|---|---|
| Steroids (Prednisolone, Dexamethasone, Dex implant) | p2, p5, p3, p8/p13 | LLM guessing from garbled text / "Amsler" misheard | Gone in Bengali since IndicConformer; **still present in English Script 5** |
| Thyroid eye disease | p2, p5, p12, p16, (p20 as history) | "Thyroid is there" in the Whisper translation + KB id DIS-149 | Diagnosis gone with Instruct; history code still wrong |
| Glaucoma / POAG / "Normal IOP" | p5, p12, p16, p20 | "Your pressure is normal" in the Whisper translation | Instruct turns it into "Normal IOP" instead of glaucoma |
| Cataract, corneal opacity | p16 | Matcher: *চোখে ছয়*, *চোখে জেল* | Gone with Instruct |
| Diabetes | p20 | Negation lost (*সুগার প্রেশার … নেই*) | **New with Instruct** |
| Diabetic macular edema, RD, vitreous haemorrhage, optic atrophy | p21 | Instruct guessing from AMD vocabulary | **New with Instruct** |
| Nausea / constipation / chest pain / fever | p4, p9, p14, p17, p21 | Whisper translation loop | **Present in every Script 4 run** |
| Denied photophobia as a complaint | p1, p10 | Negation lost | English, unchanged |
| Nepafenac code for artificial tears | p1, p10 | KB-id error | English, unchanged |
| Name/age from greetings or ASR noise | p5, p16, p20 | *আসুন বসুন*, *সয়স আট* | Unchanged |
| Duplicate rows (×2 to ×9) | p5, p16, p17, p18, p20 | LLM repetition | Reduced with Instruct, not gone |

---

## 6. Current best configuration

| Stage | Choice | Why |
|---|---|---|
| English speech | Whisper-large-v3 | Only option tested; ~80–85% recall end-to-end |
| Bengali/Hindi speech | **IndicConformer-600M, 15 s pieces, language chosen manually** | 82% of facts captured, fastest, no loops |
| LLM | **Tie**: VL-4B (faster, 72 s) vs Instruct-2507 8-bit (safer on Script 1, 236 s) | Both F1 ≈ 0.54 on Bengali; neither is decisive |
| English helper translation | **Should be removed for Bengali** | Largest remaining source of false positives |

---

## 7. Recommendations (in priority order)

| # | Change | Expected effect | Effort |
|---|---|---|---|
| 1 | **Stop sending the Whisper English translation** when the Indic backend is used (or drop it when it repeats itself) | Removes nausea/constipation, "normal IOP", thyroid and "wash eyes / deep breath" false positives, about half of all Bengali FPs | Small code change |
| 2 | **Remove duplicate rows** after the LLM (same drug/complaint + eye → keep one) | Cleans CMC ×2–3, Itching ×9, Nausea ×4 | Small |
| 3 | **Negation handling** (নেই / না / nahi / no / without) before extraction | Removes Diabetes (p20) and denied-photophobia errors | Small–medium |
| 4 | **Drop medication rows whose drug name is not in the transcript**, and empty rows | Removes empty rows (p21) and invented steroids (English) | Small |
| 5 | **Stop the matcher suggesting diseases from 2-word Bengali phrases** | Removes cataract/corneal-opacity-type FPs | Small |
| 6 | Try **Qwen3-4B-Instruct-2507 at 6-bit** (Q6_K / MLX 6bit): close to 8-bit quality at about 1.5× the speed | 286 s → ~150–190 s per prescription | Setting in LM Studio |
| 7 | Re-run **Script 3 and the English recordings with Instruct-2507** | Completes the LLM comparison (only Scripts 1 and 4 have an A/B test so far) | You |
| 8 | Make the **language dropdown required** (no auto-detect for audio) | Prevents the hi/pa misdetections from rounds 1–3 | Small |

**Bottom line**

- **Speech recognition is largely solved** for Bengali (IndicConformer, 82% of facts captured) and good for conversational English (Whisper).
- **Swapping the 4B LLM did not raise accuracy** (F1 0.55 vs 0.53). The Instruct model is safer on some cases, riskier on others, and 3× slower.
- **The biggest remaining gains are in the pipeline, not the model**: removing the looping English translation, removing duplicates, and handling negation (recommendations 1–3). Those errors appear in every LLM tested.
