import type {
  HardsubStyle,
  PipelineStage,
  ValidationConfig,
} from "./src/types";

export const appConfig = {
  inputDir: "input",
  outputDir: "output",
  assetDir: "assets",
  tempDir: ".temp",
  dictionaryPath: "dictionary.json",

  model: "gemini-flash-lite-latest",
  /** Comma-separated `GEMINI_API_KEY` values; rotated on rate limits. */
  apiKeys: (process.env.GEMINI_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),

  /** Stages to run, in order. */
  pipeline: [
    "extraction",
    "translation",
    "consistency",
    "humanization",
  ] as PipelineStage[],

  /** Cues sent to the model per request. */
  chunkSize: 60,
  /** Cues of already-finalised context appended before each chunk. */
  previousCueCount: 25,
  temperature: 0.3,
  /** "off" | "low" | "medium" | "high" — gemini-flash-lite defaults to "off". */
  thinking: "low" as "off" | "low" | "medium" | "high",

  /** Cues per request for the dictionary-extraction stage. */
  extractionChunkSize: 400,

  sourceLanguage: "English",
  targetLanguage: "Thai",
  /** Domain hints appended to every prompt. */
  additionalContext: [] as string[],

  validation: {
    retriesLimit: 3,
    cueCount: true,
    emptyText: true,
    isThai: true,
    leftoverSource: true,
    /**
     * Off by default. When on, a mismatched cue is fatal rather than
     * advisory: it is rejected, retried, bisected, and ultimately aborts the
     * file if it cannot be made to fit. That is the right call only if you
     * want the source's break points preserved exactly, because a cue the
     * model cannot re-break to spec takes the whole file down with it
     * (invariant 3). Off, the prompt lets the model re-break for Thai and
     * asks for at most two lines.
     */
    lineCountPerCue: false,
  } as ValidationConfig,

  retry: {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 60000,
  },

  hardsub: {
    videoBitrate: "2M",
    videoBufSize: "4M",
    audioBitrate: "192k",
    preset: "slow",
    /** Keep the original soft subtitle tracks alongside the burned-in ones. */
    keepOriginalSubtitles: false,
    style: {
      // "Mali Medium" is the Win32 family name of Mali-Medium.ttf. Note that
      // plain "Mali" silently resolves to the *Regular* face instead, so the
      // weight has to be spelled out here.
      fontName: "Mali Medium",
      fontSize: 24,
      playResX: 1920,
      playResY: 1080,
      bold: false,
      italic: false,
      primaryColour: "&H00FFFFFF",
      outlineColour: "&H00000000",
      outline: 2,
      shadow: 1,
      alignment: 2,
      marginL: 60,
      marginR: 60,
      marginV: 40,
      spacing: 0,
    } as HardsubStyle,
  },
};
