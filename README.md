# AI Speech → Ophthalmology Prescription (local)

Doctor–patient conversation audio (and/or transcript) → recognised ophthalmic terminology → structured prescription draft, grounded in the **Ophthalmology Vocabulary** workbook. Local mode runs on your Mac without cloud calls; optional AWS production deployment is documented in [DEPLOYMENT.md](DEPLOYMENT.md).

```
audio ──► ASR (Whisper large-v3 / Indic models) ──► transcript (+ English translation, token confidence, duration)
                                                        │          (a transcript you supply skips ASR)
  STAGE 1  transcription accuracy ◄─────────────────────┤  measured WER/CER if a reference script is given,
           high · medium · low · unusable                │  otherwise estimated (confidence, language fit, script,
                   │                                     │  garbling, loops, speech rate, translation agreement)
  STAGE 2  general keywords ◄───────────────────────────┤  eye side, numbers, durations, frequency, drops,
                   │                                     │  lay symptoms, yes/no, follow-up (en / hi / bn)
  STAGE 3  medical terms ◄──────────────────────────────┘  KB matcher, strictness set by the stage-1 tier;
           │  terms heard in low-confidence words are flagged ⚠
           ▼
  LLM in Ollama / LM Studio (JSON-schema constrained; skipped when the transcript is "unusable")
           ▼  grounding against KB ids
  output/*.rx.json  +  output/*.rx.md  (+ web UI)
```

Why two models: Ollama and LM Studio run **LLMs**; they don't serve speech-to-text models like Whisper or Qwen3-ASR. ASR runs in MLX or whisper.cpp. The Ollama/LM Studio LLM turns the text into the prescription.

## 1. Setup (Mac, Apple Silicon)

```bash
brew install node ffmpeg          # Node ≥ 20.12
npm install
npm run build-kb                  # xlsx → data/kb.json + data/hotwords.txt  (already built; rerun after editing the sheet)
cp .env.example .env
```

### Extraction LLM: pick one
**Ollama**
```bash
ollama pull qwen3:8b              # 16 GB RAM
# 32 GB+ RAM: a larger Qwen 3.6 / Gemma 4 26B model gives better JSON (tags: ollama.com/library)
```
**LM Studio:** download a model, open the Developer tab, start the server (port 1234), then in `.env`:
```
LLM_PROVIDER=lmstudio
LLM_MODEL=<model id shown in LM Studio>
```

### Speech-to-text: Whisper large-v3 (English, Hindi and Bengali)
```bash
brew install whisper-cpp
mkdir -p models && curl -L -o models/ggml-large-v3.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
```
This is the default (`ASR_BACKEND=whisper-cli`). Each recording's language is auto-detected, or you can pick it in the web UI / pass `--lang en|hi|bn`.

| Audio | What happens |
|---|---|
| English / Hinglish | 1 pass → English transcript (with medical vocabulary prompt) |
| Hindi | pass 1 → Devanagari transcript, pass 2 → Whisper's English translation |
| Bengali | pass 1 → Bengali-script transcript, pass 2 → English translation |

The LLM gets both texts and always writes the prescription in English. The term matcher reads native script by transliterating it to Roman (मोतियाबिंद → motiyabind, অলোপাটাডিন → olopatadin → Olopatadine). Set `ASR_TRANSLATE=off` to skip pass 2 (faster, a little less accurate for Bengali).

Use `ggml-large-v3.bin`, not `large-v3-turbo`: turbo was not trained for translation.

Optional alternatives: `ASR_BACKEND=whisper-server` (whisper.cpp server), `openai` (any OpenAI-compatible ASR server), or `qwen3-mlx` (Qwen3-ASR, very good for English/Hindi but **no Bengali**; `pip install -U mlx-qwen3-asr`).

### Better Hindi / Bengali: Indian-trained models (`ASR_BACKEND=indic`)
Whisper large-v3 is weak on Hindi and Bengali. The `indic` backend sends Hindi and Bengali audio to models trained on Indian speech. English audio, language auto-detect and the English translation still use Whisper.

