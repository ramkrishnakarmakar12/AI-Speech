# AI Speech → Ophthalmology Prescription (local)

Doctor–patient conversation audio (and/or transcript) → recognised ophthalmic terminology → structured prescription draft, grounded in the **Ophthalmology Vocabulary** workbook. Everything runs on your Mac; no cloud calls.

```
audio ──► Whisper large-v3 (en/hi/bn + English translation) ──► transcript ─┐         (a transcript you supply skips ASR)
             ▲ vocabulary prompt from KB                 ▼
xlsx ──► build-kb ──► data/kb.json ──► matcher: KB terms heard (exact · brand→generic · Hindi/Bengali · fuzzy ASR typos)
                                              ▼
                        LLM in Ollama / LM Studio (JSON-schema constrained) ──► grounding against KB ids
                                              ▼
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

## 3. Output format (for building the prescription)

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
| `detectedTerms[]` | raw matcher hits with scores |

Every `kb_id` is the sheet's ID column (DIS-001, MED-014…), so it can map straight to HMS master tables.

## 4. How the sheet is used ("formatting the data")
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

## 5. Project layout
```
src/kb/build-kb.ts     xlsx → kb.json, hotwords
src/match/matcher.ts   lexical/fuzzy term detection (+ translit.ts: Devanagari/Bengali → Roman)
src/asr/index.ts       ASR backends (+ indic_asr.py, qwen3_asr.py helpers)
src/llm/               schema, prompt, Ollama/LM Studio client
src/pipeline.ts        orchestration + KB grounding + safety checks
src/render.ts          Markdown prescription
src/server.ts, src/web web UI / API  (POST /api/process, /api/transcribe, /api/match)
test/                  unit tests (npm test) + mock LLM server for offline testing
```

## Notes / limits
- The output is a **draft for the doctor to review**. Doses are only taken from what was said, and KB "typical usage" is shown as reference only.
- ASR doesn't label speakers. The LLM works out doctor vs patient from context, and a transcript with `Doctor:` / `Patient:` labels gives the best results.
- Whisper's Bengali accuracy is lower than its Hindi or English accuracy. Check the Bengali transcript in the UI before generating, and speak drug names clearly (they are usually said in English anyway).
- qwen3:8b understands Hindi well and Bengali reasonably. Keeping the English translation (`ASR_TRANSLATE=auto`) makes Bengali visits noticeably more reliable.
