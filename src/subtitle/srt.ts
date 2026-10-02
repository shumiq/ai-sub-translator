import type { Cue } from "../types";

const CUE_TIMING = new RegExp(
  "(\\d{1,4}):(\\d{1,2}):(\\d{1,2})[,.](\\d{1,3})\\s*-->\\s*(\\d{1,4}):(\\d{1,2}):(\\d{1,2})[,.](\\d{1,3})",
);

/** ASS/SSA styled subrip tags and inline HTML markup, both of which we drop. */
const INLINE_TAGS = /\{\\[^}]*\}|<\/?[a-zA-Z][^>]*>|<br\s*\/?>|\{\\[a-zA-Z]+/g;

export function stripInlineTags(text: string): string {
  return text
    .replace(INLINE_TAGS, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .trim();
}

function pad(value: number, length: number) {
  return String(value).padStart(length, "0");
}

/** `12:34:56,789` — the only timestamp dialect SRT consumers agree on. */
export function formatSrtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

function toMs(match: RegExpMatchArray, offset: number): number {
  const [h, m, s, ms] = match.slice(offset, offset + 4).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return h * 3_600_000 + m * 60_000 + s * 1000 + ms;
}

/**
 * Lenient SRT reader: tolerates a BOM, CRLF, missing or non-sequential cue
 * numbers, and blocks separated by more than one blank line.
 */
export function parseSrt(text: string): Cue[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length < 2) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const match = lines[timingIndex]?.match(CUE_TIMING);
    if (!match) continue;

    const body = lines
      .slice(timingIndex + 1)
      .map(stripInlineTags)
      .filter((line) => line.length > 0);
    if (body.length === 0) continue;

    cues.push({
      index: cues.length + 1,
      startMs: toMs(match, 1),
      endMs: toMs(match, 5),
      lines: body,
    });
  }

  return cues;
}

export function stringifySrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (cue, position) =>
          `${position + 1}\n` +
          `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n` +
          `${cue.lines.join("\n")}`,
      )
      .join("\n\n") + "\n"
  );
}
