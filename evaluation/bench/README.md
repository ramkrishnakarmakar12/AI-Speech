# Readiness bench

Runs every conversation in `cases.json` several times through the real pipeline (the model and settings in `.env`),
scores each prescription against the facts that were said, and writes `out/<date-time>/`:

- `report.md` — verdict against the pilot gates, per-conversation recall per run, critical facts (numbers, medicines,
  eye sides), consistency across runs, forbidden items (denied conditions, unsaid drugs), what was missed.
- `doctor_review.xlsx` — every prescription line with the automatic check and a Correct / Minor fix / Wrong column for
  the doctor, plus a "Missed facts" sheet and the summary.
- `results.json` — everything, including each full prescription.

```
npm run bench                          # 13 conversations × 3 runs
npm run bench -- --group unseen        # only the 6 conversations no rule was written for (s6–s11)
npm run bench -- --runs 5 --label bedrock-32b
MODEL_ENV=production npm run bench     # the production model (Bedrock), same as rx-lef
```

Groups: **unseen** (s6–s11, written for lef, never used to tune AI Speech) · **earlier-eval** (scripts 0, 1, 3, 4, 5 from
earlier rounds) · **tuned** (the two 9 Oct ASR transcripts the latest fixes were written against).

Add a conversation: put the transcript in `cases/`, add its facts to `build_cases.py`, run `python3 build_cases.py`.
Add `audio="path"` to a case and run with `--audio` to include speech recognition.

## Running against the production model (Bedrock) from a Mac

`MODEL_ENV=production` reads `PROD_<NAME>` settings first. Add these to `.env` (the server sets the same values):

```
PROD_LLM_PROVIDER=bedrock
PROD_LLM_MODEL=qwen.qwen3-32b-v1:0
PROD_AWS_REGION=ap-south-1
```

and give the shell AWS credentials allowed to call `bedrock:InvokeModel` on that model (`export AWS_PROFILE=…`, or
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Then: `MODEL_ENV=production npm run bench -- --label bedrock-32b`.

If the model cannot be reached (LM Studio not running, no AWS credentials) the bench stops after the first failure.
