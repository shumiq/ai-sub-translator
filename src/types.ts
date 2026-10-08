export type PipelineStage =
  "extraction" | "evaluation" | "translation" | "consistency" | "humanization";

/**
 * Per-cue classification from the evaluation stage — who speaks and who is
 * addressed, keyed by source cue index. A plain string so the model can say
 * "male to female", "father to daughter (Ana)" or just "neutral". It only ever
 * describes the cue it is keyed to; the pipeline never lets it bleed sideways.
 */
export type Evaluation = Record<number, string>;

/** One subtitle cue: timings plus its display lines. */
export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  lines: string[];
}

export interface DictionaryExample {
  input: string;
  output: string;
}

export interface DictionaryEntry {
  type: "character" | "terminology";
  translations: string[];
  description?: string;
  gender?: "male" | "female" | "neutral";
  speakingStyle?: string;
  prohibitedPhrases?: string[];
  example?: DictionaryExample[];
}

/** Shared glossary, keyed by the lowercased source-language term. */
export type Dictionary = Record<string, DictionaryEntry>;

export interface ValidationConfig {
  /** Attempts per chunk before it is bisected. 0 falls back to 3. */
  retriesLimit: number;
  /** Output must contain exactly one entry per input cue. */
  cueCount: boolean;
  /** Output cues must not be empty when the source cue is not empty. */
  emptyText: boolean;
  /** Output must actually be Thai rather than a copy of the source. */
  isThai: boolean;
  /** Long untranslated stretches of source-language text. */
  leftoverSource: boolean;
  /**
   * When on, a cue must keep the source's line count — fatal, because the
   * original timings only make sense for the break points the source file was
   * authored with. Off by default: the prompt then lets the model re-break.
   */
  lineCountPerCue: boolean;
}

export interface HardsubStyle {
  /**
   * ASS font family name, as reported by the font's name table — libass
   * falls back silently when it does not match the file in `assetDir`.
   */
  fontName: string;
  fontSize: number;
  /** Resolution the ASS script is authored against; libass scales to the video. */
  playResX: number;
  playResY: number;
  bold: boolean;
  italic: boolean;
  primaryColour: string;
  outlineColour: string;
  outline: number;
  shadow: number;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
  /** Character spacing, in pixels. */
  spacing: number;
}
