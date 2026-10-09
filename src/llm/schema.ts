/**
 * JSON schema the LLM must fill. Kept to plain strings/arrays ("" = not mentioned) so it works with
 * Ollama `format` and LM Studio `response_format: json_schema` alike, even on small models.
 */
type J = Record<string, unknown>;
const str = (description?: string): J => (description ? { type: "string", description } : { type: "string" });
const en = (values: string[], description?: string): J => ({ type: "string", enum: values, ...(description ? { description } : {}) });
/** maxItems stops small models from repeating list items forever */
const arr = (items: J, maxItems = 12): J => ({ type: "array", items, maxItems });
const obj = (properties: Record<string, J>): J => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const eye = en(["RE", "LE", "BE", ""], "RE=right, LE=left, BE=both, '' if not stated");
/** blood tests, ECG, BP, systemic advice: no eye side */
const eyeOrNone = en(["RE", "LE", "BE", ""], "eye side only for eye tests; '' for blood tests, ECG, blood pressure and other systemic tests");
const kbId = str("id from the knowledge base (e.g. MED-001) or '' if none fits");
/** Every clinical item must quote the words it came from, so unsupported (invented) items can be caught. */
const evidence = str("the exact words from the CONVERSATION TRANSCRIPT (original script, copied verbatim, 2-12 words) that support this item");

export const prescriptionSchema = obj({
  patient: obj({ name: str(), age: str(), sex: str() }),
  chief_complaints: arr(
    obj({
      complaint: str("medical term, e.g. 'Diminution of vision'"),
      kb_id: kbId,
      eye,
      duration: str("how long, e.g. '6 months' — never a time of day"),
      character: str("gradual/sudden, painful/painless, timing (e.g. 'worse in the evening'), aggravating factors"),
      patient_words: str("short quote"),
      evidence,
    }),
  ),
  history: obj({
    systemic: arr(obj({ condition: str(), kb_id: kbId, duration: str("only if stated for THIS condition"), treatment: str("drug names exactly as said"), evidence })),
    ocular: arr(obj({ item: str("PAST ocular history only (previous surgery, old glasses, past disease) — not today's findings. Family eye disease as 'Family history: glaucoma (mother)' with eye ''"), kb_id: kbId, eye, evidence })),
    current_medications: arr(str("medicines the patient already takes, with strength if said (e.g. 'Metformin', 'Amlodipine 5 mg')")),
    allergy_status: en(["none known", "present", "not discussed"], "'none known' when the patient says they have no drug allergy"),
    allergies: arr(str()),
  }),
  examination: arr(
    obj({ test: str(), kb_id: kbId, eye: en(["RE", "LE", "BE", ""], "ONE eye per row: write RE and LE values as separate rows, never a range across eyes"), result: str("value exactly as stated for that eye, e.g. '6/24', '16 mmHg'. For eye pressure put the method in the test name, e.g. 'Intraocular pressure (NCT)'"), evidence }),
  ),
  clinical_findings: arr(obj({ finding: str(), kb_id: kbId, eye, evidence })),
  diagnosis: arr(
    obj({
      condition: str("a sub-type (nuclear / cortical / posterior subcapsular …) only if that word was spoken"),
      kb_id: kbId,
      eye,
      grade_or_notes: str(),
      certainty: en(["confirmed", "provisional"]),
      evidence,
    }),
  ),
  medications: arr(
    obj({
      kb_id: kbId,
      generic_name: str(),
      brand_said: str("brand name if the doctor said one"),
      form: en(["E/D", "E/O", "Gel", "Tab", "Cap", "Inj", "Syrup", "Other", ""]),
      strength: str("only if stated"),
      eye,
      dose: str("e.g. '1 drop'"),
      frequency: str("QID / TID / BD / once daily / HS / 6x/day / hourly / SOS"),
      duration: str("e.g. '7 days', '4 weeks, tapering'"),
      status: en(["new", "continue"], "new = prescribed today; continue = patient already uses it and the doctor says to keep using it"),
      start_when: str("when to START if not today, exactly as said (e.g. '3 days before surgery'); '' = start today"),
      phase: en(["pre-op", "post-op", ""], "pre-op / post-op only when surgery is discussed"),
      instructions: str("e.g. '5-minute gap between drops'"),
      evidence,
    }),
  ),
  procedures: arr(obj({ procedure: str(), kb_id: kbId, eye, notes: str(), evidence })),
  investigations: arr(obj({ test: str("one test per row, e.g. 'Fasting blood sugar', 'HbA1c', 'ECG', 'A-scan biometry'"), kb_id: kbId, eye: eyeOrNone, purpose: str(), evidence })),
  glasses: arr(obj({ eye: en(["RE", "LE"]), sph: str(), cyl: str(), axis: str(), add: str(), notes: str() })),
  advice: arr(obj({ text: str("only advice the doctor actually spoke in THIS conversation"), kb_id: kbId, evidence })),
  follow_up: arr(obj({ when: str(), purpose: str() })),
  terms: arr(
    obj({ heard: str("exact words in transcript"), kb_id: kbId, canonical: str("KB name"), category: str() }),
    25,
  ),
});

// ---------- TypeScript mirror ----------
export type Eye = "RE" | "LE" | "BE" | "";
export interface Prescription {
  patient: { name: string; age: string; sex: string };
  chief_complaints: { complaint: string; kb_id: string; eye: Eye; duration: string; character: string; patient_words: string; evidence?: string }[];
  history: {
    systemic: { condition: string; kb_id: string; duration: string; treatment: string; evidence?: string }[];
    ocular: { item: string; kb_id: string; eye: Eye; evidence?: string }[];
    current_medications: string[];
    /** older drafts / approved examples may not have it */
    allergy_status?: "none known" | "present" | "not discussed" | "";
    allergies: string[];
  };
  examination: { test: string; kb_id: string; eye: Eye; result: string; evidence?: string }[];
  clinical_findings: { finding: string; kb_id: string; eye: Eye; evidence?: string }[];
  diagnosis: { condition: string; kb_id: string; eye: Eye; grade_or_notes: string; certainty: "confirmed" | "provisional"; evidence?: string }[];
  medications: {
    kb_id: string;
    generic_name: string;
    brand_said: string;
    form: string;
    strength: string;
    eye: Eye;
    dose: string;
    frequency: string;
    duration: string;
    status?: "new" | "continue" | "";
    start_when?: string;
    phase: string;
    instructions: string;
    evidence?: string;
  }[];
  procedures: { procedure: string; kb_id: string; eye: Eye; notes: string; evidence?: string }[];
  investigations: { test: string; kb_id: string; eye: Eye; purpose: string; evidence?: string }[];
  glasses: { eye: "RE" | "LE"; sph: string; cyl: string; axis: string; add: string; notes: string }[];
  advice: { text: string; kb_id: string; evidence?: string }[];
  follow_up: { when: string; purpose: string }[];
  terms: { heard: string; kb_id: string; canonical: string; category: string }[];
}
