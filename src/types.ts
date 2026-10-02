export type PipelineStage =
  "extraction" | "translation" | "consistency" | "humanization";

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
  /** Report (but do not fail on) a changed line count inside a cue. */
  lineCountPerCue: boolean;
}

export interface HardsubStyle {
  /**
   * ASS font family name. Mali's weights ship as separate families, so the
   * weight must be spelled out: "Mali Medium", not "Mali".
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
