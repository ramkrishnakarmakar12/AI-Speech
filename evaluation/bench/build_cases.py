"""Builds cases.json — the expected facts for each bench conversation. Edit here, then run: python3 build_cases.py
Fact: every regex in `all` must match ONE row of one of the sections in `in` (rows carry the eye as [RE]/[LE]/[BE]).
`eye` adds that eye to the row match (BE also accepts an RE row and an LE row that both match).
`critical` = a number, medicine or eye side: a miss here matters more (reported separately).
Forbid: `pattern` must not match any row of the sections in `in` (a denied condition, a drug never said …)."""
import json
C = []
def F(label, sections, *pats, eye=None, critical=False):
    d = {"label": label, "in": sections.split(","), "all": list(pats)}
    if eye: d["eye"] = eye
    if critical: d["critical"] = True
    return d
def X(label, sections, pattern): return {"label": label, "in": sections.split(","), "pattern": pattern}
def case(id, lang, file, group, facts, forbid=(), audio=None):
    c = {"id": id, "lang": lang, "file": file, "group": group, "facts": facts, "forbid": list(forbid)}
    if audio: c["audio"] = audio
    C.append(c)
CH = "complaints,history"
QID = "qid|four|4\\s*(x|times|/)|\\b4\\b"
BD = "bd|bid|twice|2\\s*(x|times|/)|\\b2\\b"
IOPW = "pressure|iop|tonometr"
FU = "follow_up"
MO = lambda n, unit: rf"\b({n})\b.*{unit}|{unit}.*\b({n})\b"

case("s0_en_glaucoma", "en", "evaluation/bench/cases/script0_en_glaucoma.txt", "earlier-eval", [
  F("Name Sunil Das", "patient", "sunil"), F("Age 58", "patient", r"\b58\b", critical=True),
  F("Heaviness LE, 3 months", "complaints", "heav", eye="LE"), F("Coloured haloes", "complaints", "halo|rainbow|colou?red ring"),
  F("Eye pain", "complaints", "pain"), F("Evening headache", "complaints", "headache"),
  F("Hypertension 5 yrs", "history", "hypertens|blood pressure|\\bbp\\b"), F("On amlodipine", "history", "amlodipine"),
  F("Family: mother glaucoma", "history", "glaucoma", "mother"),
  F("VA RE 6/9", "exam", "6/9", eye="RE", critical=True), F("VA LE 6/12", "exam", "6/12", eye="LE", critical=True),
  F("IOP RE 18", "exam", IOPW, r"\b18\b", eye="RE", critical=True), F("IOP LE 28", "exam", IOPW, r"\b28\b", eye="LE", critical=True),
  F("AC normal depth", "exam", "anterior chamber|\\bac\\b"),
  F("CDR RE 0.4", "exam", r"0\.4", eye="RE", critical=True), F("CDR LE 0.7", "exam", r"0\.7", eye="LE", critical=True),
  F("Dx POAG LE", "diagnosis", "open.?angle|poag", eye="LE"), F("Dx glaucoma suspect RE", "diagnosis", "suspect", eye="RE"),
  F("Latanoprost LE at bedtime", "medications", "latanoprost", "hs|bedtime|night|once", eye="LE", critical=True),
  F("Timolol LE twice daily", "medications", "timolol", BD, eye="LE", critical=True),
  F("CMC BE 4x/day, 1 month", "medications", "carboxymethyl|\\bcmc\\b", QID, eye="BE", critical=True),
  F("Visual field test", "investigations", "field|hfa|perimetr"), F("OCT RNFL", "investigations", "oct|rnfl"),
  F("Press inner corner after drops", "advice,medications", "press|punctal|inner corner|nasolacrimal"),
  F("5-minute gap between drops", "advice,medications", "(5|five).?min|gap"),
  F("Drops lifelong / don't stop", "advice", "lifelong|life.?long|don.?t stop|do not stop"),
  F("Children to get checked", "advice", "children|family|sibling"),
  F("Follow-up 1 month", FU, MO("1|one", "month"), critical=True),
], [X("Denied diabetes/asthma", "history", "diabet|asthma"), X("Drug never said", "medications", "pilocarpine|brimonidine|dorzolamide|prednisol|moxiflox")])

