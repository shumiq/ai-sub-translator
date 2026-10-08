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

const cueList = (cues: PromptCue[]): string =>
  cues
    .map((cue) => `  ${cue.id}. ${cue.text.replace(/\n/g, " / ")}`)
    .join("\n");

/** Source-language cues before this chunk, so the model sees the scene. */
const previousInputBlock = (cues: Cue[]): string =>
  cues.length === 0
    ? ""
    : `\n<previous_input>\n${appConfig.sourceLanguage} cues immediately before this chunk, for scene context.\n${cueList(toPromptCues(cues))}\n</previous_input>\n`;

/**
 * What this run has already produced for the cues before this chunk, so
 * terminology and wording stay continuous across chunk boundaries. It is
 * deliberately not offered as evidence about people: the model is blind, so
 * reading speaker, gender or register off its own earlier output is guessing,
 * and that guess is the failure mode this block must not invite.
 */
const previousOutputBlock = (cues: PromptCue[]): string =>
  cues.length === 0
    ? ""
    : `\n<previous_output>\nAlready-translated ${appConfig.targetLanguage} output immediately before this chunk. Match its terminology and wording style so the scene does not change voice mid-file. It is not evidence about who speaks: inherit no gender, no ending particle, no kinship or self-reference term from it. Who speaks a cue is decided by that cue's own text alone.\n${cueList(cues)}\n</previous_output>\n`;

export interface StagePromptInput {
  /** Cues this stage rewrites. For review stages this is the ${original}. */
  source: Cue[];
  /** The text under revision, aligned 1:1 with `source`. Empty for extraction/translation. */
  current: Cue[];
  /** Already-finalised cues immediately before this chunk, for continuity. */
  context: Cue[];
  /** Output produced so far for the cues before this chunk. */
  previousOutput: PromptCue[];
  glossary: Record<string, DictionaryEntry>;
  feedback: string | null;
}

const feedbackBlock = (feedback: string | null) =>
  feedback
    ? `\n<correction_required>\n${feedback}\nFix exactly this and re-emit the full chunk.\n</correction_required>\n`
    : "";

/**
 * How the model is allowed to break a cue across lines, which follows the
 * `lineCountPerCue` check the validator will apply to its answer.
 *
 * Kept out of the numbered RULES so that the numbering does not shift with
 * the flag.
 */
const lineBreakRule = () =>
  appConfig.validation.lineCountPerCue
    ? `LINE BREAKS: a cue whose source contains "\\n" must come back with exactly the same number of lines, separated by "\\n", broken at the same point. Never merge two source lines into one and never split one into two.`
    : `LINE BREAKS: re-break each cue wherever the ${appConfig.targetLanguage} reads best. Merging the source's lines or splitting them further is fine, but never leave a cue empty and never let one run past two lines — it has to stay readable as a subtitle.`;

/**
 * The model gets cue text and nothing else — no video, audio, speaker labels
 * or plot knowledge. Stated once here so every stage inherits it instead of
 * each inventing its own version of "do not guess".
 */
const blindRule = () =>
  `BLIND INPUT: you see subtitle text only — no video, audio, speaker labels or knowledge of the plot. Never invent what the cues do not state: who speaks, who is addressed, gender, relationships, setting, events. This holds per cue: a neighbouring cue or <previous_output> says nothing about who speaks this cue. Where the source stays ambiguous, keep the ${appConfig.targetLanguage} equally ambiguous — resolving ambiguity is guessing.`;

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
            description: `How this character talks, in ${appConfig.targetLanguage}. Only for characters.`,
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
- Set \`gender\` only for characters, and only when a cue states it outright — an explicit gendered self-reference or an explicitly gendered name. Never guess from how a name sounds or from context.
- Do not infer relationships or roles (mother, boss, detective) that the cues never state.
- \`speakingStyle\` and \`prohibitedPhrases\` are for characters with a distinctive voice.
- Never include episode numbers, timestamps or generic nouns such as "door", "run" or "angry".
- Do not invent terms that are absent from the input.
${blindRule()}
${contextBlock(appConfig.additionalContext)}`;
}

export function extractionPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and answer as a localization professional.

<input>
${asJson(toPromptCues(input.source))}
</input>

${glossaryBlock(input.glossary)}${feedbackBlock(input.feedback)}
Extract the terms from <input> that are NOT already covered by the glossary. Existing entries are pinned by the user — never propose a different rendering for a term the glossary already lists, skip it entirely. Look at neighbouring cues for how a character is addressed before you decide a name is the same person. Return {"items": [...]}. Return an empty array if nothing new qualifies.`;
}

// ---------------------------------------------------------------------------

export function translationSystem(): string {
  return `You are a professional ${appConfig.sourceLanguage} to ${appConfig.targetLanguage} subtitle translator.
TASK: translate the given ${appConfig.sourceLanguage} subtitle cues into natural ${appConfig.targetLanguage}.

