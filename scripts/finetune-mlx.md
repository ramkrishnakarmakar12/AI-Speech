# Fine-tune the prescription LLM on your own approved prescriptions (Mac mini M4)

The app already improves without any training:

- the eye lexicon (`data/eye_lexicon.json`) decodes clinic phrases,
- the negation rules drop what the patient denied,
- every prescription you **Approve & save** in the web app becomes an example in the prompt.

After about **50–100 approved visits** you can go further with a LoRA fine-tune of Qwen3-4B-Instruct-2507. This bakes the doctor's style and the ophthalmology vocabulary into the model itself.

## 1. Export the training set

```bash
npm run export-training            # → data/training/train.jsonl + valid.jsonl
```

Each line has three parts:

- the system prompt,
- the transcript plus the decoded eye-clinic phrases,
- the doctor-approved prescription JSON.

## 2. Train (about 20–40 min on the M4 with 16 GB; close LM Studio first)

```bash
python3 -m pip install -U mlx-lm
python3 -m mlx_lm lora \
  --model Qwen/Qwen3-4B-Instruct-2507 \
  --train --data data/training \
  --fine-tune-type lora --num-layers 16 \
  --batch-size 1 --grad-checkpoint \
  --iters 600 --learning-rate 1e-5 \
  --max-seq-length 4096 \
  --adapter-path models/rx-lora
```

Watch the validation loss. If it starts going up while the training loss keeps falling, stop, because the model is memorising. Use fewer `--iters`.

## 3. Fuse and quantise to 8-bit

```bash
python3 -m mlx_lm fuse --model Qwen/Qwen3-4B-Instruct-2507 \
  --adapter-path models/rx-lora --save-path models/qwen3-4b-rx
python3 -m mlx_lm convert --hf-path models/qwen3-4b-rx -q --q-bits 8 \
  --mlx-path ~/.lmstudio/models/cheenta/qwen3-4b-rx-8bit
```

## 4. Use it

In LM Studio, load **qwen3-4b-rx-8bit**. Then set `LLM_MODEL=cheenta/qwen3-4b-rx-8bit` in `.env` (see `npm run check` for the exact id) and restart `npm run web`.

Compare it against the base model on the same recordings (`evaluation/`) before switching for good.

For production, upload the fused (non-quantised) `models/qwen3-4b-rx` folder to S3 and import it with Bedrock **Custom Model Import**. Then set `PROD_LLM_MODEL=<imported model ARN>` and `PROD_BEDROCK_API=invoke`.
