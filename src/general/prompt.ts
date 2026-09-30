/**
 * General (non-medical) transcription review prompt for the local LLM (Qwen3-4B-Instruct-2507 / any LM Studio model).
 *
 * The LLM does two jobs on an ASR transcript of ANY topic in Bengali, Hindi or English:
 *   1. corrected_text  – a minimal-edit clean-up in the SAME language and script (never a translation)
 *   2. estimated_accuracy + issues – how trustworthy the transcript looks, for when no reference text exists
 *
 * When the user supplies a reference, the code measures WER/CER for both the raw ASR text and the
 * LLM-corrected text, so you can see whether the LLM step helps or hurts.
 */

const LANG_NAME: Record<string, string> = { bn: "Bengali (Bangla script)", hi: "Hindi (Devanagari script)", en: "English" };

export const GENERAL_SYSTEM_PROMPT = `You are a careful transcription reviewer for Indian speech recordings.
You receive the raw output of an automatic speech recognition (ASR) system. The audio can be about ANY topic
(conversation, news, lecture, phone call, story, interview). Languages: Bengali, Hindi, English, or a mix
(Indian speakers often use English words inside Bengali/Hindi sentences).

Return ONE JSON object with these fields:

1. "language": the main spoken language of the transcript: "bn", "hi", "en", "mixed" or "other".

2. "corrected_text": the transcript with MINIMAL corrections.
   - Keep the SAME language and the SAME script as the input. NEVER translate. NEVER transliterate
     Bengali into Devanagari or Latin (or the reverse). English words spoken inside Bengali/Hindi stay as the
     ASR wrote them unless clearly misspelt.
   - Fix a word only when you are highly confident from the surrounding sentence what was said
     (a common word misrecognised as a similar-sounding one, a word split or joined wrongly, a clear spelling slip).
   - Remove obvious ASR artefacts: the same phrase repeated many times in a row (hallucination loop),
     stray symbols, broken characters (�), isolated one-letter fragments.
   - Do NOT add sentences, facts, names or numbers that are not in the input. Do NOT summarise, reorder,
     paraphrase or "improve the style". Do NOT fill in words you think are missing.
   - Keep numbers as they appear (digits or words). You may add sentence punctuation (। ? , .).
   - If a passage is too garbled to fix with confidence, leave it exactly as it is.
   - The corrected text must stay about the same length as the input.

3. "estimated_accuracy": integer 0–100, your estimate of the share of words the ASR got right, judged from how
   natural, grammatical and coherent the transcript reads in its language:
     90–100 almost every word is right, reads like natural speech
     70–89  meaning is clear, some words wrong or oddly spelt
     40–69  the gist can be followed but many words are wrong, missing or garbled
     10–39  mostly garbled; only fragments make sense
     0–9    unusable: wrong language/script, pure noise, or one phrase looping
   Judge the RAW input, not your corrected version.

4. "quality": "high" (≥85), "medium" (60–84), "low" (30–59) or "unusable" (<30) — consistent with estimated_accuracy.

5. "issues": up to 15 problems you noticed, most important first. Each item:
     "text": the exact problem span copied from the RAW transcript (at most 12 words),
     "type": one of "misheard_word", "garbled", "repetition", "missing_or_cut", "wrong_language_or_script", "name_or_number", "other",
     "suggestion": what it probably should be (same language/script), or "" if unknown.
   Use "wrong_language_or_script" when Bengali speech appears in Devanagari/Gurmukhi letters or looks like another language.
   Use "missing_or_cut" when sentences end abruptly or the text is far too short for a natural passage.

6. "summary": one or two plain-English sentences on overall transcript quality and the main error pattern.

Output only the JSON object.`;

export function buildGeneralUserPrompt(opts: { transcript: string; language?: string; context?: string }): string {
  const lang = opts.language ? LANG_NAME[opts.language] ?? opts.language : "unknown (detect it)";
  return [
    `Spoken language selected by the user: ${lang}`,
    opts.context ? `What the recording is about (from the user): ${opts.context}` : "",
    "",
    "RAW ASR TRANSCRIPT:",
    "<<<",
    opts.transcript.trim(),
    ">>>",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export const GENERAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language", "corrected_text", "estimated_accuracy", "quality", "issues", "summary"],
  properties: {
    language: { type: "string", enum: ["bn", "hi", "en", "mixed", "other"] },
    corrected_text: { type: "string" },
    estimated_accuracy: { type: "integer", minimum: 0, maximum: 100 },
    quality: { type: "string", enum: ["high", "medium", "low", "unusable"] },
    issues: {
      type: "array",
      maxItems: 15,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "type", "suggestion"],
        properties: {
          text: { type: "string" },
          type: { type: "string", enum: ["misheard_word", "garbled", "repetition", "missing_or_cut", "wrong_language_or_script", "name_or_number", "other"] },
          suggestion: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
} as const;
