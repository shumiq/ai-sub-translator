import { describe, expect, test } from "bun:test";
import { appConfig } from "../config";
import { retextAss } from "../src/subtitle/ass";

const FIXTURE = [
  "[Script Info]",
  "Title: fixture",
  "ScriptType: v4.00+",
  "PlayResX: 640",
  "PlayResY: 360",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Impact,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0.3,2,10,10,10,1",
  "Style: Sign,Mali,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,1,8,10,10,10,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\pos(100,50)}Hello there.",
  "Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\pos(10,10)}Stacked sign",
  "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Leftover source line",
].join("\n");

// Two cues share a start (stacked signs): the exact-end match must win.
const CUES = [
  { index: 1, startMs: 1000, endMs: 2000, lines: ["แปลเครื่องหมาย"] },
  { index: 2, startMs: 1000, endMs: 3000, lines: ["แปลบทสนทนา"] },
];

// The expected face comes from config, never a literal: swapping the bundled
// font must not require touching this file (invariant 5).
const OPTIONS = {
  fontName: appConfig.hardsub.style.fontName,
  outline: appConfig.hardsub.style.outline,
  shadow: appConfig.hardsub.style.shadow,
  fontSizeStep: appConfig.hardsub.inheritedFontSizeStep,
};

describe("retextAss", () => {
  test("rewrites translated text into the inherited script", () => {
    const result = retextAss(FIXTURE, CUES, OPTIONS);
    expect(result).not.toBeNull();
    expect(result!).toContain("{\\an8\\pos(100,50)}แปลบทสนทนา");
    expect(result!).toContain("{\\pos(10,10)}แปลเครื่องหมาย");
  });

  test("forces the burn-in font onto every style, drops \\fn overrides", () => {
    const result = retextAss(FIXTURE, CUES, OPTIONS);
    expect(result!).toContain(OPTIONS.fontName);
    expect(result!).not.toContain("Impact");
    expect(result!).not.toContain("\\fn");
  });

  test("drops dialogue that no cue matches", () => {
    const result = retextAss(FIXTURE, CUES, OPTIONS);
    expect(result!).not.toContain("Leftover source line");
  });

  test("keeps the UTF-8 BOM for libass", () => {
    const result = retextAss(FIXTURE, CUES, OPTIONS);
    expect(result!.charCodeAt(0)).toBe(0xfeff);
  });

  test("returns null instead of guessing when a cue does not match", () => {
    expect(
      retextAss(
        FIXTURE,
        [...CUES, { index: 3, startMs: 9999, endMs: 10999, lines: ["x"] }],
        OPTIONS,
      ),
    ).toBeNull();
  });
});
