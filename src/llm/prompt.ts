import type { KnowledgeBase, Scenario, Term } from "../kb/types.js";
import type { Match } from "../match/matcher.js";

export const SYSTEM_PROMPT = `You are a clinical scribe for an Indian ophthalmology OPD.
You read a doctor–patient conversation in English, Hindi or Bengali (often mixed; Hindi may be in Devanagari and Bengali in
Bengali script; it may contain speech-recognition errors), sometimes with a machine English translation,
and fill a structured prescription draft that the doctor will review and sign.

Rules:
1. Extract ONLY what is said in the conversation. Never invent a drug, dose, frequency, duration, test value or diagnosis.
   If something is not stated, use "" (or an empty array).
2. Map every clinical term to the knowledge base: put the matching id in kb_id and use the KB's canonical name.
   Prefer ids from CANDIDATES; you may use ids from the INDEX. If nothing fits, kb_id = "".
3. Correct obvious speech-recognition misspellings using the KB (e.g. "nepafinac" → Nepafenac, "moxi flox acin" → Moxifloxacin).
   Brand names map to their generic (e.g. Moxicip → Moxifloxacin); keep the brand in brand_said.
4. Eye: RE (right), LE (left), BE (both). Hindi: daayi/dahini/दाहिनी = right, baayi/बायीं = left, dono/दोनों = both.
   Bengali: dan/ডান = right, bam/বাম = left, duto/dutoi/দুটো = both.
   Numbers may be spoken in Hindi/Bengali (char/চার = 4, teen/তিন = 3, do/dui/দুই = 2, din/দিন = day, hafta/সপ্তাহ = week, mahina/মাস = month).
5. Frequencies: once a day → "once daily" (never "OD"), twice → BD, three times → TID, four times → QID,
   at bedtime → HS, as needed → SOS, "six times a day" → "6x/day". Durations like "7 days", "4 weeks, tapering".
6. Colloquial complaints → medical terms (e.g. "dhundhla dikhna"/"jhapsa dekha" → Diminution of vision,
   "motiyabind"/"chhani" → cataract, "chokh chulkay"/"khujli" → Itching).
7. Only the doctor's statements create diagnoses, medications, procedures and advice. The patient's statements create complaints and history.
8. "terms": list every ophthalmic term you recognised with the exact words heard.
Return JSON only.`;

const DETAIL_KEYS: Record<string, string[]> = {
  medicine: ["Dosage Form", "Common Strength", "Drug Class"],
  disease: ["Category", "ICD-10 (indicative)"],
  symptom: ["Associated Conditions"],
  test: ["Abbreviation", "Type"],
  sign: ["Suggestive Of"],
  procedure: ["Category", "Indication"],
  counselling: ["Context"],
};

function candidateLine(t: Term, heard: string): string {
  const alias = [...t.aliases, ...t.colloquial].slice(0, 6).join("; ");
  const det = (DETAIL_KEYS[t.category] ?? [])
    .map((k) => t.details[k])
    .filter(Boolean)
    .join(" | ");
  return `${t.id} [${t.category}] ${t.name}${alias ? ` (aka ${alias})` : ""}${det ? ` — ${det}` : ""}  «heard: ${heard}»`;
}

const LANG_NAMES: Record<string, string> = { en: "English", hi: "Hindi", bn: "Bengali" };

export function buildUserPrompt(opts: {
  transcript: string;
  english?: string;
  language?: string | null;
  candidates: Match[];
  kb: KnowledgeBase;
  indexCategories: string[];
  scenarios: Scenario[];
  modelHint?: string;
}): string {
  const { transcript, candidates, kb, indexCategories, scenarios } = opts;
  const candIds = new Set(candidates.map((c) => c.term.id));
  const parts: string[] = [];

  parts.push("## CANDIDATES (knowledge-base terms detected in this conversation)");
  parts.push(candidates.length ? candidates.map((c) => candidateLine(c.term, c.heardAs)).join("\n") : "(none detected)");

  if (indexCategories.length) {
    parts.push("\n## INDEX (other knowledge-base terms you may use)");
    for (const cat of indexCategories) {
      const rows = kb.terms.filter((t) => t.category === cat && !candIds.has(t.id));
      if (rows.length) parts.push(`# ${cat}\n` + rows.map((t) => `${t.id} ${t.name}`).join("\n"));
    }
  }

  if (scenarios.length) {
    parts.push("\n## STYLE EXAMPLE (how this clinic writes a similar case — do NOT copy its content)");
    for (const s of scenarios)
      parts.push(`Diagnosis: ${s.diagnosis}\nExam: ${s.exam}\nPlan/Rx: ${s.plan}\nAdvice: ${s.advice}`);
  }

  const lang = opts.language ? LANG_NAMES[opts.language] ?? opts.language : "";
  parts.push(`\n## CONVERSATION TRANSCRIPT${lang ? ` (spoken language: ${lang})` : ""}\n` + transcript.trim());
  if (opts.english?.trim())
    parts.push(
      "\n## MACHINE ENGLISH TRANSLATION of the same audio (may lose detail — the original transcript wins if they disagree; take drug names, numbers and eye side from whichever is clearer)\n" +
        opts.english.trim(),
    );
  parts.push("\nFill the prescription JSON from this conversation. Write every field in English (medical English for terms); keep only patient_words and terms[].heard in the words actually spoken.");
  if (opts.modelHint) parts.push(opts.modelHint);
  return parts.join("\n");
}
