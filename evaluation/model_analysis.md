# Model evaluation: 5 recordings → prescription JSON

**Setup under test** (read from each output's `asr` / `llm` blocks)

- ASR: `whisper-cli` (Whisper large-v3) for **all 5 runs**. The `indic` backend (Vaani / IndicConformer) was **not** used, even for the Bengali audio.
- LLM: `qwen/qwen3-vl-4b` via LM Studio.
- Ground truth: the *Scripts* Google Doc (Scripts 1, 4, 5) and `samples/glaucoma_recording_script.txt`. p1 has no script, so it is scored against its own transcript (LLM-only score).
- Scoring script: `evaluation/score.py`. Each clinically relevant item in the script is labelled by hand.

## 1. Audio ↔ output mapping (inferred from timestamps and content; please confirm)

| Output file | Content | Likely recording | Script | Lang detected |
|---|---|---|---|---|
| prescription.json (p0) | Glaucoma, Sunil Das | ElevenLabs Roger 08_57 | samples/glaucoma_recording_script.txt | en ✔ |
| prescription (1).json (p1) | Dry eye / digital strain, Mr. Sharma | ElevenLabs Roger 09_01 | none in doc | en ✔ |
| prescription (2).json (p2) | Presbyopia + dry eye + MGD | ElevenLabs Arfa (Bengali) | Script 1 | bn ✔ |
| prescription (3).json (p3) | Dry AMD, Mr. Sharma | Guha Sarani 9 (m4a) | Script 5 | en ✔ |
| prescription (4).json (p4) | Dry AMD (Bengali) | Guha Sarani 10 (m4a) | Script 4 | **hi ✘** (wrong) |

Guha Sarani (1) and Guha Sarani 2 have no outputs in the folder.

## 2. Headline numbers

| Output | Gold items | Correct | Partial | Lost in ASR | Missed by LLM | False +/halluc. | Precision | Recall | Strict accuracy | F1 | Med-field acc. | KB-id acc. |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| p0 EN glaucoma | 25 | 14 | 6 | 5 | 0 | 7 | 74% | 80% | 56% | 0.77 | 16/21 | 9/17 (53%) |
| p1 EN dry eye (vs transcript) | 16 | 13 | 3 | 0 | 0 | 3 | 84% | 100% | 81% | 0.91 | 4/6 | 7/9 (78%) |
| p2 BN presbyopia/dry eye | 23 | 4 | 4 | 14 | 1 | 6 | 57% | 35% | 17% | 0.43 | n/a | 1/5 (20%) |
| p3 EN dry AMD | 25 | 10 | 10 | 4 | 1 | 3 | 87% | 80% | 40% | 0.83 | 1/2 | 12/18 (67%) |
| p4 BN dry AMD | 25 | 0 | 0 | 25 | 0 | 4 | 0% | 0% | 0% | 0.00 | n/a | 0/1 (0%) |
| **All 5** | 114 | 41 | 23 | 48 | 2 | 23 | **74%** | **56%** | **36%** | **0.64** | | |

Definitions:

- **Correct**: item present with all details right.
- **Partial**: item present, but a detail is wrong (eye, dose, KB id, wrong section).
- **Precision** = (correct + partial) / (correct + partial + false positives).
- **Recall** = (correct + partial) / gold items.
- **Strict accuracy** = correct / gold items.
- **Med-field accuracy**: drug, strength, eye, dose, frequency, duration and instructions, checked per prescribed drug.
- **KB-id accuracy**: share of `terms[]` rows mapped to the right knowledge-base entry.

**By language**

| Language | Runs | Precision | Recall | Verdict |
|---|---|---|---|---|
| English | p0, p1, p3 | 81% | 85% | Usable draft; needs doctor review |
| Bengali | p2, p4 | 44% | 17% | Not usable. The failure is at the speech step |

**Where the errors come from**: 48 of the 50 missed items (96%) were **never in the transcript** (ASR loss). Only 2 were missed by the LLM. The LLM's main fault is the **23 false positives and hallucinations**, not missed content.

## 3. Speech-to-text (ASR) quality

| Run | WER* | CER* | Key medical-term recall | Time | Main issues |
|---|---|---|---|---|---|
| p0 EN | 0.33 | 0.28 | 27/36 (75%) | 22 s | Two whole doctor turns dropped: IOP 18/28, AC depth, C:D 0.4/0.7, "POAG LE + glaucoma suspect RE". Hindi line "aankhon mein dard" dropped. VA came out as "six-ninths" |
| p1 EN | n/a | n/a | n/a | 39 s | Transcript stops after the drop instructions and ends in a hallucinated "Patient. Patient. Patient…" loop. The rest of the consult is lost |
| p3 EN | 0.49 | 0.36 | 20/40 (50%) | 32 s | Rare terms misheard: metamorphopsia→"metamorphosis in my blood pressure", Goldmann applanation→"Goldman Appalachian", ranibizumab→"B-Rani-Bilumab", AREDS2→"R-Cyte-H2", Amsler grid→"amstrad", photodynamic→"another dynamic", wet→"white". Middle section repeated and last paragraph lost (no "3 months" follow-up) |
| p2 BN | 0.83 | 0.78 | ~5/30 | 136 s | Only ~27% of the words came out. Long `্বের্বের্বের…` garbage loop. Machine translation repeated "maibomian gland plugging and barfractase" 5× |
| p4 BN | 1.00 | 0.96 | 0 | 103 s | Detected as **Hindi**. Devanagari phonetic garbage looped 8×. The translation invented a GI story (constipation, nausea) |

\* WER/CER after removing speaker labels and punctuation. They are pessimistic for English because number formats differ ("58" vs "fifty-eight"). Term recall is the more meaningful figure.

**ASR verdict**:

- Whisper large-v3 is acceptable for conversational English.
- It is weak on dense ophthalmic jargon (Script 5 style).
- It is **unusable for Bengali** here: hallucination loops, wrong language detection, and 4–6× slower.

## 4. LLM extraction quality (qwen3-vl-4b)

### False positives and hallucinations (23 in total)

**Clinically dangerous (would change treatment)**

1. p2: **Prednisolone acetate** and **Dexamethasone** prescribed. No steroid was mentioned (dry eye / MGD patient).
2. p3: **Dexamethasone intravitreal implant** prescribed from the ASR word "amstrad" (actually Amsler grid).
3. p2: Diagnosis **Thyroid eye disease** (the patient only takes thyroxine) and **Corneal opacity** (from ASR garbage "barfractase").
4. p0: warning "Timolol – avoid in asthma", although the patient said *asthma nahi hai*. The caution check ignores negation.

**Clinical-record errors**

5. p1: denied symptom "sensitivity to light" recorded as a complaint and coded SYM-045 *Sensitivity to wind/dust*.
6. p3: "no cotton wool spots" coded as the positive sign SGN-043 *Cotton-wool spots* (negation lost).
7. p0: visual-field test coded as DIS-133 *Homonymous hemianopia*; OCT listed as a clinical finding.
8. p2: "IOP normal" invented. "Prashar nei" means no blood pressure.
9. p0: CMC strength 0.5% invented; dose "4 drops once daily" instead of 1 drop QID; "at bedtime" added to Timolol (it is BD).
10. p1: artificial tears coded MED-028 (Nepafenac); eye RE instead of both eyes.
11. p4: patient name "Dr. Babu", plus 3 GI history items.

**Noise**

12. Duplicate rows: p0 procedures duplicate investigations.
13. `phase: "pre-op"` on every non-surgical prescription (p0, p1, p3).
14. `form: "Other"` on every drug.
15. Empty glasses row in p3.

### Systematic LLM weaknesses

- **Terms table is unreliable** (KB-id accuracy 29/50 = 58%). Examples:
  - left/right eye ids swapped (OPT-001/002)
  - amlodipine→Latanoprost
  - "no sugar"/"asthma nahi hai"→Headache
  - "blood pressure"→Automated perimetry
- **Negation handling**: 4 of 23 FPs come from denied or negative statements.
- **Fills schema fields with guesses** instead of leaving them blank (phase, form, strength).
- **Invents plausible drugs when the transcript is noisy.** Grounding checks that an id exists in the KB, but not that the drug was actually said.

### What worked well

- English medications: drug name, strength, eye and frequency were right for Latanoprost and Timolol; AREDS2 was recovered from "R-Cyte-H2".
- Visual acuity, investigations (HFA 24-2, OCT-RNFL), advice and follow-up were extracted cleanly in p0.
- Diagnoses in English were correct: glaucoma LE, dry eye + CVS, dry AMD LE.
- Correctly did **not** prescribe ranibizumab ("not indicated") in p3.
- LLM time 23–84 s; no timeouts or runaways after the StreamGuard fix.

## 5. Latency

| Run | ASR | LLM | Total |
|---|---|---|---|
| p0 | 22 s | 80 s | ~1.7 min |
| p1 | 39 s | 84 s | ~2.1 min |
| p2 | 136 s | 55 s | ~3.2 min |
| p3 | 32 s | 80 s | ~1.9 min |
| p4 | 103 s | 23 s | ~2.1 min |

## 6. Root causes (ranked by impact)

1. **Bengali ASR**: whisper-cli was used instead of the `indic` backend, and language auto-detection picked Hindi for p4. This caused 39 of the 48 ASR losses.
2. **Whisper hallucination loops and dropped segments**, even in English (p0 lost 2 turns; p1 truncated). The previous-text conditioning and default thresholds allow loops.
3. **A 4B vision-language model is too small** for reliable structured medical extraction. It causes the wrong KB ids, invented drugs, and schema guessing.
4. **No negation handling** in the matcher, caution cross-check, or terms mapping.
5. **Grounding is too permissive**: a valid `kb_id` is accepted even when the drug name never occurs in the transcript.
6. **Schema forces guesses**: `phase` and `form` enums have no "unspecified" default.

## 7. Recommendations (in priority order)

| # | Change | Expected effect |
|---|---|---|
| 1 | For bn/hi use `ASR_BACKEND=indic` and pass `--lang bn` or `--lang hi` explicitly (never auto-detect) | Fixes p4-type failures; large recall gain in Bengali |
| 2 | Whisper flags: `--max-context 0` (no previous-text conditioning), `--entropy-thold 2.4`, `--suppress-nst`, VAD (`--vad` with the silero model); split audio into ≤30 s chunks | Removes loops and dropped turns (p0, p1, p2) |
| 3 | Swap the LLM to **Qwen3-4B-Instruct-2507** (text-only, same size) or **Qwen3-8B / Gemma-3-12B Q4** if RAM allows | Fewer wrong ids and hallucinations |
| 4 | **Drug hallucination guard**: drop any medication whose generic name, brand, or a fuzzy/phonetic alias is not found in the transcript. Flag it instead of printing it | Would have removed all 3 invented steroids |
| 5 | **Negation detection** ("no", "not", "nahi", "nei", "na", "without", "denies") before the caution check and symptom coding | Removes 4 FPs, including the false asthma warning |
| 6 | Schema: add `"unspecified"` to `phase` and `form` (default); drop `procedures` when the same item is in `investigations` | Removes noise rows |
| 7 | Build `terms[]` from the deterministic lexical matcher, not the LLM | KB-id accuracy up from 58% to near the matcher's precision |
| 8 | ASR medical prompt: feed the top KB hotwords (metamorphopsia, Amsler, AREDS2, ranibizumab, applanation…) through `--prompt` | Fewer rare-term mishearings (p3) |
| 9 | Re-run the same 7 recordings after steps 1–3 and re-score with `evaluation/score.py` | Before/after comparison |

**Bottom line**: in English the pipeline gives a usable draft (≈81% precision, 85% recall), but it still needs a doctor's check, especially for medicine dose/frequency and invented items. In Bengali it currently fails, and the fix is mainly at the speech step (Indic ASR, forced language), not the LLM.
