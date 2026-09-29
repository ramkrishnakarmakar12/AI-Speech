"""Manual gold-standard scoring of the 5 Drive outputs (qwen/qwen3-vl-4b + whisper-cli).
Labels: TP correct | PA right item, wrong/missing detail | FA lost by ASR (never in transcript)
        FL in transcript but missed by LLM | FP = hallucinated / wrong item in output."""
import json
G = {
 "p0 EN glaucoma (script0)": dict(items=list("T P T A T T P T T T A A A P A T P P T T P T T T T".replace(" ","")),
     fp=["Clinical finding 'visual field test' -> DIS-133 Homonymous hemianopia",
         "Clinical finding 'OCT-RNFL' -> ABR-041 (investigation listed as a finding)",
         "Ocular history 'visual acuity' (junk row)",
         "Procedures: visual field test (duplicate of investigation)",
         "Procedures: OCT-RNFL (duplicate of investigation)",
         "CMC strength 0.5% (never said)",
         "Warning: Timolol contraindicated in asthma - patient said 'asthma nahi hai' (negation ignored)"],
     med=(16,21), kb=(9,17)),
 "p1 EN dry eye (no script, vs transcript)": dict(items=list("TTTTTTPTPTTTTTPT"),
     fp=["Complaint 'sensitivity to light' (patient denied it) -> SYM-045 Sensitivity to wind/dust",
         "Finding 'no infection' -> ABR-061 (unrelated id)",
         "Advice '20-20-20 / blink' not in transcript (maybe in audio lost by ASR)"],
     med=(4,6), kb=(7,9)),
 "p2 BN presbyopia/dry eye (script1)": dict(items=list("AAAAATLAAAATAAAPAAPPTPT"),
     fp=["Diagnosis Thyroid eye disease (patient only has hypothyroid on thyroxine)",
         "Clinical finding Corneal opacity (from ASR garbage 'barfractase')",
         "Diagnosis Corneal opacity",
         "Medication Prednisolone acetate (hallucinated steroid)",
         "Medication Dexamethasone (hallucinated steroid)",
         "Exam 'IOP normal' (IOP never measured - 'prashar nei' = no BP)"],
     med=(0,0), kb=(1,5)),
 "p3 EN dry AMD (script5)": dict(items=list("TPAPPPTPTPTAAPTTTPPTTTFPA".replace("F","L")),
     fp=["Medication Dexamethasone intravitreal implant (from 'amstrad' = Amsler grid)",
         "Finding 'no cotton wool spots' coded as SGN-043 Cotton-wool spots (negation lost)",
         "Empty glasses row"],
     med=(1,2), kb=(12,18)),
 "p4 BN dry AMD (script4)": dict(items=list("A"*25),
     fp=["Patient name 'Dr. Babu'","History constipation","History nausea","History 'constipation in chest'"],
     med=(0,0), kb=(0,1)),
}
rows=[];tot=dict(g=0,T=0,P=0,A=0,L=0,fp=0)
for k,v in G.items():
    it=v["items"]; g=len(it); c={x:it.count(x) for x in "TPAL"}; fp=len(v["fp"])
    found=c["T"]+c["P"]
    prec=found/(found+fp) if found+fp else 0; rec=found/g; strict=c["T"]/g
    f1=2*prec*rec/(prec+rec) if prec+rec else 0
    rows.append((k,g,c["T"],c["P"],c["A"],c["L"],fp,prec,rec,strict,f1,v["med"],v["kb"]))
    for x in "TPAL": tot[x]+=c[x]
    tot["g"]+=g; tot["fp"]+=fp
print("| Output | Gold items | Correct | Partial | Lost in ASR | Missed by LLM | False +/halluc. | Precision | Recall | Strict accuracy | F1 | Med-field acc. | KB-id acc. |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    m=f"{r[11][0]}/{r[11][1]}" if r[11][1] else "n/a"
    print(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} | {r[6]} | {r[7]:.0%} | {r[8]:.0%} | {r[9]:.0%} | {r[10]:.2f} | {m} | {r[12][0]}/{r[12][1]} ({r[12][0]/r[12][1]:.0%}) |")
f=tot["T"]+tot["P"]; p=f/(f+tot["fp"]); r=f/tot["g"]
print(f"| **All 5** | {tot['g']} | {tot['T']} | {tot['P']} | {tot['A']} | {tot['L']} | {tot['fp']} | {p:.0%} | {r:.0%} | {tot['T']/tot['g']:.0%} | {2*p*r/(p+r):.2f} | | |")
