"""Run 2 (ASR_BACKEND=indic) vs Run 1 (whisper-cli). Same labels as score.py:
T correct | P partial | A lost in ASR | L in transcript but missed by LLM | fp = hallucinated/wrong items."""
RUNS = {
 # ---- Run 1: whisper-large-v3 (whisper-cli) ----
 "p2  BN Script 1 · whisper-large-v3": dict(items="AAAAATLAAAATAAAPAAPPTPT", fp=6, med=None, kb=(1,5), asr="whisper"),
 "p4  BN Script 4 · whisper-large-v3 (detected hi)": dict(items="A"*25, fp=4, med=None, kb=(0,1), asr="whisper"),
 "p3  EN Script 5 · whisper-large-v3": dict(items="TPAPPPTPTPTAAPTTTPPTTTLPA", fp=3, med=(1,2), kb=(12,18), asr="whisper"),
 "p1  EN dry eye · whisper-large-v3": dict(items="TTTTTTPTPTTTTTPT", fp=3, med=(4,6), kb=(7,9), asr="whisper"),
 # ---- Run 2: ASR_BACKEND=indic ----
 "p5  BN Script 1 · Vaani-Bengali (whisper-medium)": dict(items="AAAAAPLAAAATLATPAAALLLL", fp=6, med=None, kb=None, asr="indic"),
 "p9  BN Script 4 · Vaani-Hindi (detected hi)": dict(items="ALALLLLLAAAAAAAALLLLAAAAL", fp=6, med=None, kb=(3,8), asr="indic"),
 "p11 BN Script 3 · whisper-large-v3 (detected pa)": dict(items="PAAAAAAAALAAAAAAAA", fp=2, med=None, kb=(0,4), asr="indic"),
 "p8  EN Script 5 · whisper-large-v3 (indic→en fallback)": dict(items="TAAAAAPPTTTLTPTTTPPTTTAAT", fp=5, med=(1,2), kb=(14,20), asr="indic"),
 "p10 EN dry eye · whisper-large-v3 (indic→en fallback)": dict(items="TTTTPTPLPTTTPTTPPPT", fp=3, med=(3,6), kb=(7,11), asr="indic"),
}
def stats(it, fp):
    c = {x: it.count(x) for x in "TPAL"}; g = len(it); f = c["T"] + c["P"]
    p = f / (f + fp) if f + fp else 0; r = f / g
    return c, g, p, r, c["T"] / g, (2 * p * r / (p + r) if p + r else 0)
print("| Run | Gold | Correct | Partial | Lost in ASR | Missed by LLM | FP | Precision | Recall | Strict acc. | F1 | Med-field | KB-id |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for k, v in RUNS.items():
    it = v["items"].replace(" ", ""); c, g, p, r, s, f1 = stats(it, v["fp"])
    med = f"{v['med'][0]}/{v['med'][1]}" if v["med"] else "n/a"
    kb = f"{v['kb'][0]}/{v['kb'][1]}" if v["kb"] else "n/a (empty)"
    print(f"| {k} | {g} | {c['T']} | {c['P']} | {c['A']} | {c['L']} | {v['fp']} | {p:.0%} | {r:.0%} | {s:.0%} | {f1:.2f} | {med} | {kb} |")
