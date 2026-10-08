import { afterEach, describe, expect, test } from "bun:test";
import { appConfig } from "../config";
import type { Cue } from "../src/types";
import { validateChunk } from "../src/validate";

const cue = (index: number, ...lines: string[]): Cue => ({
  index,
  startMs: index * 1000,
  endMs: index * 1000 + 500,
  lines,
});

const saved = { ...appConfig.validation };
afterEach(() => {
  Object.assign(appConfig.validation, saved);
});

describe("validateChunk", () => {
  test("a good chunk passes", () => {
    appConfig.validation.cueCount = true;
    appConfig.validation.emptyText = true;
    expect(validateChunk([cue(1, "Hi")], ["สวัสดี"], "t")).toBeNull();
  });

  test("cue count mismatch names the counts", () => {
    appConfig.validation.cueCount = true;
    const reason = validateChunk([cue(1, "Hi"), cue(2, "Bye")], ["ok"], "t");
    expect(reason).toContain("expected 2, received 1");
  });

  test("empty output for a translatable cue is rejected", () => {
    appConfig.validation.emptyText = true;
    expect(validateChunk([cue(1, "Hi")], ["   "], "t")).toContain(
      "Empty output",
    );
  });

  test("symbol-only source cue is exempt from all text checks", () => {
    appConfig.validation.emptyText = true;
    appConfig.validation.lineCountPerCue = true;
    expect(validateChunk([cue(1, "♪")], ["anything\nhere"], "t")).toBeNull();
  });

  test("line count rule follows the flag", () => {
    appConfig.validation.emptyText = true;
    appConfig.validation.lineCountPerCue = true;
    const source = [cue(1, "one line")];
    expect(validateChunk(source, ["a\nb"], "t")).toContain(
      "line count changed from 1 to 2",
    );

    appConfig.validation.lineCountPerCue = false;
    expect(validateChunk(source, ["a\nb"], "t")).toBeNull();
  });
});