case("s1_bn_presbyopia_dryeye", "bn", "evaluation/bench/cases/script1_bn_presbyopia_dryeye.txt", "earlier-eval", [
  F("Name Sharmistha Basu", "patient", "shar|শর্মিষ্ঠা|sarm"), F("Age 48", "patient", r"\b48\b", critical=True),
  F("Near vision difficulty, 6 months", "complaints", "near|presbyop|reading|diminution|dov"),
  F("Dryness BE", "complaints", "dry"), F("Burning", "complaints", "burn"), F("Foreign body / sand", "complaints", "foreign|sand|gritt"),
  F("Morning lid crusting", "complaints,exam", "crust|dandruff|flak|scal"),
  F("Computer work all day", "complaints,history", "computer|screen"),
  F("Thyroid", "history", "thyro"), F("On thyroxine", "history", "thyroxin|eltroxin"),
  F("Distance VA 6/6 BE", "exam", "6/6", eye="BE", critical=True), F("Near VA N18", "exam", r"n\s?18", critical=True),
  F("N6 with +1.50 add", "exam,glasses", r"n\s?6\b|1\.5"), F("TBUT 5 s", "exam", "tbut|break.?up", r"\b5\b", critical=True),
  F("Schirmer 10 mm", "exam", "schirmer", r"\b10\b", critical=True), F("Meibomian gland plugging", "exam", "meibomian|mgd"),
  F("Blepharitis", "exam,diagnosis", "blephar"),
  F("Dx presbyopia", "diagnosis", "presbyop"), F("Dx dry eye", "diagnosis", "dry eye|kcs|tear film"), F("Dx MGD", "diagnosis", "meibomian|mgd"),
  F("Reading add +1.50", "glasses,advice", r"1\.5"), F("Progressive lens", "glasses,advice", "progressive"), F("Anti-reflective coating", "glasses,advice", "anti.?reflect|\\barc\\b"),
  F("CMC BE 4x/day 3 months", "medications", "carboxymethyl|\\bcmc\\b", QID, eye="BE", critical=True),
  F("Gel at bedtime", "medications", "gel", "hs|night|bed"),
  F("Warm compress twice daily", "advice", "warm|hot"), F("Lid hygiene", "advice", "lid|eyelid"),
  F("20-20-20 rule", "advice", "20"), F("Blink often", "advice", "blink"),
  F("Follow-up 1.5 months", FU, r"1\.5|one and a half|6 weeks|six weeks", critical=True),
], [X("Denied sugar/pressure", "history", "diabet|hypertens")])

case("s3_bn_corneal_ulcer", "bn", "evaluation/bench/cases/script3_bn_corneal_ulcer.txt", "earlier-eval", [
  F("Name Gopal Mondal", "patient", "gopal"), F("Age 45", "patient", r"\b45\b", critical=True),
  F("Redness RE", "complaints", "red", eye="RE"), F("Pain", "complaints", "pain"), F("Watering", "complaints", "water|lacrimat|epiphora|tear"),
  F("Photophobia", "complaints", "photophob|light"), F("Paddy-leaf injury 4 days ago", "complaints,history", "leaf|paddy|trauma|injur"),
  F("Self-bought drop from a shop", "complaints,history,advice,medications", "shop|chemist|over.?the.?counter|self|unknown"),
  F("Diabetes 10 yrs", "history", "diabet|sugar"), F("On metformin", "history", "metformin"),
  F("VA RE 6/60", "exam", "6/60", eye="RE", critical=True), F("VA LE 6/9", "exam", "6/9", eye="LE", critical=True),
  F("Corneal ulcer RE", "exam", "ulcer", eye="RE"), F("Hypopyon", "exam", "hypopyon"),
  F("Dx corneal ulcer / fungal keratitis RE", "diagnosis", "fungal|kerat|ulcer", eye="RE"),
  F("Corneal scraping", "investigations,procedures", "scrap"), F("Smear", "investigations", "smear|koh|gram"), F("Culture", "investigations", "culture"),
  F("Blood sugar test", "investigations", "sugar|glucose|fbs|rbs|hba1c"),
  F("Natamycin 5% RE hourly", "medications", "natamycin", "hour|q1h|\\b1 ?h", eye="RE", critical=True),
  F("Moxifloxacin RE 4x/day", "medications", "moxi", QID, eye="RE", critical=True),
  F("Atropine 1% RE twice daily", "medications", "atropin", BD, eye="RE", critical=True),
  F("Stop the shop drop", "advice", "stop|discontinue"), F("Don't rub", "advice", "rub"), F("No water in the eye", "advice", "water"),
  F("Dark glasses", "advice", "dark|sun|black|goggle"), F("Control sugar", "advice", "sugar|glucose|diabet"),
  F("Follow-up 2 days", FU, MO("2|two", "day"), critical=True),
], [X("Steroid prescribed", "medications", "prednisol|dexameth|steroid|fluorometh")])

