import type { Cue } from "../types";
import {
  parseAss,
  stringifyAss,
  type AssDescriptor,
  type AssSection,
} from "../vendor";
import { stripInlineTags } from "./srt";

const ASS_TIMING = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/;

function assTimeToMs(time: string): number {
  const match = time.trim().match(ASS_TIMING);
  if (!match) return Number.NaN;
  const [h, m, s, cs] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  // The fourth field is centiseconds, not milliseconds.
  return h * 3_600_000 + m * 60_000 + s * 1000 + cs * 10;
}

/** `\N` is a hard break, `\n` a soft one, `\h` a hard space. */
function assTextToLines(text: string): string[] {
  return text
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .split("\n")
    .map(stripInlineTags)
    .filter((line) => line.length > 0);
}

/**
 * Converts an ASS/SSA script to cues. Only `Dialogue` events carry text;
 * `Comment` events and karaoke/positioning metadata are discarded.
 */
export function assToCues(text: string): Cue[] {
  const sections: AssSection[] = parseAss(text);
  const events = sections.find((section) => /^events$/i.test(section.section));
  if (!events) return [];

  const cues: Cue[] = [];

  for (const descriptor of events.body) {
    if (descriptor.key.toLowerCase() !== "dialogue") continue;
    if (typeof descriptor.value !== "object" || descriptor.value === null)
      continue;

    const fields = descriptor.value as Record<string, string>;
    const startMs = assTimeToMs(fields.Start ?? "");
    const endMs = assTimeToMs(fields.End ?? "");
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    const lines = assTextToLines(fields.Text ?? "");
    if (lines.length === 0) continue;

    cues.push({ index: cues.length + 1, startMs, endMs, lines });
  }

  return cues;
}

const STYLE_FORMAT = [
  "Name",
  "Fontname",
  "Fontsize",
  "PrimaryColour",
  "SecondaryColour",
  "OutlineColour",
  "BackColour",
  "Bold",
  "Italic",
  "Underline",
  "StrikeOut",
  "ScaleX",
  "ScaleY",
  "Spacing",
  "Angle",
  "BorderStyle",
  "Outline",
  "Shadow",
  "Alignment",
  "MarginL",
  "MarginR",
  "MarginV",
  "Encoding",
];

const EVENT_FORMAT = [
  "Layer",
  "Start",
  "End",
  "Style",
  "Name",
  "MarginL",
  "MarginR",
  "MarginV",
  "Effect",
  "Text",
];

const msToAssTime = (ms: number) => {
  const clamped = Math.max(0, ms);
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const centis = Math.floor((clamped % 1000) / 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
};

export interface AssBuildOptions {
  title: string;
  style: {
    fontName: string;
    fontSize: number;
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
    spacing: number;
  };
}

/**
 * Renders cues as a single-style ASS script ready for libass burn-in.
 * A BOM is emitted because libass mis-detects Thai text in some builds.
 */
export function cuesToAss(cues: Cue[], options: AssBuildOptions): string {
  const style = options.style;
  const boolean = (value: boolean) => (value ? "-1" : "0");

  const sections: AssSection[] = [
    {
      section: "Script Info",
      body: [
        { key: "Title", value: options.title },
        { key: "ScriptType", value: "v4.00+" },
        { key: "WrapStyle", value: "0" },
        { key: "ScaledBorderAndShadow", value: "yes" },
        { key: "YCbCr Matrix", value: "None" },
        { key: "PlayResX", value: String(style.playResX) },
        { key: "PlayResY", value: String(style.playResY) },
      ],
    },
    {
      section: "V4+ Styles",
      body: [
        { key: "Format", value: STYLE_FORMAT },
        {
          key: "Style",
          value: {
            Name: "Default",
            Fontname: style.fontName,
            Fontsize: String(style.fontSize),
            PrimaryColour: style.primaryColour,
            SecondaryColour: "&H000000FF",
            OutlineColour: style.outlineColour,
            BackColour: "&H00000000",
            Bold: boolean(style.bold),
            Italic: boolean(style.italic),
            Underline: "0",
            StrikeOut: "0",
            ScaleX: "100",
            ScaleY: "100",
            Spacing: String(style.spacing),
            Angle: "0",
            BorderStyle: "1",
            Outline: String(style.outline),
            Shadow: String(style.shadow),
            Alignment: String(style.alignment),
            MarginL: String(style.marginL),
            MarginR: String(style.marginR),
            MarginV: String(style.marginV),
            Encoding: "1",
          },
        },
      ],
    },
    {
      section: "Events",
      body: [
        { key: "Format", value: EVENT_FORMAT },
        ...cues.map((cue) => ({
          key: "Dialogue",
          value: {
            Layer: "0",
            Start: msToAssTime(cue.startMs),
            End: msToAssTime(cue.endMs),
            Style: "Default",
            Name: "",
            MarginL: "0",
            MarginR: "0",
            MarginV: "0",
            Effect: "",
            Text: cue.lines.join("\\N"),
          },
        })),
      ],
    },
  ];

  return `\uFEFF${stringifyAss(sections)}`;
}

/** Inline blocks that place a line on screen rather than merely style it. */
const LAYOUT_TAG =
  /\\(?:pos\b|move\b|an\d|org\b|q\d|fscx|fscy|frz\b|fax\b|fay\b)/;

/**
 * The positioning overrides worth carrying over from a source line: `\pos`,
 * `\an`, `\q` and friends say *where* the line goes, which is exactly the
 * information SRT throws away. Font overrides are dropped — the burn-in font
 * is chosen once, in config, not per sign.
 */
function positionPrefix(sourceText: string): string {
  const blocks = sourceText.match(/\{\\[^}]*\}/g) ?? [];
  return blocks
    .filter((block) => LAYOUT_TAG.test(block))
    .map((block) => block.replace(/\\fn[^\\}]*/g, ""))
    .join("");
}

