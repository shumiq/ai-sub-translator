import { afterEach, describe, expect, test } from "bun:test";
import { appConfig } from "../config";
import {
  evaluationSystem,
  extractionPrompt,
  extractionSystem,
  humanizationPrompt,
  humanizationSystem,
  translationPrompt,
  translationSystem,
  verificationPrompt,
  verificationSystem,
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
  evaluation: [],
  glossary: {},
  feedback: null,
  ...overrides,
});

describe("system prompts", () => {
  test("every stage carries the blind-input rule", () => {
    for (const system of [
      extractionSystem(),
      evaluationSystem(),
      translationSystem(),
      humanizationSystem(),
      verificationSystem(),
    ]) {
      expect(system).toContain("BLIND INPUT");
    }
  });

  test("gendered forms are gated on the evaluation field", () => {
    expect(translationSystem()).toContain("SPEAKER IS GIVEN");
    expect(translationSystem()).toContain("ฉัน, เรา, คุณ");
    expect(verificationSystem()).toContain("contradicts the field");
  });

  test("speaker still comes from the evaluation field, never neighbours", () => {
    for (const system of [
      translationSystem(),
      humanizationSystem(),
      verificationSystem(),
    ]) {
      expect(system).toContain("BLIND INPUT");
      expect(system).toContain("evaluation");
    }
    expect(translationSystem()).toContain("Never read a speaker");
    expect(translationSystem()).toContain("kinship");
    expect(humanizationSystem()).toContain("kinship");
    const prompt = translationPrompt(
      input({ previousOutput: [{ id: 0, text: "ลูกกลับมาแล้วค่ะ" }] }),
    );
    expect(prompt).toContain("Match its terminology and register");
  });

  test("translation reads for naturalness, not word-for-word", () => {
    expect(translationSystem()).toContain("reads as if a native");
    expect(translationSystem()).toContain("Translate meaning, not words");
    expect(translationSystem()).not.toContain("equally ambiguous");
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

  test("review stages pair original and translated per cue", () => {
    for (const prompt of [
      humanizationPrompt(input()),
      verificationPrompt(input()),
    ]) {
      expect(prompt).toContain("<cues>");
      expect(prompt).toContain('"original": "Hola"');
      expect(prompt).toContain('"translated": "สวัสดี"');
    }
    expect(humanizationPrompt(input())).toContain(
      "who speaks or who is addressed",
    );
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

  test("evaluation verdicts are attached to the cues in later stages", () => {
    const evaluated = input({
      evaluation: [{ id: 1, text: "male to female" }],
    });
    expect(translationPrompt(evaluated)).toContain(
      '"evaluation": "male to female"',
    );
    expect(translationPrompt(evaluated)).toContain('"evaluation": "neutral"');
    expect(humanizationPrompt(evaluated)).toContain(
      '"evaluation": "male to female"',
    );
    expect(translationSystem()).toContain("evaluation");
  });
});