AMD_FACTS = lambda: [
  F("Metamorphopsia LE, 1 month", "complaints", "metamorph|distort|wavy|crooked"), F("Blurred vision LE", "complaints", "blur|diminution|dov|hazy"),
  F("Asthenopia / eye strain", "complaints", "asthenop|strain|fatigue|tired"), F("Photophobia", "complaints", "photophob|light"),
  F("Photopsia (flashes)", "complaints", "photops|flash"), F("Floaters", "complaints", "floater|speck|spot"),
  F("Anterior segment normal", "exam", "normal|unremarkable|clear"), F("Drusen", "exam", "drusen"),
  F("Geographic RPE atrophy", "exam", "geographic|atroph"), F("Mild macular oedema", "exam", "o?edema"),
  F("OCT: no CNV / fluid", "exam,investigations", "cnv|neovascular|fluid|ellipsoid"), F("FFA window defects", "exam,investigations", "window"),
  F("Dx dry AMD", "diagnosis", "amd|macular degeneration", "dry|non.?exudative|atroph"),
  F("AREDS2 supplement", "medications,advice", "areds", critical=True), F("Amsler grid home monitoring", "advice,investigations,procedures", "amsler"),
  F("Repeat OCT", "investigations,follow_up", "oct|coherence"), F("Wide-field fundus photo", "investigations,follow_up", "photo"),
  F("Follow-up 3 months", FU, MO("3|three", "month"), critical=True),
]
AMD_FORBID = [X("Anti-VEGF drug although 'not indicated'", "medications,procedures", "ranibizumab|aflibercept|bevacizumab|vegf|intravitreal"),
              X("PDT given now (only if it turns wet)", "procedures", "photodynamic|\\bpdt\\b"), X("Diabetic retinopathy diagnosed", "diagnosis", "diabetic")]
case("s4_bn_dry_amd", "bn", "evaluation/bench/cases/script4_bn_dry_amd.txt", "earlier-eval", AMD_FACTS(), AMD_FORBID)
case("s5_en_dry_amd", "en", "evaluation/bench/cases/script5_en_dry_amd.txt", "earlier-eval", AMD_FACTS(), AMD_FORBID)

