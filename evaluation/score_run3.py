"""Three-way comparison: Whisper-large-v3 vs Vaani vs IndicConformer-600M.
Labels: T correct | P partial | A lost in ASR | L in the text given to the LLM but missed | fp = hallucinated/wrong."""
RUNS = [
 # script, engine, run, items, fp, kb
 ("Script 1 BN", "Whisper-large-v3",        "p2",  "AAAAATLAAAATAAAPAAPPTPT",   6, (1,5)),
 ("Script 1 BN", "Vaani-Bengali",           "p5",  "AAAAAPLAAAATLATPAAALLLL",   6, None),
 ("Script 1 BN", "IndicConformer (bn)",     "p12", "AAAAALLAAAALAAAAAALLLLL",   3, (1,4)),
 ("Script 4 BN", "Whisper-large-v3 (hi)",   "p4",  "A"*25,                      4, (0,1)),
 ("Script 4 BN", "Vaani-Hindi (hi)",        "p9",  "ALALLLLLAAAAAAAALLLLAAAAL", 6, (3,8)),
 ("Script 4 BN", "IndicConformer (hi)",     "p14", "LAAAAAAAAAAAAAAALALAAAAAA", 3, (0,2)),
 ("Script 5 EN", "Whisper-large-v3",        "p3",  "TPAPPPTPTPTAAPTTTPPTTTLPA", 3, (12,18)),
 ("Script 5 EN", "Whisper-large-v3",        "p8 = p13", "TAAAAAPPTTTLTPTTTPPTTTAAT", 5, (14,20)),
 ("EN dry eye",  "Whisper-large-v3",        "p1",  "TTTTTTPTPTTTTTPT",          3, (7,9)),
 ("EN dry eye",  "Whisper-large-v3",        "p10 = p15", "TTTTPTPLPTTTPTTPPPT",  3, (7,11)),
]
print("| Script | ASR engine | Output | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | F1 | KB-id |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for sc, eng, run, it, fp, kb in RUNS:
    c = {x: it.count(x) for x in "TPAL"}; g = len(it); f = c["T"] + c["P"]
    p = f / (f + fp) if f + fp else 0; r = f / g; f1 = 2*p*r/(p+r) if p+r else 0
    kbs = f"{kb[0]}/{kb[1]}" if kb else "n/a"
    print(f"| {sc} | {eng} | {run} | {g} | {c['T']} | {c['P']} | {c['A']} | {c['L']} | {fp} | {p:.0%} | {r:.0%} | {f1:.2f} | {kbs} |")
