"""Bengali-only comparison of the three ASR models (LLM = qwen/qwen3-vl-4b throughout).
Labels: T correct | P partial | A lost in ASR | L in the text given to the LLM but missed | fp = hallucinated/wrong."""
RUNS = [
 ("Script 1", "Whisper-large-v3",               "p2",  "AAAAATLAAAATAAAPAAPPTPT",   6, (1,5),  "n/a"),
 ("Script 1", "Vaani-Bengali",                  "p5",  "AAAAAPLAAAATLATPAAALLLL",   6, None,   "n/a (steroid invented)"),
 ("Script 1", "IndicConformer, 30 s pieces",    "p12", "AAAAALLAAAALAAAAAALLLLL",   3, (1,4),  "n/a"),
 ("Script 1", "IndicConformer, 15 s pieces",    "p16", "ATTALPLLLTPTLTTPPPPPTPT",   8, (6,10), "3/6"),
 ("Script 4", "Whisper-large-v3 (as hi)",       "p4",  "A"*25,                      4, (0,1),  "n/a"),
 ("Script 4", "Vaani-Hindi (as hi)",            "p9",  "ALALLLLLAAAAAAAALLLLAAAAL", 6, (3,8),  "n/a"),
 ("Script 4", "IndicConformer (as hi)",         "p14", "LAAAAAAAAAAAAAAALALAAAAAA", 3, (0,2),  "n/a"),
 ("Script 4", "IndicConformer, 15 s, bn",       "p17", "TPLPPPPLALLAAAALLLLLALLAL", 2, (0,6),  "n/a"),
 ("Script 3", "Whisper-large-v3 (as pa)",       "p11", "PAAAAAAAALAAAAAAAA",        2, (0,4),  "n/a"),
 ("Script 3", "IndicConformer, 15 s, bn",       "p18", "PLPLLALLPLLLLLLLLL",        2, (1,2),  "n/a"),
]
print("| Script | ASR | Output | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | F1 | KB-id | Med fields |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
tot = {}
for sc, eng, run, it, fp, kb, med in RUNS:
    c = {x: it.count(x) for x in "TPAL"}; g = len(it); f = c["T"] + c["P"]
    p = f / (f + fp) if f + fp else 0; r = f / g; f1 = 2*p*r/(p+r) if p+r else 0
    print(f"| {sc} | {eng} | {run} | {g} | {c['T']} | {c['P']} | {c['A']} | {c['L']} | {fp} | {p:.0%} | {r:.0%} | {f1:.2f} | {f'{kb[0]}/{kb[1]}' if kb else 'n/a'} | {med} |")