| Language | Default model | Alternative |
|---|---|---|
| Hindi | `ARTPARK-IISc/whisper-large-v3-vaani-hindi` (Apache-2.0; WER ~9% Kathbath, ~11% FLEURS) | `ai4bharat/indic-conformer-600m-multilingual` |
| Bengali | `ARTPARK-IISc/whisper-medium-vaani-bengali` (MIT) | `ai4bharat/indic-conformer-600m-multilingual` |

```bash
python3 -m pip install -U transformers torch numpy
# only if you use IndicConformer (22 languages, MIT, gated): accept the terms on its Hugging Face page, then
python3 -m pip install onnxruntime==1.20.1 onnx torchaudio && hf auth login
```
`.env` → `ASR_BACKEND=indic` (set models with `INDIC_MODEL_HI` / `INDIC_MODEL_BN`). The first run downloads the model (about 3 GB for the Hindi large-v3, about 1.5 GB for Bengali medium). Each request reloads the model, which adds roughly 10–20 s. The Vaani Whisper models run on the Mac GPU (MPS); IndicConformer runs on the CPU via onnxruntime.

### Mac mini M4 notes
- qwen3:8b (Q4, ~5 GB) + Whisper large-v3 (~3 GB) fit in 16 GB. They run one after the other: whisper-cli exits before the LLM starts.
- Speed depends on RAM and recording length. Expect the Whisper passes to take tens of seconds for a 5-minute visit (two passes for Hindi/Bengali) and ~30–60 s for the LLM on 16 GB. Run `ollama ps` to confirm the model is 100% on GPU.
- On 24/32 GB you can raise `LLM_NUM_CTX=16384` or try a larger model.

Then check everything:
```bash
npm run check
```

## 2. Use it

```bash
npm run analyze -- samples/cataract_consult.txt              # instant: stage 1 accuracy → stage 2 keywords → stage 3 terms (no LLM)
npm run analyze -- visit.m4a --reference script.txt          # transcribe, then measure real WER/CER against the script
npm run match   -- samples/cataract_consult.txt              # instant: which KB terms are in it (no LLM)
npm run extract -- samples/cataract_consult.txt              # transcript → prescription
npm run transcribe -- visit.m4a                              # audio → output/visit.transcript.txt
npm run run -- visit.m4a                                     # audio → transcript → prescription (language auto-detected)
npm run run -- visit.m4a --lang bn                           # force Bengali
npm run extract -- samples/hindi_consult.txt --lang hi       # Hindi / Bengali transcripts work too (samples/bengali_consult.txt)
npm run run -- visit.m4a --transcript visit.txt              # a supplied transcript wins over ASR
npm run extract -- file.txt --model gemma4:e4b               # try another model without editing .env
npm run serve                                                # web UI: http://localhost:5055
```
In the web UI you can upload or record audio, fix the transcript, and then generate. Results are saved in `output/`.

## 2b. Local vs production models (`MODEL_ENV`)

`.env` has one switch:

- `MODEL_ENV=local`: speech runs on this Mac (IndicConformer for bn/hi, whisper.cpp for en) and the prescription LLM runs in LM Studio.
- `MODEL_ENV=production`: every `PROD_<NAME>` line overrides `<NAME>`. For example, `PROD_ASR_BACKEND=remote` points speech at the Lambda endpoint in `deploy/asr-lambda/`, and `PROD_LLM_PROVIDER=bedrock` sends the LLM step to Amazon Bedrock. For Bedrock, run `npm install` so the optional `@aws-sdk/client-bedrock-runtime` is present, and set AWS credentials.

`npm run check` prints which mode is active and tests both models.

### Eye-domain accuracy layer

These run on every prescription:

- `data/eye_lexicon.json`: Bengali, Hindi and English clinic phrases and ASR mishearings mapped to ophthalmology KB ids.
- `src/domain/negation.ts`: finds things the patient denied.
- `src/domain/postprocess.ts`: removes unheard medicines, duplicate rows, greeting-as-name, and false pre/post-op labels.

