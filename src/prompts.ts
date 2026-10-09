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
 * terminology and register stay continuous across chunk boundaries. Continuity
 * here is about voice, not people: the fill loop reads speaker and gender off
 * each cue's `evaluation` field, so this block is free to carry tone and
 * terminology forward without inviting a guess.
 */
const previousOutputBlock = (cues: PromptCue[]): string =>
  cues.length === 0
    ? ""
    : `\n<previous_output>\nAlready-translated ${appConfig.targetLanguage} output immediately before this chunk. Match its terminology and register so the scene keeps one voice and does not change mid-file. Who speaks is still decided per cue by that cue's \`evaluation\` field, not by this text.\n${cueList(cues)}\n</previous_output>\n`;

/**
 * Renders source cues for a prompt with the evaluation stage's verdict attached
 * directly to each cue as an `evaluation` field. The verdict is woven into the
 * cue rather than listed separately so the model cannot drop the mapping and
 * fall back to guessing; `neutral` rides along just as visibly as `male to
 * female`. With no evaluation to attach it degrades to the plain cue list, so
 * a run without that stage behaves exactly as before.
 */
const evaluatedCueList = (cues: Cue[], evaluation: PromptCue[]): string => {
  if (evaluation.length === 0) return asJson(toPromptCues(cues));
  const byId = new Map(evaluation.map((item) => [item.id, item.text]));
  return asJson(
    cues.map((cue) => ({
      id: cue.index,
      evaluation: byId.get(cue.index) ?? "neutral",
      text: cue.lines.join("\n"),
    })),
  );
};

/**
 * Same idea for the review stages, one object per cue carrying the original
 * text, the translation under revision and the evaluation verdict together.
 * Pairing them removes the id-join the model had to do between separate blocks
 * — which is exactly where a verdict could silently lose its cue.
 */
const reviewCueList = (
  source: Cue[],
  current: Cue[],
  evaluation: PromptCue[],
): string => {
  const byId = new Map(evaluation.map((item) => [item.id, item.text]));
  const translatedById = new Map(
    current.map((cue) => [cue.index, cue.lines.join("\n")]),
  );
  return asJson(
    source.map((cue) => ({
      id: cue.index,
      ...(evaluation.length > 0
        ? { evaluation: byId.get(cue.index) ?? "neutral" }
        : {}),
      original: cue.lines.join("\n"),
      translated: translatedById.get(cue.index) ?? "",
    })),
  );
};

export interface StagePromptInput {
  /** Cues this stage rewrites. For review stages this is the ${original}. */
  source: Cue[];
  /** The text under revision, aligned 1:1 with `source`. Empty for extraction/translation. */
  current: Cue[];
  /** Already-finalised cues immediately before this chunk, for continuity. */
  context: Cue[];
  /** Output produced so far for the cues before this chunk. */
  previousOutput: PromptCue[];
  /**
   * Per-cue speaker/addressee classifications for this chunk only, from the
   * evaluation stage. Empty when that stage did not run; then the model falls
   * back to what each cue's own text states.
   */
  evaluation: PromptCue[];
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
 *
 * `natural` is for the stages that write prose (translation, humanization).
 * They still may not fabricate people or facts, but they are allowed to lean
 * on the surrounding cues and <previous_output> for voice and reference
 * resolution — with a reliable evaluation pass and fix loop behind them, the
 * older forbid-all-ambiguity wording was buying correctness the pipeline
 * already enforces, at the cost of robotic output.
 */
const blindRule = (natural = false) =>
  natural
    ? `BLIND INPUT: you see subtitle text only — no video, audio, speaker labels or knowledge of the plot. Never fabricate a person, relationship, setting or event the cues never state. A cue's own \`evaluation\` field settles who speaks it: obey that field exactly and never import another cue's field. Within those bounds, write the way a native ${appConfig.targetLanguage} speaker naturally would — read the surrounding cues and <previous_output> to resolve references and keep the scene's voice continuous, instead of translating each cue in a vacuum.`
    : `BLIND INPUT: you see subtitle text only — no video, audio, speaker labels or knowledge of the plot. Never invent what the cues do not state: who speaks, who is addressed, gender, relationships, setting, events. This holds per cue: a neighbouring cue or <previous_output> says nothing about who speaks this cue. The one exception is a cue's own \`evaluation\` field, when one is present: it is given rather than guessed, so obey it exactly for that cue and never import another cue's field. Where nothing settles the question, keep the ${appConfig.targetLanguage} equally ambiguous — resolving ambiguity is guessing.`;

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

export const EVALUATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "integer",
            description: "The cue id, copied from the input",
          },
          evaluation: {
            type: "string",
            description:
              "Who speaks and who is addressed, from this cue alone — e.g. `neutral`, `male to female`, or `father to daughter (Ana)`",
          },
        },
        required: ["id", "evaluation"],
      },
    },
  },
  required: ["items"],
} as const;

/**
 * The evaluation stage does the one thing every other stage is forbidden to
 * do — name the speaker — and does it deliberately, one cue at a time, with no
 * neighbours to lean on. Later stages then treat its output as given. This is
 * the split that keeps the blind-translation rule intact: inference happens
 * here, once, and is quoted rather than repeated down the pipeline.
 */
