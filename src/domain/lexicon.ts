/**
 * Eye-domain lexicon (data/eye_lexicon.json): Bengali / Hindi / English lay phrases and known ASR
 * mishearings → knowledge-base ids, plus "block" lists for KB terms those phrases wrongly trigger.
 *
 *   চালশে → Presbyopia · প্রেশার → Hypertension (and NOT glaucoma / IOP) · "amstrad" → Amsler grid (never a drug)
 *
 * Native-script phrases match as substrings (Bengali/Hindi attach case endings: চোখে, চোখের …);
 * Latin phrases match on word boundaries. A longer phrase wins over a shorter one it contains
 * (চোখের প্রেশার → IOP, so the plain প্রেশার inside it is not also read as blood pressure).
 */
import fs from "node:fs";
import { config } from "../config.js";
import type { KnowledgeBase, Term } from "../kb/types.js";

export interface LexEntry {
  lang: "bn" | "hi" | "en";
  match: string[];
  id?: string;
  hint?: string;
  block?: string[];
}

export interface LexHit {
  entry: LexEntry;
  /** the phrase as found in the transcript */
  heard: string;
  start: number;
  end: number;
  term?: Term;
}

let cache: { mtime: number; entries: LexEntry[] } | null = null;

export function loadLexicon(file = config.paths.lexicon): LexEntry[] {
  if (!fs.existsSync(file)) return [];
  const mtime = fs.statSync(file).mtimeMs;
  if (cache && cache.mtime === mtime) return cache.entries;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries: LexEntry[] = (doc.entries ?? doc).filter((e: any) => e && Array.isArray(e.match) && e.match.length);
  cache = { mtime, entries };
  return entries;
}

const INDIC = /[ऀ-৿]/;
const clean = (s: string) => s.normalize("NFC").replace(/[​-‍﻿]/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find every lexicon phrase in the text (longest match wins where phrases overlap). */
export function scanLexicon(text: string, kb?: KnowledgeBase, entries = loadLexicon()): LexHit[] {
  const src = clean(text);
  const lower = src.toLowerCase();
  const found: LexHit[] = [];
  for (const entry of entries) {
    for (const phrase of entry.match) {
      const p = clean(phrase);
      if (!p.trim()) continue;
      if (INDIC.test(p)) {
        let i = src.indexOf(p);
        while (i >= 0) {
          found.push({ entry, heard: p, start: i, end: i + p.length });
          i = src.indexOf(p, i + p.length);
        }
      } else {
        // hyphen and space are interchangeable ("r-cyte" = "r cyte"); word boundaries on both sides
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p.toLowerCase()).replace(/\\-|\s+/g, "[-\\s]?")}(?![\\p{L}\\p{N}])`, "gu");
        for (const m of lower.matchAll(re)) found.push({ entry, heard: src.slice(m.index!, m.index! + m[0].length), start: m.index!, end: m.index! + m[0].length });
      }
    }
  }
  // longest first; drop hits that sit inside an already-taken longer span
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: [number, number][] = [];
  const out: LexHit[] = [];
  for (const h of found) {
    if (taken.some(([s, e]) => h.start >= s && h.end <= e)) continue;
    taken.push([h.start, h.end]);
    out.push(h);
  }
  const byId = kb ? new Map(kb.terms.map((t) => [t.id, t])) : null;
  for (const h of out) if (h.entry.id && byId) h.term = byId.get(h.entry.id);
  return out.sort((a, b) => a.start - b.start);
}
