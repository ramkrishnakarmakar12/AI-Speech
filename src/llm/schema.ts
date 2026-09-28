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
const kbId = str("id from the knowledge base (e.g. MED-001) or '' if none fits");

export const prescriptionSchema = obj({
  patient: obj({ name: str(), age: str(), sex: str() }),
  chief_complaints: arr(
    obj({ complaint: str("medical term, e.g. 'Diminution of vision'"), kb_id: kbId, eye, duration: str(), character: str("gradual/sudden, painful/painless etc."), patient_words: str("short quote") }),
  ),
  history: obj({
    systemic: arr(obj({ condition: str(), kb_id: kbId, duration: str(), treatment: str() })),
    ocular: arr(obj({ item: str(), kb_id: kbId, eye })),
    current_medications: arr(str()),
    allergies: arr(str()),
  }),
  examination: arr(obj({ test: str(), kb_id: kbId, eye, result: str("value exactly as stated, e.g. '6/36, 6/18 with PH', '16 mmHg'") })),
  clinical_findings: arr(obj({ finding: str(), kb_id: kbId, eye })),
  diagnosis: arr(obj({ condition: str(), kb_id: kbId, eye, grade_or_notes: str(), certainty: en(["confirmed", "provisional"]) })),
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
      phase: en(["pre-op", "post-op", "current", ""]),
      instructions: str(),
    }),
  ),
  procedures: arr(obj({ procedure: str(), kb_id: kbId, eye, notes: str() })),
  investigations: arr(obj({ test: str(), kb_id: kbId, eye, purpose: str() })),
  glasses: arr(obj({ eye: en(["RE", "LE"]), sph: str(), cyl: str(), axis: str(), add: str(), notes: str() })),
  advice: arr(obj({ text: str(), kb_id: kbId })),
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
  chief_complaints: { complaint: string; kb_id: string; eye: Eye; duration: string; character: string; patient_words: string }[];
  history: {
    systemic: { condition: string; kb_id: string; duration: string; treatment: string }[];
    ocular: { item: string; kb_id: string; eye: Eye }[];
    current_medications: string[];
    allergies: string[];
  };
  examination: { test: string; kb_id: string; eye: Eye; result: string }[];
  clinical_findings: { finding: string; kb_id: string; eye: Eye }[];
  diagnosis: { condition: string; kb_id: string; eye: Eye; grade_or_notes: string; certainty: "confirmed" | "provisional" }[];
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
    phase: string;
    instructions: string;
  }[];
  procedures: { procedure: string; kb_id: string; eye: Eye; notes: string }[];
  investigations: { test: string; kb_id: string; eye: Eye; purpose: string }[];
  glasses: { eye: "RE" | "LE"; sph: string; cyl: string; axis: string; add: string; notes: string }[];
  advice: { text: string; kb_id: string }[];
  follow_up: { when: string; purpose: string }[];
  terms: { heard: string; kb_id: string; canonical: string; category: string }[];
}
