import { appConfig } from "../config";
import type { Cue, Dictionary, DictionaryEntry } from "./types";

export interface PromptCue {
  id: number;
  text: string;
}

/**
 * Cues are handed to the model as JSON rather than plain lines so that
 * multi-line cues survive intact and each cue maps to exactly one output
 * entry. This removes line-count mismatches as a failure mode entirely.
 */
export function toPromptCues(cues: Cue[]): PromptCue[] {
  return cues.map((cue) => ({ id: cue.index, text: cue.lines.join("\n") }));
}

const asJson = (value: unknown) => JSON.stringify(value, null, 1);

const contextBlock = (lines: string[]): string =>
  lines.length > 0
    ? `Additional context about this series:\n${lines.map((line) => `- ${line}`).join("\n")}\n`
    : "";

const glossaryBlock = (terms: Record<string, DictionaryEntry>): string => {
  if (Object.keys(terms).length === 0) return "";
  return `\n<glossary>\nUse these established renderings. They are already agreed upon — do not invent alternatives.\n${asJson(terms)}\n</glossary>\n`;
};

const previousBlock = (cues: Cue[], label: string): string => {
  if (cues.length === 0) return "";
  const items = toPromptCues(cues)
    .map((cue) => `  ${cue.id}. ${cue.text.replace(/\n/g, " / ")}`)
    .join("\n");
  return `\n<${label}>\nAlready-final output immediately before this chunk. Match its tone, romanization and particle choices for continuity.\n${items}\n</${label}>\n`;
};

export interface StagePromptInput {
  /** Cues this stage rewrites. For review stages this is the ${original}. */
  source: Cue[];
  /** The text under revision, aligned 1:1 with `source`. Empty for extraction/translation. */
  current: Cue[];
  /** Already-finalised cues immediately before this chunk, for continuity. */
  context: Cue[];
  glossary: Record<string, DictionaryEntry>;
  feedback: string | null;
}

const feedbackBlock = (feedback: string | null) =>
  feedback
    ? `\n<correction_required>\n${feedback}\nFix exactly this and re-emit the full chunk.\n</correction_required>\n`
    : "";

export const TEXTS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    texts: { type: "array", items: { type: "string" } },
  },
  required: ["texts"],
} as const;

export const GLOSSARY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: `The ${appConfig.sourceLanguage} term, used as the glossary key`,
          },
          type: { type: "string", enum: ["character", "terminology"] },
          translations: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          gender: {
            type: "string",
            enum: ["male", "female", "neutral"],
            description: "Only for characters",
          },
          speakingStyle: {
            type: "string",
            description:
              "How this character talks, in Thai. Only for characters.",
          },
          prohibitedPhrases: {
            type: "array",
            items: { type: "string" },
            description: "Words or particles this character must never use",
          },
        },
        required: ["name", "type", "translations", "description"],
      },
    },
  },
  required: ["items"],
} as const;

// ---------------------------------------------------------------------------

export function extractionSystem(): string {
  return `You are a ${appConfig.sourceLanguage} to ${appConfig.targetLanguage} subtitle localization specialist.
TASK: read a batch of ${appConfig.sourceLanguage} subtitle cues and list the terms that must stay consistent across an entire series.

ONLY extract these:
1. Character names — including nicknames, titles, honorifics and how they are shortened in dialogue.
2. Places, organisations, factions, named objects and recurring in-jargon.
3. Idioms or phrases that recur and would translate inconsistently.

RULES
- Skip ordinary words. Only list a word if getting it wrong would be noticed.
- The \`name\` field must be the original ${appConfig.sourceLanguage} spelling, exactly as it appears in the subtitles.
- Every other field must be in ${appConfig.targetLanguage}.
- \`translations\` holds one or more accepted ${appConfig.targetLanguage} renderings; the first entry is the preferred one. Prefer the form a ${appConfig.targetLanguage} dub would actually say.
- Set \`gender\` only for characters, and only when the cues make it clear.
- \`speakingStyle\` and \`prohibitedPhrases\` are for characters with a distinctive voice.
- Never include episode numbers, timestamps or generic nouns such as "door", "run" or "angry".
- Do not invent terms that are absent from the input.
${contextBlock(appConfig.additionalContext)}`;
}

export function extractionPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and answer as a localization professional.

<input>
${asJson(toPromptCues(input.source))}
</input>

${glossaryBlock(input.glossary)}${feedbackBlock(input.feedback)}
Extract the terms from <input> that are NOT already covered by the glossary. Look at neighbouring cues for how a character is addressed before you decide a name is the same person. Return {"items": [...]}. Return an empty array if nothing new qualifies.`;
}

// ---------------------------------------------------------------------------

export function translationSystem(): string {
  return `You are a professional ${appConfig.sourceLanguage} to ${appConfig.targetLanguage} subtitle translator.
TASK: translate the given ${appConfig.sourceLanguage} subtitle cues into natural ${appConfig.targetLanguage}.

