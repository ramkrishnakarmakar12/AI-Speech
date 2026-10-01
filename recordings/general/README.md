# General audio for transcription-accuracy tests

Put any recordings here (news, conversation, lecture, phone call …). For each one you can add the
exact correct text as a reference file with the same name:

    cricket_bn.m4a        ← audio
    cricket_bn.txt        ← what was really said (optional; enables measured WER/CER)

Then run, from the AI Speech folder:

    npm run general -- recordings/general --lang bn

Results go to evaluation/general/<date-time>/ :
  report.md    – one table for all files (WER, CER, coverage, LLM estimate, did the LLM correction help)
  results.csv  – same numbers for a spreadsheet
  <file>.md    – per recording: word diff, most frequent errors, LLM-found problems, raw + corrected text

Without a .txt reference you still get the Qwen3 estimate and the heuristic estimate.
Use one language per run (--lang bn / hi / en); don't rely on auto-detect for Bengali.