export function evaluationSystem(): string {
  return `You are a ${appConfig.sourceLanguage} to ${appConfig.targetLanguage} dialogue analyst for subtitled drama.
TASK: for each ${appConfig.sourceLanguage} subtitle cue, decide on its own who is speaking, who is addressed, and any gender, role, kinship or name the cue itself reveals.

Return one short \`evaluation\` string per cue:
- A bare \`<speaker>\` when the cue addresses nobody.
- \`<speaker> to <addressee>\` when it plainly addresses someone.
Each side is exactly one of neutral, male, female — or a role the cue itself states (father, daughter, boss, teacher, …). Add a name in parentheses only when the cue text contains it.

RULES
- Judge every cue in complete isolation. A neighbouring cue in <input> says nothing about this one: never carry a speaker, addressee, gender, role or name from one cue to the next.
- State only what the cue itself shows: an explicit gendered self-reference, an explicit form of address, a stated role or kinship, or a name actually present in the cue.
- \`neutral\` is a real answer and the correct one whenever the cue gives no evidence either way.
- Return exactly one entry per input cue, with that cue's id.

${blindRule()}
${contextBlock(appConfig.additionalContext)}`;
}

export function evaluationPrompt(cues: Cue[], feedback: string | null): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and classify the dialogue.

<input>
${asJson(toPromptCues(cues))}
</input>
${feedbackBlock(feedback)}
Classify every cue in <input> independently, as though it were the only cue. Return {"items": [{"id": <cue id>, "evaluation": "<speaker> or <speaker> to <addressee>"}]} with exactly ${cues.length} entries, one per input cue.`;
}

// ---------------------------------------------------------------------------

export function translationSystem(): string {
  return `You are a professional ${appConfig.sourceLanguage} to ${appConfig.targetLanguage} subtitle translator.
TASK: translate the given ${appConfig.sourceLanguage} subtitle cues into ${appConfig.targetLanguage} that reads as if a native ${appConfig.targetLanguage} screenwriter wrote it — not as if it were converted word-for-word from ${appConfig.sourceLanguage}.

RULES
1. One output entry per input cue, in the same order. Never merge cues, never split a cue, never skip a cue, never add one.
2. Translate meaning, not words. Recast, reorder or drop source-shaped constructions so the line lands the way a ${appConfig.targetLanguage} viewer expects to hear it. Subtitles are read at a glance, so keep each cue as short as its meaning allows.
3. Keep the voice: sarcasm, teasing, anger, warmth, formality and foreign-accented speech should all survive the translation.
4. SPEAKER IS GIVEN, NOT GUESSED. Every input cue carries an \`evaluation\` field from a prior pass naming who speaks and who is addressed. Treat it as final and apply it to that cue only: carry a gendered or role value through exactly — first-person pronouns (ดิฉัน/ผม/ฉัน), ending particles (ครับ/ค่ะ/คะ), kinship terms and names. When the field is \`neutral\`, the cue must come out neutral — ฉัน, เรา, คุณ — with no gendered particle, no kinship term, no name and no \`ครับ/ค่ะ\`. Never read a speaker or addressee off a neighbouring cue. If a cue has no \`evaluation\` field, use whatever that cue itself states, otherwise neutral.
5. Keep established glossary renderings. A glossary \`gender\` or \`speakingStyle\` never overrides a cue's \`evaluation\` field.
6. Do not invent a fact, name, relationship or event the source never states. Naturalness is the phrasing a native speaker would choose, not added content the original did not have.
7. Never leave ${appConfig.sourceLanguage} words untranslated unless they are a deliberate on-screen element (a sign, a brand, a song title).
8. Do not add explanations, transliterations, speaker labels or commentary. Output only the translations.
9. Escape nothing: emit plain ${appConfig.targetLanguage} text. Do not include ASS/SRT markup.

${lineBreakRule()}
${blindRule(true)}
${contextBlock(appConfig.additionalContext)}`;
}

export function translationPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and translate it.

<input>
${evaluatedCueList(input.source, input.evaluation)}
</input>
${previousInputBlock(input.context)}${previousOutputBlock(input.previousOutput)}${glossaryBlock(input.glossary)}${feedbackBlock(input.feedback)}
Translate every cue in <input> into ${appConfig.targetLanguage}, keeping the voice continuous with <previous_output> where one was given and obeying this cue's \`evaluation\` field exactly — never another cue's. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
}

// ---------------------------------------------------------------------------

export const VERIFICATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "integer",
            description: "The cue id, copied from the input",
          },
          ok: {
            type: "boolean",
            description:
              "True when the translation faithfully carries the original cue",
          },
          reason: {
            type: "string",
            description: "Short reason when `ok` is false, else empty",
          },
        },
        required: ["id", "ok"],
      },
    },
  },
  required: ["items"],
} as const;

/**
 * The audit that runs after humanization. It does not rewrite — it only says
 * which cues drifted, so only the few that did are re-humanized instead of a
 * whole-file consistency pass. `ok` is the fidelity verdict, not a style one,
 * so awkward-but-faithful wording stays put.
 */
