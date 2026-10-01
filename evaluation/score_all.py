"""Master scoring of every evaluated output (prescriptions 0-22).
Labels per gold fact: T correct | P partial | A lost in ASR | L in the LLM's input but missed.
fp = hallucinated / wrong items. Duplicate outputs (byte-identical re-runs) are listed once."""
R = [
 # id, round, lang, script, ASR, LLM, items, fp, llm_s
 ("p0",  1, "EN", "Glaucoma",        "Whisper-large-v3", "qwen3-vl-4b",  "TPTATTPTTTAAAPATPPTTPTTTT", 7, 80),
 ("p1",  1, "EN", "Dry eye",         "Whisper-large-v3", "qwen3-vl-4b",  "TTTTTTPTPTTTTTPT",          3, 84),
 ("p3",  1, "EN", "Script 5 AMD",    "Whisper-large-v3", "qwen3-vl-4b",  "TPAPPPTPTPTAAPTTTPPTTTLPA", 3, 80),
 ("p2",  1, "BN", "Script 1",        "Whisper-large-v3", "qwen3-vl-4b",  "AAAAATLAAAATAAAPAAPPTPT",   6, 55),
 ("p4",  1, "BN", "Script 4",        "Whisper-large-v3 (hi)", "qwen3-vl-4b", "A"*25,                  4, 23),
 ("p5",  2, "BN", "Script 1",        "Vaani-Bengali",    "qwen3-vl-4b",  "AAAAAPLAAAATLATPAAALLLL",   6, 46),
 ("p9",  2, "BN", "Script 4",        "Vaani-Hindi (hi)", "qwen3-vl-4b",  "ALALLLLLAAAAAAAALLLLAAAAL", 6, 42),
 ("p11", 2, "BN", "Script 3",        "Whisper-large-v3 (pa)", "qwen3-vl-4b", "PAAAAAAAALAAAAAAAA",    2, 14),
 ("p8",  2, "EN", "Script 5 AMD",    "Whisper-large-v3", "qwen3-vl-4b",  "TAAAAAPPTTTLTPTTTPPTTTAAT", 5, 88),
 ("p10", 2, "EN", "Dry eye",         "Whisper-large-v3", "qwen3-vl-4b",  "TTTTPTPLPTTTPTTPPPT",       3, 67),
 ("p12", 3, "BN", "Script 1",        "IndicConformer 30 s", "qwen3-vl-4b", "AAAAALLAAAALAAAAAALLLLL", 3, 25),
 ("p14", 3, "BN", "Script 4",        "IndicConformer (hi)", "qwen3-vl-4b", "LAAAAAAAAAAAAAAALALAAAAAA", 3, 14),
 ("p16", 4, "BN", "Script 1",        "IndicConformer 15 s", "qwen3-vl-4b", "ATTALPLLLTPTLTTPPPPPTPT", 8, 97),
 ("p17", 4, "BN", "Script 4",        "IndicConformer 15 s", "qwen3-vl-4b", "TPLPPPPLALLAAAALLLLLALLAL", 2, 48),
 ("p18", 4, "BN", "Script 3",        "IndicConformer 15 s", "qwen3-vl-4b", "PLPLLALLPLLLLLLLLL",      2, 36),
 ("p20", 5, "BN", "Script 1",        "IndicConformer 15 s", "Qwen3-4B-Instruct-2507 8-bit", "APPATPLLLTLTLLTPPPPLTTT", 4, 286),
 ("p21", 5, "BN", "Script 4",        "IndicConformer 15 s", "Qwen3-4B-Instruct-2507 8-bit", "TLPLLPPTALLAAAALPLPLAPLAT", 11, 186),
]
DUPES = {"p13": "p8", "p15": "p10", "p19": "p16", "p22": "p20"}
def st(it, fp):
    c = {x: it.count(x) for x in "TPAL"}; g = len(it); f = c["T"] + c["P"]
    p = f/(f+fp) if f+fp else 0; r = f/g
    return c, g, f, p, r, (2*p*r/(p+r) if p+r else 0)
print("| Output | Round | Lang | Script | ASR | LLM | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | F1 | LLM time |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for pid, rd, lang, sc, asr, llm, it, fp, s in R:
    c, g, f, p, r, f1 = st(it, fp)
    dup = [k for k, v in DUPES.items() if v == pid]
    name = pid + (f" (= {', '.join(dup)})" if dup else "")
    print(f"| {name} | {rd} | {lang} | {sc} | {asr} | {llm} | {g} | {c['T']} | {c['P']} | {c['A']} | {c['L']} | {fp} | {p:.0%} | {r:.0%} | {f1:.2f} | {s} s |")
def agg(ids):
    G=F=FP=A=L=0
    for pid, *_ , it, fp, s in R:
        if pid in ids:
            c, g, f, p, r, f1 = st(it, fp); G+=g; F+=f; FP+=fp; A+=c["A"]; L+=c["L"]
    p=F/(F+FP); r=F/G
    return f"gold {G} · found {F} · FP {FP} · lost-ASR {A} · missed-LLM {L} · precision {p:.0%} · recall {r:.0%} · F1 {2*p*r/(p+r):.2f}"
print()
for label, ids in [("EN, Whisper + VL-4B (p0,p1,p3)", {"p0","p1","p3"}), ("EN, Whisper + VL-4B (p8,p10)", {"p8","p10"}),
                   ("BN, Whisper (p2,p4,p11)", {"p2","p4","p11"}), ("BN, Vaani (p5,p9)", {"p5","p9"}),
                   ("BN, Conformer 15 s + VL-4B (p16,p17,p18)", {"p16","p17","p18"}),
                   ("BN, Conformer 15 s + VL-4B, Scripts 1+4 only (p16,p17)", {"p16","p17"}),
                   ("BN, Conformer 15 s + Instruct-2507 (p20,p21)", {"p20","p21"})]:
    print(f"- {label}: {agg(ids)}")