export interface RetextOptions {
  /**
   * Family forced onto every style. The source script's fonts are whatever
   * the typesetter happened to have installed; the burn-in font is ours.
   */
  fontName: string;
  /** Outline and shadow applied to every style — sources mix 0 to 3. */
  outline: number;
  shadow: number;
  /** Added to every style's size, in the source script's own units. */
  fontSizeStep: number;
}

/**
 * Rebuilds an original ASS script with translated cue text: same script info,
 * same styles, same events — only the words change. Returns `null` when the
 * cues cannot be matched 1:1 onto the script's dialogue lines, so the caller
 * can fall back to a freshly generated script instead of guessing.
 *
 * Matching is by timestamp because that is the one thing the pipeline never
 * lets the model touch (invariant 1): every cue's `startMs` came from this
 * very script.
 */
export function retextAss(
  original: string,
  cues: Cue[],
  options: RetextOptions,
): string | null {
  const sections: AssSection[] = parseAss(original.replace(/^\uFEFF/, ""));

  for (const section of sections) {
    for (const descriptor of section.body) {
      if (!/^style$/i.test(descriptor.key)) continue;
      if (typeof descriptor.value !== "object" || descriptor.value === null)
        continue;
      const fields = descriptor.value as Record<string, string>;
      fields.Fontname = options.fontName;
      fields.Outline = String(options.outline);
      fields.Shadow = String(options.shadow);
      const size = Number(fields.Fontsize);
      if (Number.isFinite(size)) {
        fields.Fontsize = String(Math.round(size + options.fontSizeStep));
      }
    }
  }

  const events = sections.find((section) => /^events$/i.test(section.section));
  if (!events) return null;

  interface Row {
    descriptor: AssDescriptor;
    endMs: number;
    text: string;
  }
  const byStart = new Map<number, Row[]>();

  for (const descriptor of events.body) {
    if (!/^dialogue$/i.test(descriptor.key)) continue;
    if (typeof descriptor.value !== "object" || descriptor.value === null)
      continue;
    const fields = descriptor.value as Record<string, string>;
    const startMs = assTimeToMs(fields.Start ?? "");
    const endMs = assTimeToMs(fields.End ?? "");
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    const row: Row = { descriptor, endMs, text: fields.Text ?? "" };
    const bucket = byStart.get(startMs);
    if (bucket) bucket.push(row);
    else byStart.set(startMs, [row]);
  }

  const used = new Set<AssDescriptor>();
  for (const cue of cues) {
    const bucket = byStart.get(cue.startMs);
    if (!bucket) return null;
    // Several events can share a start (stacked signs); prefer the exact end,
    // then take the next unused one in file order.
    const row =
      bucket.find((r) => !used.has(r.descriptor) && r.endMs === cue.endMs) ??
      bucket.find((r) => !used.has(r.descriptor));
    if (!row) return null;
    used.add(row.descriptor);
    (row.descriptor.value as Record<string, string>).Text =
      positionPrefix(row.text) + cue.lines.join("\\N");
  }

  // Dialogue lines the translated SRT never carried (blank once tags are
  // stripped) would otherwise burn the untranslated source text.
  events.body = events.body.filter(
    (descriptor) => !/^dialogue$/i.test(descriptor.key) || used.has(descriptor),
  );

  return `\uFEFF${stringifyAss(sections)}`;
}