case("s6_en_glaucoma", "en", "evaluation/bench/cases/s6_en_glaucoma.txt", "unseen", [
  F("Hazy vision RE, 3 months", "complaints", "hazy|blur|diminution|dov|decreas", eye="RE"), F("Evening headache", "complaints", "headache"),
  F("Hypertension 5 yrs", "history", "hypertens|\\bbp\\b|blood pressure"), F("On amlodipine", "history", "amlodipine"),
  F("Family: father glaucoma", "history", "glaucoma", "father"), F("Allergy: sulfa", "history", "sulfa|sulpha", critical=True),
  F("VA RE 6/12", "exam", "6/12", eye="RE", critical=True), F("VA LE 6/6", "exam", "6/6(?!\\d)", eye="LE", critical=True),
  F("IOP RE 24", "exam", IOPW, r"\b24\b", eye="RE", critical=True), F("IOP LE 18", "exam", IOPW, r"\b18\b", eye="LE", critical=True),
  F("IOP by NCT", "exam", "nct"), F("IOP at 10:30", "exam", "10[:.]30"),
  F("Fundus RE CDR 0.7 + rim thinning", "exam", r"0\.7", eye="RE", critical=True), F("Fundus LE CDR 0.4", "exam", r"0\.4", eye="LE", critical=True),
  F("Deep AC", "exam", "deep"), F("Dx POAG RE", "diagnosis", "open.?angle|poag", eye="RE"),
  F("OCT RNFL", "investigations", "oct|rnfl"), F("Visual field", "investigations", "field|perimetr|hfa"),
  F("Timolol RE twice daily", "medications", "timolol", BD, eye="RE", critical=True),
  F("Drops same time / don't stop", "advice", "same time|regular|don.?t stop|do not stop"), F("Follow-up 6 weeks", FU, MO("6|six", "week"), critical=True),
], [X("Denied diabetes/asthma", "history", "diabet|asthma")])

case("s7_en_cataract", "en", "evaluation/bench/cases/s7_en_cataract.txt", "unseen", [
  F("Dim vision LE ~1 year", "complaints", "dim|blur|diminution|dov|decreas|reduced", eye="LE"), F("Night glare", "complaints", "glare"),
  F("Past: RE cataract surgery 2 yrs ago", "history", "cataract|surgery|operat|iol|phaco", eye="RE"),
  F("Diabetes 10 yrs", "history", "diabet|sugar"), F("On metformin", "history", "metformin"),
  F("VA RE 6/9", "exam", "6/9", eye="RE", critical=True), F("VA LE 6/36", "exam", "6/36", eye="LE", critical=True),
  F("Slit lamp RE: PCIOL", "exam", "iol|pseudophak", eye="RE"), F("Slit lamp LE: NS grade 3", "exam", "nuclear|\\bns", "3|iii|three", eye="LE"),
  F("Fundus normal BE", "exam", "fundus|retina", "normal", eye="BE"),
  F("IOP by applanation", "exam", "applanation|\\bat\\b|goldmann"), F("IOP RE 14", "exam", IOPW, r"\b14\b", eye="RE", critical=True), F("IOP LE 16", "exam", IOPW, r"\b16\b", eye="LE", critical=True),
  F("Dx senile cataract LE", "diagnosis", "cataract", eye="LE"), F("Phaco + IOL LE", "procedures", "phaco", eye="LE"),
  F("Biometry", "investigations", "biometr|a.?scan"), F("Fasting blood sugar", "investigations", "sugar|fbs|glucose"),
  F("Control sugar before surgery", "advice", "sugar|glucose|diabet"), F("Follow-up 1 week", FU, MO("1|one", "week"), critical=True),
], [X("Denied hypertension", "history", "hypertens|blood pressure"), X("Unsaid cataract sub-type", "diagnosis", "subcapsular|cortical")])

case("s8_bn_allergic_conjunctivitis", "bn", "evaluation/bench/cases/s8_bn_allergic_conjunctivitis.txt", "unseen", [
  F("Itching BE, 1 week", "complaints", "itch|prurit"), F("Redness", "complaints", "red"), F("Watering", "complaints", "water|lacrimat|epiphora|tear"),
  F("Asthma since childhood", "history", "asthma"), F("No drug allergy", "history", "no known|nkda|none|nil|no drug allerg"),
  F("VA 6/6 BE", "exam", "6/6(?!\\d)", eye="BE", critical=True), F("Conjunctival congestion", "exam", "congest|red|hyperaem|hyperem|inject"),
  F("Papillae", "exam", "papill"), F("Cornea clear", "exam", "cornea.*clear|clear.*cornea"),
  F("Dx allergic conjunctivitis", "diagnosis", "allergic conjunctivitis|vkc|vernal"),
  F("Olopatadine BE twice daily", "medications", "olopatadine", BD, critical=True),
  F("Don't rub", "advice", "rub"), F("Cold compress", "advice", "cold"), F("Follow-up 2 weeks", FU, MO("2|two", "week"), critical=True),
], [X("Denied sugar/pressure", "history", "diabet|hypertens"), X("Symptom as diagnosis", "diagnosis", "itch|redness|watering")])

