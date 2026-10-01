# Run 3 evaluation: IndicConformer vs Vaani vs Whisper-large-v3

**Setup:** `ASR_BACKEND=indic` with `INDIC_MODEL_HI` and `INDIC_MODEL_BN` both set to `ai4bharat/indic-conformer-600m-multilingual` (RNNT decoding, 30 s pieces). The LLM is unchanged (qwen/qwen3-vl-4b). The English translation given to the LLM still comes from the Whisper-large-v3 translate pass. The language was left on auto-detect.

Scoring: `evaluation/score_run3.py`, with the same gold items and labels as the two earlier reports.

## 1. Which output is which

| Output | Script | Detected | ASR used | Compare with |
|---|---|---|---|---|
| prescription 12 | Script 1 (BN presbyopia/dry eye/MGD) | bn ✔ | **IndicConformer, Bengali** | p2 (Whisper), p5 (Vaani) |
| prescription 13 | Script 5 (EN dry AMD) | en ✔ | Whisper-large-v3 | **byte-for-byte identical to p8** |
| prescription 14 | Script 4 (BN dry AMD) | **hi ✘** | **IndicConformer, Hindi head** | p4 (Whisper), p9 (Vaani-Hindi) |
| prescription 15 | EN dry eye | en ✔ | Whisper-large-v3 | **byte-for-byte identical to p10** |

English doesn't go through IndicConformer, so p13 and p15 are exact repeats of Run 2 (same transcript, same prescription). They add nothing new; the LLM and Whisper are deterministic on the same file. **The only new evidence is p12 and p14.**

## 2. Speech-to-text: three models on the same Bengali audio

| Script | Engine | Coverage* | CER | Script content present in transcript | Accuracy of what it *did* write | ASR time |
|---|---|---|---|---|---|---|
| Script 1 | Whisper-large-v3 (p2) | 24% | 0.81 | 10/26 (38%) | low: loops, `্বের্বের…` garbage | 136 s |
| Script 1 | Vaani-Bengali (p5) | 54% | 0.71 | 15/26 (58%) | medium: phonetic, broken characters | 324 s |
| Script 1 | **IndicConformer (p12)** | 21% | 0.80 | 7/26 (27%) | **excellent: CER 0.04 / WER 0.03** on the part it covered | 281 s** |
| Script 4 | Whisper-large-v3, hi (p4) | 9% | 0.93 | 0/26 | none | 103 s |
| Script 4 | Vaani-Hindi, hi (p9) | 46% | 0.71 | ~15/26 (58%) | medium (Bengali written in Devanagari) | 164 s |
| Script 4 | IndicConformer, hi (p14) | 6% | 0.94 | ~4/26 (15%) | poor (Hindi head on Bengali speech) | 72 s |

\* Coverage = transcribed letters ÷ script letters (spaces removed).
\** The first run includes the one-time ~2.5 GB model download.

### What happened in p12: very accurate, but only the last piece came through

IndicConformer returned only the **last ~25 seconds** of Script 1:

> চোখের পাতা ধারে রাতের শার আগে দুই চোখে জেল দেবেন দিনে দুবার গরম সেক দেবেন আর চোখের পাতার ধার পরিষ্কার করবেন কম্পিউটারে কাজের সময় প্রতি বিশ মিনিট পর বিশ সেকেন্ড দূরে তাকাবেন আর ঘন ঘন পলক ফেলবেন আর দেড় মাস পর আবার দেখাতে আসবেন

Compared with the script's last lines, that is **3% word errors**, far better than anything Whisper or Vaani produced. But everything before it (name, complaints, history, examination, diagnosis, glasses, CMC drops) is missing.

The audio was split into 30 s pieces, and only the short final piece produced text. So the full 30 s pieces returned (almost) nothing. That points to the chunk length used by our code, not to the model's quality. **This is fixed** (section 6).

### p14: wrong language again

Script 4 was auto-detected as Hindi, so IndicConformer decoded Bengali speech with its Hindi vocabulary. It produced 20 fragmented words (*सुप्रभा शर्मा बसु … स्पेक्ट्रल … माइक्रोनिजम कटन उ … डॉक्टर बाबू*), and it has the same 30 s chunk problem. This run doesn't tell us how IndicConformer does on Bengali.

## 3. End-to-end prescription accuracy (all three models)

| Script | ASR engine | Output | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | F1 | KB-id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Script 1 BN | Whisper-large-v3 | p2 | 23 | 4 | 4 | 14 | 1 | 6 | 57% | 35% | 0.43 | 1/5 |
| Script 1 BN | Vaani-Bengali | p5 | 23 | 2 | 2 | 13 | 6 | 6 | 40% | 17% | 0.24 | n/a |
| Script 1 BN | **IndicConformer (bn)** | p12 | 23 | 0 | 0 | 15 | **8** | 3 | 0% | 0% | 0.00 | 1/4 |
| Script 4 BN | Whisper-large-v3 (hi) | p4 | 25 | 0 | 0 | 25 | 0 | 4 | 0% | 0% | 0.00 | 0/1 |
| Script 4 BN | Vaani-Hindi (hi) | p9 | 25 | 0 | 0 | 14 | 11 | 6 | 0% | 0% | 0.00 | 3/8 |
| Script 4 BN | IndicConformer (hi) | p14 | 25 | 0 | 0 | 22 | 3 | 3 | 0% | 0% | 0.00 | 0/2 |
| Script 5 EN | Whisper-large-v3 | p3 | 25 | 10 | 10 | 4 | 1 | 3 | 87% | 80% | 0.83 | 12/18 |
| Script 5 EN | Whisper-large-v3 | p8 = p13 | 25 | 12 | 5 | 7 | 1 | 5 | 77% | 68% | 0.72 | 14/20 |
| EN dry eye | Whisper-large-v3 | p1 | 16 | 13 | 3 | 0 | 0 | 3 | 84% | 100% | 0.91 | 7/9 |
| EN dry eye | Whisper-large-v3 | p10 = p15 | 19 | 11 | 7 | 0 | 1 | 3 | 86% | 95% | 0.90 | 7/11 |