NON-NEGOTIABLE RULES
1. One output entry per input cue, in the same order. Never merge cues, never split a cue, never skip a cue, never add one.
2. Cue text may contain "\\n" between visual lines. You may reproduce or reduce those line breaks, but you must never change the number of entries.
3. Subtitles are read at a glance. Translate for the ear of a ${appConfig.targetLanguage} viewer watching in real time: concise, idiomatic, and no more verbose than the source.
4. Honour speaker intent — sarcasm, teasing, anger, formal register and foreign-accented speech should survive the translation.
5. Keep established glossary renderings. Keep a character's register consistent across cues.
6. Match the speaker's gender with natural particles: male speakers may use ครับ/อะ/นะ; female speakers may use ค่ะ/นะ/สิ. Use ครับ or ค่ะ only where the ${appConfig.sourceLanguage} original justifies the formality — do not append them to every single line.
7. Never leave ${appConfig.sourceLanguage} words untranslated unless they are a deliberate on-screen element (a sign, a brand, a song title).
8. Do not add explanations, transliterations, speaker labels or commentary. Output only the translations.
9. Escape nothing: emit plain ${appConfig.targetLanguage} text. Do not include ASS/SRT markup.
${contextBlock(appConfig.additionalContext)}`;
}

export function translationPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and translate it.

<input>
${asJson(toPromptCues(input.source))}
</input>
${previousBlock(input.context, "previous_output")}
${glossaryBlock(input.glossary)}
${feedbackBlock(input.feedback)}
Translate every cue in <input> into ${appConfig.targetLanguage}. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
}

// ---------------------------------------------------------------------------

export function consistencySystem(): string {
  return `You are a meticulous ${appConfig.targetLanguage} localization QA reviewer for subtitled drama.
TASK: review existing ${appConfig.targetLanguage} subtitle cues against the ${appConfig.sourceLanguage} original and fix only what breaks consistency or accuracy. Do not rewrite for style — a separate pass handles polish.

RULES
1. One output entry per input cue, in the same order. Never merge, split, skip or add cues.
2. Enforce the glossary exactly. If a rendering drifts from the agreed one, correct it.
3. Fix mistranslations, wrong speakers, dropped clauses and meaning that flipped.
4. Enforce character consistency: register, speech style, and gender-appropriate particles per the glossary.
5. Remove any untranslated ${appConfig.sourceLanguage} text that slipped through.
6. Leave cues that are already correct exactly as they are. Do not "improve" wording that is merely different.
7. Never invent content that is not supported by the original cue.
8. Output only the corrected ${appConfig.targetLanguage} texts, with no markup or commentary.
${contextBlock(appConfig.additionalContext)}`;
}

export function consistencyPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and review it.

<original>
${asJson(toPromptCues(input.source))}
</original>

<translated>
${asJson(toPromptCues(input.current))}
</translated>
${glossaryBlock(input.glossary)}
${feedbackBlock(input.feedback)}
Correct the <translated> cues using the <original> as the source of truth and the glossary for terminology. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
}

// ---------------------------------------------------------------------------

export function humanizationSystem(): string {
  return `You are a native ${appConfig.targetLanguage} speaker reviewing machine-translated subtitles for a streaming release.
TASK: make the ${appConfig.targetLanguage} read like a human subtitler wrote it. The goal is naturalness, not literary polish.

RULES
1. One output entry per input cue, in the same order. Never merge, split, skip or add cues.
2. Fix robotic phrasing only. If a cue already reads naturally, return it unchanged.
3. Replace stiff, word-for-word constructions with what a ${appConfig.targetLanguage} subtitler would actually write, keeping the meaning intact.
4. Remove leftover ${appConfig.sourceLanguage} characters, stray punctuation, duplicated words and machine artefacts such as "word (translation)".
5. Do not add words, embellish, explain or lengthen. Do not invent jokes or reactions.
6. Do not add explanatory parentheses unless the original had them.
7. Vary sentence rhythm. Do not end every line with the same particle; real dialogue does not.
8. Keep it short enough to read on screen. If a cue is needlessly long, tighten it without losing meaning.
9. Leave deliberate on-screen text (signs, brands, song titles) alone.
10. Output only the ${appConfig.targetLanguage} text, with no markup or commentary.
${contextBlock(appConfig.additionalContext)}`;
}

export function humanizationPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and polish it.

<original>
${asJson(toPromptCues(input.source))}
</original>

<translated>
${asJson(toPromptCues(input.current))}
</translated>
${glossaryBlock(input.glossary)}
${feedbackBlock(input.feedback)}
Lightly humanize the <translated> cues for natural ${appConfig.targetLanguage} subtitle reading. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
}

export function stageSystem(stage: string): string {
  switch (stage) {
    case "extraction":
      return extractionSystem();
    case "translation":
      return translationSystem();
    case "consistency":
      return consistencySystem();
    default:
      return humanizationSystem();
  }
}

export function stagePrompt(stage: string, input: StagePromptInput): string {
  switch (stage) {
    case "extraction":
      return extractionPrompt(input);
    case "translation":
      return translationPrompt(input);
    case "consistency":
      return consistencyPrompt(input);
    default:
      return humanizationPrompt(input);
  }
}