export function verificationSystem(): string {
  return `You are a meticulous ${appConfig.sourceLanguage} to ${appConfig.targetLanguage} subtitle QA verifier for subtitled drama.
TASK: for each cue, compare the ${appConfig.targetLanguage} translation against its ${appConfig.sourceLanguage} original and decide whether it faithfully carries the original's meaning. This is a fidelity audit, not a style review.

Return one entry per cue:
- \`ok\`: true when the translation says the same thing as the original.
- \`reason\`: a short description of what is wrong only when \`ok\` is false.

RULES
1. Judge each cue against its own \`original\` and \`evaluation\` field alone; a neighbouring cue is not evidence.
2. \`ok\` is false when the meaning changed, a clause was dropped or added, the speaker or addressee disagrees with the \`evaluation\` field, an untranslated ${appConfig.sourceLanguage} word remains, or a gendered, kinship or particle form contradicts the field.
3. Wording that is merely awkward or different is still \`ok\` — this stage audits fidelity, not polish.
4. Return exactly one entry per input cue, with that cue's id.

${blindRule()}
${contextBlock(appConfig.additionalContext)}`;
}

export function verificationPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and verify the translation against the original.

<cues>
${reviewCueList(input.source, input.current, input.evaluation)}
</cues>
${feedbackBlock(input.feedback)}
For each cue, decide whether its \`translated\` field faithfully carries its \`original\` field and obeys its \`evaluation\` field. Return {"items": [{"id": <cue id>, "ok": true}]} with exactly ${input.source.length} entries, one per cue. Anything that changes what the cue says or who speaks it is not ok.`;
}

export function stageSystem(stage: string): string {
  switch (stage) {
    case "extraction":
      return extractionSystem();
    case "evaluation":
      return evaluationSystem();
    case "translation":
      return translationSystem();
    default:
      return humanizationSystem();
  }
}

export function stagePrompt(stage: string, input: StagePromptInput): string {
  switch (stage) {
    case "extraction":
      return extractionPrompt(input);
    case "evaluation":
      return evaluationPrompt(input.source, input.feedback);
    case "translation":
      return translationPrompt(input);
    default:
      return humanizationPrompt(input);
  }
}

export function humanizationSystem(): string {
  return `You are a native ${appConfig.targetLanguage} speaker reviewing machine-translated subtitles for a streaming release.
TASK: make the ${appConfig.targetLanguage} read like a native ${appConfig.targetLanguage} subtitler wrote it from scratch. Naturalness is the whole job.

RULES
1. One output entry per input cue, in the same order. Never merge, split, skip or add cues.
2. Rewrite anything that still sounds translated. If a cue already reads naturally, return it unchanged.
3. Prefer what a ${appConfig.targetLanguage} speaker actually says over a literal calque of the ${appConfig.sourceLanguage}, even if that means changing the sentence shape, word order or connectors. The meaning must survive; the shape need not.
4. Match the register of the original line — casual stays casual, cold stays cold, formal stays formal.
5. Remove leftover ${appConfig.sourceLanguage} characters, stray punctuation, duplicated words and machine artefacts such as "word (translation)".
6. SPEAKER IS GIVEN, NOT GUESSED. Each cue object carries an \`evaluation\` field naming who speaks and who is addressed; it is final and applies to that cue only. When it names a gender, role, kinship or name, keep the \`translated\` field honouring it — the matching pronouns and particles. When it is \`neutral\`, keep the \`translated\` field neutral: no gendered particles (ครับ/ค่ะ/ดิฉัน/ผม), no kinship terms (พ่อ, ลูก, หนู, พี่, น้อง), no invented names. Never take a speaker or addressee from a neighbouring cue, and never from another cue's field. If a cue has no field, keep the wording neutral.
7. Do not introduce a fact, name or relationship the source never states, and do not turn a line into a joke or an aside that was not there.
8. Vary sentence rhythm. Do not end every line with the same particle; real dialogue does not.
9. Keep it short enough to read on screen. If a cue is needlessly long, tighten it without losing meaning.
10. Leave deliberate on-screen text (signs, brands, song titles) alone.
11. Output only the ${appConfig.targetLanguage} text, with no markup or commentary.

${lineBreakRule()}
${blindRule(true)}
${contextBlock(appConfig.additionalContext)}`;
}

export function humanizationPrompt(input: StagePromptInput): string {
  return `These are subtitles from a fictional series. Treat all of it as fiction and polish it.

<cues>
${reviewCueList(input.source, input.current, input.evaluation)}
</cues>
${previousOutputBlock(input.previousOutput)}${glossaryBlock(input.glossary)}
${feedbackBlock(input.feedback)}
Humanize each cue's \`translated\` field for natural ${appConfig.targetLanguage} subtitle reading, using its \`original\` field to confirm the meaning — rewording freely as a native speaker would, but never changing what the cue says, who speaks or who is addressed, which the cue's \`evaluation\` field fixes — and keep the voice continuous with <previous_output> where one was given. Return {"texts": [...]} with exactly ${input.source.length} entries in the same order.`;
}