DR = lambda: [
  F("Blurred vision RE, 2 months", "complaints", "blur|hazy|diminution|dov|decreas", eye="RE"),
  F("Diabetes 12 yrs", "history", "diabet|sugar"), F("Hypertension", "history", "hypertens|blood pressure|\\bbp\\b"),
  F("Past laser LE", "history", "laser", eye="LE"),
  F("VA RE 6/18", "exam", "6/18", eye="RE", critical=True), F("VA LE 6/12", "exam", "6/12", eye="LE", critical=True),
  F("IOP by NCT", "exam", "nct"), F("IOP RE 16", "exam", IOPW, r"\b16\b", eye="RE", critical=True), F("IOP LE 18", "exam", IOPW, r"\b18\b", eye="LE", critical=True),
  F("IOP at 11 am", "exam", r"\b11\b"),
  F("Fundus RE haemorrhages", "exam", "h(a)?emorrh", eye="RE"), F("Fundus RE hard exudates", "exam", "exudat", eye="RE"), F("Fundus RE macular oedema", "exam", "o?edema|cme|csme|dme", eye="RE"),
  F("Fundus LE mild NPDR", "exam", "npdr|non.?proliferative", eye="LE"),
  F("Dx moderate NPDR RE", "diagnosis", "npdr|diabetic retinopathy|non.?proliferative", eye="RE"), F("Dx CSME RE", "diagnosis", "csme|macular o?edema|dme", eye="RE"),
  F("OCT macula", "investigations", "oct|coherence"), F("FFA", "investigations", "ffa|angiograph"),
  F("Anti-VEGF injection RE", "procedures", "vegf|intravitreal|injection", eye="RE", critical=True),
  F("Control sugar & BP", "advice", "sugar|glucose|diabet|pressure"), F("Follow-up 1 month", FU, MO("1|one", "month"), critical=True),
]
DR_FORBID = [X("Denied thyroid", "history", "thyro"), X("Allergy never discussed", "history", "allerg"), X("Past laser as today's procedure", "procedures", "laser")]
case("s9_bn_diabetic_retinopathy", "bn", "evaluation/bench/cases/s9_bn_diabetic_retinopathy.txt", "unseen", DR(), DR_FORBID)

case("s10_hi_pterygium", "hi", "evaluation/bench/cases/s10_hi_pterygium.txt", "unseen", [
  F("Redness RE, 2 yrs", "complaints", "red", eye="RE"), F("Burning", "complaints", "burn|irritat"), F("Growth on the eye", "complaints", "growth|mass|grow|flesh|pterygium"),
  F("Hypertension", "history", "hypertens|blood pressure|\\bbp\\b"), F("No previous eye surgery (said)", "history", "no|never|nil"),
  F("VA 6/6 BE", "exam", "6/6(?!\\d)", eye="BE", critical=True), F("Nasal pterygium RE, 2 mm on cornea", "exam", "pterygium", r"\b2\b", eye="RE"),
  F("IOP by NCT", "exam", "nct"), F("IOP RE 14", "exam", IOPW, r"\b14\b", eye="RE", critical=True), F("IOP LE 15", "exam", IOPW, r"\b15\b", eye="LE", critical=True),
  F("Dx pterygium RE", "diagnosis", "pterygium", eye="RE"), F("Excision + conjunctival autograft RE", "procedures", "excision|autograft"),
  F("Lubricant drops 4x/day", "medications", "lubric|carboxymethyl|cmc|tear", QID, critical=True),
  F("Sunglasses", "advice", "sunglass|dark glass|goggle|black glass|dark spectacle"), F("Avoid dust", "advice", "dust"),
  F("Follow-up 1 month", FU, MO("1|one", "month"), critical=True),
], [X("Denied diabetes", "history", "diabet|sugar"), X("Symptom as diagnosis", "diagnosis", "burning|redness")])

