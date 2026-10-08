import { afterEach, describe, expect, test } from "bun:test";
import { appConfig } from "../config";
import {
  consistencySystem,
  extractionPrompt,
  extractionSystem,
  humanizationPrompt,
  humanizationSystem,
  translationPrompt,
  translationSystem,
  type StagePromptInput,
} from "../src/prompts";
import type { Cue } from "../src/types";

const cue = (index: number, text: string): Cue => ({
  index,
  startMs: index * 1000,
  endMs: index * 1000 + 500,
  lines: [text],
});

const input = (
  overrides: Partial<StagePromptInput> = {},
): StagePromptInput => ({
  source: [cue(1, "Hola"), cue(2, "Adiós")],
  current: [cue(1, "สวัสดี"), cue(2, "ลาก่อน")],
  context: [],
  previousOutput: [],
  glossary: {},
  feedback: null,
  ...overrides,
});

describe("system prompts", () => {
  test("every stage carries the blind-input rule", () => {
    for (const system of [
      extractionSystem(),
      translationSystem(),
      consistencySystem(),
      humanizationSystem(),
    ]) {
      expect(system).toContain("BLIND INPUT");
    }
  });

  test("gendered forms are gated on evidence", () => {
    expect(translationSystem()).toContain("solid evidence");
    expect(translationSystem()).toContain("ฉัน, เรา, คุณ");
    expect(consistencySystem()).toContain("strip gendered particles");
  });

  test("speaker is never read off neighbouring cues or previous output", () => {
    for (const system of [
      translationSystem(),
      consistencySystem(),
      humanizationSystem(),
    ]) {
      expect(system).toContain("BLIND INPUT");
      expect(system).toContain("per cue");
    }
    expect(translationSystem()).toContain("kinship");
    expect(humanizationSystem()).toContain("kinship");
    const prompt = translationPrompt(
      input({ previousOutput: [{ id: 0, text: "ลูกกลับมาแล้วค่ะ" }] }),
    );
    expect(prompt).toContain("not evidence about who speaks");
  });

  test("extraction refuses to guess gender or roles", () => {
    expect(extractionSystem()).toContain("Never guess from how a name sounds");
    expect(extractionSystem()).toContain("Do not infer relationships or roles");
  });
});

describe("line break rule follows the flag", () => {
  const saved = appConfig.validation.lineCountPerCue;
  afterEach(() => {
    appConfig.validation.lineCountPerCue = saved;
  });

  test("on: exact line counts demanded", () => {
    appConfig.validation.lineCountPerCue = true;
    expect(translationSystem()).toContain("exactly the same number of lines");
    expect(translationSystem()).not.toContain("splitting them further is fine");
  });

  test("off: re-breaking allowed, empties still forbidden", () => {
    appConfig.validation.lineCountPerCue = false;
    expect(translationSystem()).toContain("splitting them further is fine");
    expect(translationSystem()).toContain("never leave a cue empty");
  });
});

describe("stage prompts", () => {
  test("translation feeds the source cues as JSON", () => {
    const prompt = translationPrompt(input());
    expect(prompt).toContain("<input>");
    expect(prompt).toContain('"Hola"');
    expect(prompt).toContain("exactly 2 entries");
  });

  test("review stages feed original next to translated", () => {
    const prompt = humanizationPrompt(input());
    expect(prompt).toContain("<original>");
    expect(prompt).toContain("<translated>");
    expect(prompt).toContain("who speaks or who is addressed");
  });

  test("previous output block appears only when output exists", () => {
    expect(humanizationPrompt(input())).not.toContain("Already-translated");
    expect(
      humanizationPrompt(input({ previousOutput: [{ id: 1, text: "แปล1" }] })),
    ).toContain("Already-translated");
  });

  test("correction feedback is wrapped for the model", () => {
    const prompt = humanizationPrompt(input({ feedback: "fix cue 1" }));
    expect(prompt).toContain("<correction_required>");
    expect(prompt).toContain("fix cue 1");
  });

  test("extraction tells the model user-pinned entries are final", () => {
    expect(extractionPrompt(input())).toContain("pinned by the user");
  });
});