NON-NEGOTIABLE RULES
1. One output entry per input cue, in the same order. Never merge cues, never split a cue, never skip a cue, never add one.
2. Subtitles are read at a glance. Translate for the ear of a ${appConfig.targetLanguage} viewer watching in real time: concise, idiomatic, and no more verbose than the source.
3. Honour speaker intent — sarcasm, teasing, anger, formal register and foreign-accented speech should survive the translation.
4. Keep established glossary renderings. Do not carry a register, self-reference or particle choice across cues — cues are not tagged with speakers, so consistency across cues is not yours to enforce.
5. Gendered ${appConfig.targetLanguage} forms — first-person pronouns such as ดิฉัน/ผม and ending particles such as ครับ/ค่ะ/คะ — only where *this* cue gives solid evidence of the speaker's gender: an explicit gendered self-reference or gendered wording in the cue. A \`gender\` in the glossary counts only if this cue itself names that character as the speaker; otherwise it tells you nothing. When the cue gives no such evidence, fall back to neutral — ฉัน, เรา, คุณ — and no gendered particle. Never guess a speaker's gender from vibes, from neighbouring cues or from <previous_output>, and do not append ครับ/ค่ะ to every line.
6. Add nothing the source does not state: no names for unnamed people, no relationship or kinship terms (e.g. พ่อ, ลูก, หนู, พี่, น้อง), no self-reference the cue does not make, no addressee the cue does not address, no resolving a pronoun whose referent the text never pins down.
7. Never leave ${appConfig.sourceLanguage} words untranslated unless they are a deliberate on-screen element (a sign, a brand, a song title).
8. Do not add explanations, transliterations, speaker labels or commentary. Output only the translations.
9. Escape nothing: emit plain ${appConfig.targetLanguage} text. Do not include ASS/SRT markup.

${lineBreakRule()}
${blindRule()}
${contextBlock(appConfig.additionalContext)}`;
}

export function translationPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and translate it.

<input>
${asJson(toPromptCues(input.source))}
</input>
${previousInputBlock(input.context)}${previousOutputBlock(input.previousOutput)}${glossaryBlock(input.glossary)}${feedbackBlock(input.feedback)}
Translate every cue in <input> into ${appConfig.targetLanguage}, keeping the voice continuous with <previous_output> where one was given. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
}

// ---------------------------------------------------------------------------

export function consistencySystem(): string {
  return `You are a meticulous ${appConfig.targetLanguage} localization QA reviewer for subtitled drama.
TASK: review existing ${appConfig.targetLanguage} subtitle cues against the ${appConfig.sourceLanguage} original and fix only what breaks consistency or accuracy. Do not rewrite for style — a separate pass handles polish.

RULES
1. One output entry per input cue, in the same order. Never merge, split, skip or add cues.
2. Enforce the glossary exactly. If a rendering drifts from the agreed one, correct it.
3. Fix mistranslations, wrong speakers, dropped clauses and meaning that flipped.
4. Enforce character consistency within the cue: register, speech style, and gendered forms (ดิฉัน/ผม, ครับ/ค่ะ) only where the original cue itself gives solid evidence of the speaker's gender. A glossary \`gender\` counts only if the cue names that character; never infer the speaker from <previous_output> or neighbouring cues. Where the cue does not, the neutral form (ฉัน, เรา, คุณ, no gendered particle) is correct — strip gendered particles, kinship terms (พ่อ, ลูก, หนู) and self-references the original does not justify.
5. Remove any untranslated ${appConfig.sourceLanguage} text that slipped through.
6. Leave cues that are already correct exactly as they are. Do not "improve" wording that is merely different.
7. Never invent content that is not supported by the original cue, and never resolve ambiguity the original leaves open — unclear speaker, referent or gender. An equally ambiguous translation is the correct one.
8. Output only the corrected ${appConfig.targetLanguage} texts, with no markup or commentary.

${lineBreakRule()}
${blindRule()}
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
${previousOutputBlock(input.previousOutput)}${glossaryBlock(input.glossary)}
${feedbackBlock(input.feedback)}
Correct the <translated> cues using the <original> as the source of truth and the glossary for terminology, keeping the voice continuous with <previous_output> where one was given. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
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
6. Do not assume who is speaking or being spoken to. A subtitle cue carries no speaker labels, so never invent names, relationships, gender or addressees: no nicknames, no kinship terms (พ่อ, ลูก, หนู, พี่, น้อง), no gendered pronouns or particles (ครับ/ค่ะ/ดิฉัน/ผม), no "he/she said" implications unless the original cue itself states them — and never read the speaker off <previous_output> or a neighbouring cue. When in doubt, keep the wording neutral.
7. Do not add explanatory parentheses unless the original had them.
8. Vary sentence rhythm. Do not end every line with the same particle; real dialogue does not.
9. Keep it short enough to read on screen. If a cue is needlessly long, tighten it without losing meaning.
10. Leave deliberate on-screen text (signs, brands, song titles) alone.
11. Output only the ${appConfig.targetLanguage} text, with no markup or commentary.

${lineBreakRule()}
${blindRule()}
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
${previousOutputBlock(input.previousOutput)}${glossaryBlock(input.glossary)}
${feedbackBlock(input.feedback)}
Lightly humanize the <translated> cues for natural ${appConfig.targetLanguage} subtitle reading, using <original> to confirm the meaning — polish must not change what the cue says, who speaks or who is addressed — and keep the voice continuous with <previous_output> where one was given. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
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