- `src/domain/numbers.ts`: decodes Bengali/Hindi number words (আটান্ন = 58) so ages, durations and values aren't guessed.
- Evidence check: every item quotes the transcript words it came from. Advice with no supporting words is removed, and other unsupported items are flagged.
- Coverage check (`COVERAGE_CHECK=on`, the default): a second LLM pass lists things said but missing from the draft, shown under "Check before signing". Set it to `off` to skip the extra call.

Each prescription you **Approve & save** in the UI goes into `data/approved/` and is reused as a prompt example. `npm run export-training` turns those into a LoRA training set; see `scripts/finetune-mlx.md`.

## 3. The three stages

**Stage 1 — transcription accuracy** (`src/quality/accuracy.ts`). Every transcript gets a score 0–1 and a tier.
With a reference script (`--reference`, or the "Reference script" box in the UI) it is *measured*: 1 − WER for English,
1 − CER for Hindi/Bengali, the same metrics as `evaluation/`. Without one it is *estimated* from:

| Signal | What it catches |
|---|---|
| confidence | mean ASR token probability (whisper.cpp `-ojf`, Vaani Whisper models, verbose_json servers; IndicConformer/Qwen3 don't report it) |
| language fit | share of everyday function words (है/का/में · আছে/না/কি · the/is/you) — audio decoded as the wrong language |
| script | Bengali visit written in Devanagari/Gurmukhi, English visit in Indian script |
| garbled | broken characters, `</`, lone consonants (Vaani byte-level failures) |
| repetition | hallucination loops ("Patient. Patient. Patient.") |
| speech rate | words per minute of audio — very low means sentences were dropped |
| translation agreement | Hindi/Bengali transcript vs Whisper's English translation agree on eye side, numbers, durations |
| keyword density | stage-2 keywords per 100 words |

The estimate is a weighted mean with a "weakest link" cap (one clearly failed core signal cannot be averaged away).
Audio decoded as an unsupported language (e.g. `pa`) is always *unusable*. Tiers: high ≥ 0.75, medium ≥ 0.55, low ≥ 0.35
(`QUALITY_HIGH/MEDIUM/LOW`). On the saved outputs in `output/` this ranks IndicConformer-15 s Bengali as high, Vaani Bengali
(CER 0.71) as low, and Bengali-heard-as-Hindi/Punjabi and looping transcripts as low/unusable, matching `evaluation/`.

**Stage 2 — general keywords** (`src/match/keywords.ts`). Everyday consultation words in English, romanised Hindi/Bengali
and native script: eye side, eye/vision, numbers, measurements (6/36, 16 mmHg), durations, time of day, frequency, dosage form,
lay symptoms, negation, yes/OK, speakers, follow-up. Romanised Hindi/Bengali forms are only used when the visit is in that
language, so English "do" is never read as Hindi "two". Reported on their own and used by stage 1.

**Stage 3 — medical terms, by tier**

| Tier | Matcher | LLM |
|---|---|---|
| high / medium | standard thresholds (same as before) | normal prompt |
| low | looser fuzzy match (0.75), candidate floor 0.5, 30% more candidates | told the transcript is noisy: rely on candidates + translation, leave fields empty rather than guess |
| unusable | as low | **not run** (`QUALITY_GATE=on`); terms are listed for reference. `--force`, the UI's "Generate anyway" or `QUALITY_GATE=off` run it anyway |

Terms heard in words the ASR marked low-confidence (`ASR_LOW_CONF`, default 0.5) are flagged ⚠ and get a "confirm it was said" warning.

## 4. Output format (for building the prescription)

`output/<name>.rx.json`:
| key | contents |
|---|---|
| `prescription.patient` | name, age, sex |
| `prescription.chief_complaints[]` | complaint (medical term), `kb_id`, eye (RE/LE/BE), duration, character, patient_words |
| `prescription.history` | systemic[] (k/c/o DM, HTN…), ocular[], current_medications[], allergies[] |
| `prescription.examination[]` / `clinical_findings[]` | test/finding, `kb_id`, eye, result as spoken (6/36 → 6/18 PH, 16 mmHg) |
| `prescription.diagnosis[]` | condition, `kb_id`, eye, grade, certainty |
| `prescription.medications[]` | `kb_id`, generic_name, brand_said, form (E/D, E/O, Tab…), strength, eye, dose, frequency (QID/TID/BD/HS…), duration, phase (pre-op/post-op) |
| `prescription.procedures[]`, `investigations[]` | with `kb_id` and eye |
| `prescription.glasses[]` | RE/LE sph, cyl, axis, add |
| `prescription.advice[]`, `follow_up[]` | counselling lines (mapped to CNS-ids), review schedule |
| `prescription.terms[]` | every ophthalmic term heard → canonical KB term + id |
| `kbRefs` | per item (`"medications.0"`): KB id/name + reference data (ICD-10, typical usage, cautions, brands) |
| `warnings[]` | items not in the KB, missing frequency/duration/eye, cautions that clash with the patient's history |
| `detectedTerms[]` | raw matcher hits with scores; `uncertain: true` = heard in low-confidence audio |
| `quality` | stage 1: `score`, `tier`, `source` (measured/estimated), `signals[]`, `issues[]`, `measured` (WER/CER) |
| `keywords` | stage 2: `hits[]` (category, key, heardAs, count), `byCategory`, `perHundredWords` |
| `policy` | stage 3 settings chosen from the tier; `llm.skipped` is set when the gate stopped the LLM |

Every `kb_id` is the sheet's ID column (DIS-001, MED-014…), so it can map straight to HMS master tables.

## 5. How the sheet is used ("formatting the data")
`npm run build-kb` reads the workbook and normalises every sheet into one term list (`data/kb.json`):

```json
{ "id": "MED-001", "category": "medicine", "name": "Moxifloxacin",
  "aliases": ["Vigamox", "Milflox", "Moxicip"], "colloquial": [],
  "details": { "Drug Class": "...", "Common Strength": "0.5%", "Typical Prescription Usage": "...", ... } }
```
- Abbreviation, synonym and brand columns become `aliases`. Hindi/Bengali and patient-phrase columns become `colloquial`.
- `Conversation Scenarios` rows become style examples. The closest one is shown to the LLM.
- `data/hotwords.txt` is the vocabulary prompt used to bias ASR toward correct drug and disease spellings.

To add vocabulary, add rows to the xlsx (keep the sheet and column names), then rerun `npm run build-kb`. The column mapping is in `SPECS` in `src/kb/build-kb.ts`.

Only matched candidates (about 60) plus a compact name index go into the prompt, not the whole sheet. That's roughly 5k tokens, so small models stay accurate.

## 6. Project layout
```
src/kb/build-kb.ts     xlsx → kb.json, hotwords
src/quality/accuracy.ts stage 1: transcription accuracy (estimate / tier / stage-3 policy)  (+ wer.ts: WER/CER vs a reference)
src/match/keywords.ts  stage 2: general keyword lexicon (en / hi / bn)
src/match/matcher.ts   stage 3: lexical/fuzzy KB term detection (+ translit.ts: Devanagari/Bengali → Roman)
src/asr/index.ts       ASR backends (+ indic_asr.py, qwen3_asr.py helpers)
src/llm/               schema, prompt, Ollama/LM Studio client
src/pipeline.ts        orchestration + KB grounding + safety checks
src/render.ts          Markdown prescription
src/server.ts, src/web web UI / API  (POST /api/process, /api/transcribe, /api/analyze, /api/match)
test/                  unit tests (npm test) + mock LLM server for offline testing
```

## Notes / limits
- The output is a **draft for the doctor to review**. Doses are only taken from what was said, and KB "typical usage" is shown as reference only.
- ASR doesn't label speakers. The LLM works out doctor vs patient from context, and a transcript with `Doctor:` / `Patient:` labels gives the best results.
- Whisper's Bengali accuracy is lower than its Hindi or English accuracy. Check the Bengali transcript in the UI before generating, and speak drug names clearly (they are usually said in English anyway).
- qwen3:8b understands Hindi well and Bengali reasonably. Keeping the English translation (`ASR_TRANSLATE=auto`) makes Bengali visits noticeably more reliable.
