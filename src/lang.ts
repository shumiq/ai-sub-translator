const THAI_RE = /\p{Script=Thai}/gu;
const LATIN_RE = /\p{Script=Latin}/gu;
const LETTER_RE = /\p{L}/gu;

export interface ScriptCounts {
  thai: number;
  latin: number;
  letters: number;
}

export function countScripts(text: string): ScriptCounts {
  return {
    thai: (text.match(THAI_RE) ?? []).length,
    latin: (text.match(LATIN_RE) ?? []).length,
    letters: (text.match(LETTER_RE) ?? []).length,
  };
}

export function isThaiText(text: string): boolean {
  return countScripts(text).thai > 0;
}

/** True when a cue carries words worth sending to the model. */
export function isTranslatable(text: string): boolean {
  return countScripts(text).letters >= 2;
}

/**
 * Share of alphabetic characters that are Latin. High values in Thai output
 * usually mean the model copied the source instead of translating it.
 */
export function latinRatio(text: string): number {
  const { thai, latin } = countScripts(text);
  const total = thai + latin;
  return total === 0 ? 0 : latin / total;
}

/** Lowercased and stripped of whitespace/punctuation, for equality checks. */
export function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}
