export type TermCategory =
  | "disease"
  | "symptom"
  | "test"
  | "sign"
  | "medicine"
  | "procedure"
  | "optical"
  | "abbreviation"
  | "counselling"
  | "anatomy";

export interface Term {
  /** Stable id from the sheet, e.g. DIS-001, MED-014 */
  id: string;
  category: TermCategory;
  /** Canonical display name (what goes on the prescription) */
  name: string;
  /** Abbreviations, synonyms, brand names — matched case-insensitively (short ALL-CAPS ones case-sensitively) */
  aliases: string[];
  /** Lay / Hindi / Bengali phrases patients actually say */
  colloquial: string[];
  /** All other columns of the row, keyed by header */
  details: Record<string, string>;
}

export interface Scenario {
  id: string;
  scenario: string;
  complaint: string;
  history: string;
  exam: string;
  diagnosis: string;
  plan: string;
  advice: string;
}

export interface KnowledgeBase {
  source: string;
  builtAt: string;
  counts: Record<string, number>;
  terms: Term[];
  scenarios: Scenario[];
}