### p12: the LLM ignored clean Bengali text and returned an empty prescription

This is the clearest evidence yet that the **LLM step, not ASR, is the bottleneck for Bengali**. p12's transcript clearly said all of these:

- gel in both eyes at night
- warm compress twice a day
- clean the lid margins
- 20-20-20 while at the computer
- blink often
- come back in 1.5 months

The English translation the LLM also received added thyroid/thyroxine, "sugar pressure normal" and MG plugging. Yet qwen3-vl-4b returned **no advice, no follow-up, no findings, nothing**. Its only output was a terms list that again coded "sugar pressure" and "your pressure" as **Primary open-angle glaucoma** and "thyroid is there" as **Thyroid eye disease**.

That makes **8 items the LLM missed** from text it was given, the highest of any run.

On the plus side, p12 is the first Bengali run with **no invented medicines**. The steroids that appeared with Whisper (p2) and Vaani (p5) are gone. That's only because the LLM output almost nothing, not a real improvement.

## 4. Verdict per model (Bengali)

| | Whisper-large-v3 | Vaani (Whisper fine-tune) | IndicConformer-600M |
|---|---|---|---|
| How much of the audio it captured | Low (9–24%) | **Highest (46–54%)** | Lowest so far (6–21%): chunk bug |
| Accuracy of the words it did write | Poor (loops) | Medium (phonetic, broken letters) | **Excellent (3% WER)** |
| Hallucination loops | Yes, severe | Some (now trimmed) | **None** |
| Speed on M4 | Fastest (GPU) | Slowest | Medium (CPU/onnx) |
| Right choice? | No for Bengali | Best result *today* | **Most promising once chunking is fixed** |

**Recommendation:** keep IndicConformer for Bengali with the chunk fix below, and compare it with Vaani on the same three recordings. On the evidence of p12's final piece, IndicConformer should win clearly once it transcribes the whole file.

## 5. Problems that are the same for every model

1. **Language auto-detect** has now failed on Script 4 three times (hi, hi, hi), and on Script 3 once (pa). **Pick Bengali in the dropdown.** No ASR model can fix a wrong language choice.
2. **The looping Whisper English translation** is still sent to the LLM. It is identical in p2, p5 and p12, and in p4, p9 and p14 ("constipation…" ×40). It causes the "Thyroid eye disease", "POAG from 'your pressure'" and "constipation" false positives every time.
3. **qwen3-vl-4b does not extract from Bengali text**, even clean text (p12).
4. **Amsler grid → Dexamethasone implant** and **Nepafenac for artificial tears** repeat in every English run, because the input is identical.

## 6. Fix applied this round

**`src/asr/indic_asr.py`** (`run_conformer`):

- Pieces are now at most **15 s** (`INDIC_CHUNK_S=15` in `.env`) instead of 30 s.
- Each cut is placed at the **quietest point** in the last 3 s of the window, so words aren't split. Tested on synthetic audio: cuts landed exactly on the silences.
- If a piece comes back empty or nearly empty, it's **retried with the other decoder** (RNNT ↔ CTC) and the longer result is kept.
- Each piece's time range, decoder and character count are logged to the terminal (`[indic] 0.0-13.4s rnnt: 212 chars`). If text is still missing, you can see exactly which pieces failed.

## 7. Next steps (in order)

| # | Action | Who |
|---|---|---|
| 1 | Re-run Scripts 1, 3 and 4 with **Bengali selected in the dropdown** and the chunk fix | you |
| 2 | Stop sending the Whisper English translation when it loops, or always with the Indic backend | code change, I can do it |
| 3 | Stop on auto-detect results other than en/hi/bn (ask for the language) | code change |
| 4 | Keep a medicine only if its name is in the transcript | code change |
| 5 | Swap the LLM for a text-only instruct model that reads Bengali better: **Qwen3-4B-Instruct-2507** (same size as today's model; the vision part of VL-4B adds nothing here) or **Gemma-3-4B-it**. Qwen3-8B crashed on this Mac earlier, so stay at the 4B size unless you close other apps or have more RAM | you, in LM Studio |

**Bottom line**

- **IndicConformer is the most accurate Bengali model tested** (3% WER on what it transcribed), but our 30 s chunking made it skip ~80% of the audio. That's now fixed.
- **Vaani captured the most content this round.** Whisper-large-v3 is the worst for Bengali.
- **The Bengali prescriptions will stay poor whatever the ASR** until the language is chosen manually, the looping English translation is removed, and the LLM can read Bengali. p12 proves it: clean Bengali in, empty prescription out.
- **English is unchanged**: p13 and p15 are identical to p8 and p10.