case("s11_hi_corneal_ulcer", "hi", "evaluation/bench/cases/s11_hi_corneal_ulcer.txt", "unseen", [
  F("Pain LE, 4 days", "complaints", "pain", eye="LE"), F("Redness", "complaints", "red"), F("Watering", "complaints", "water|lacrimat|epiphora|tear"),
  F("Photophobia", "complaints", "photophob|light"), F("Leaf injury", "complaints,history", "leaf|injur|trauma"),
  F("Diabetes 5 yrs", "history", "diabet|sugar"),
  F("VA LE 6/60", "exam", "6/60", eye="LE", critical=True), F("VA RE 6/6", "exam", "6/6(?!\\d)", eye="RE", critical=True),
  F("Central corneal ulcer LE, 3 mm", "exam", "ulcer", r"\b3\b", eye="LE"), F("Hypopyon LE", "exam", "hypopyon"),
  F("Dx fungal keratitis LE", "diagnosis", "fungal|keratomycosis", eye="LE"),
  F("Corneal scraping", "investigations,procedures", "scrap"), F("KOH mount", "investigations", "koh"), F("Culture", "investigations", "culture"),
  F("Natamycin LE hourly", "medications", "natamycin", "hour|q1h|\\b1 ?h", eye="LE", critical=True),
  F("Don't rub", "advice", "rub"), F("No self-medicated steroid", "advice", "steroid"),
  F("Follow-up 2 days", FU, MO("2|two", "day"), critical=True),
], [X("Steroid prescribed", "medications", "prednisol|dexameth|steroid|fluorometh")])

case("asr_bn_glaucoma_cataract", "bn", "evaluation/bench/cases/asr_bn_glaucoma_cataract.txt", "tuned", [
  F("Blurred vision LE, 6 months", "complaints", "blur|hazy|diminution|dov", eye="LE"), F("Coloured haloes", "complaints", "halo|rainbow"),
  F("Hypertension 5 yrs", "history", "hypertens|\\bbp\\b|blood pressure"), F("On amlodipine", "history", "amlodipin"),
  F("Family: mother glaucoma", "history", "glaucoma", "mother"),
  F("VA RE 6/9", "exam", "6/9", eye="RE", critical=True), F("VA LE 6/18", "exam", "6/18", eye="LE", critical=True),
  F("IOP RE 16", "exam", IOPW, r"\b16\b", eye="RE", critical=True), F("IOP LE 26", "exam", IOPW, r"\b26\b", eye="LE", critical=True),
  F("Cornea clear BE", "exam", "cornea"), F("Early cataract LE (slit lamp)", "exam", "cataract|lens|opacit", eye="LE"),
  F("CDR RE 0.4", "exam", r"0\.4", eye="RE", critical=True), F("CDR LE 0.7", "exam", r"0\.7", eye="LE", critical=True),
  F("Dx glaucoma LE", "diagnosis", "glaucoma", eye="LE"), F("Dx early cataract LE", "diagnosis", "cataract", eye="LE"),
  F("Field test", "investigations", "field|perimetr|hfa"), F("OCT", "investigations", "oct|coherence"),
  F("Use mobile less", "advice", "mobile|screen|phone"), F("Don't stop drops", "advice", "stop"),
  F("Follow-up 1 month", FU, MO("1|one", "month"), critical=True), F("Recheck pressure next visit", FU + ",advice", "pressure|প্রেশার"),
], [X("Denied diabetes", "history", "diabet"), X("Unsaid IOP method", "exam", "\\bnct\\b|applanation|rebound"),
    X("OCT macula (macula not said)", "investigations", "macula"), X("Glaucoma suspect code", "diagnosis", "H40\\.0|suspect")])
case("asr_bn_diabetic_retinopathy", "bn", "evaluation/bench/cases/asr_bn_diabetic_retinopathy.txt", "tuned", DR(), DR_FORBID + [X("Speaker label as name", "patient", "রোগী|patient")])

json.dump({"about": "Expected facts per bench conversation — generated by build_cases.py; do not edit by hand.", "cases": C}, open("cases.json", "w"), ensure_ascii=False, indent=1)
print(len(C), "cases,", sum(len(c["facts"]) for c in C), "facts")
