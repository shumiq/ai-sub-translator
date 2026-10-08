import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDictionary,
  relevantTerms,
  saveDictionary,
} from "../src/dictionary";

describe("relevantTerms", () => {
  const dictionary = {
    hello: { type: "terminology" as const, translations: ["สวัสดี"] },
    bye: { type: "terminology" as const, translations: ["ลาก่อน"] },
  };

  test("keeps only terms that occur in the text, case-insensitively", () => {
    const matched = relevantTerms(dictionary, "Well HELLO there");
    expect(Object.keys(matched)).toEqual(["hello"]);
  });

  test("returns nothing when no term occurs", () => {
    expect(relevantTerms(dictionary, "nothing here")).toEqual({});
  });
});

describe("saveDictionary / loadDictionary", () => {
  test("round-trips sorted keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-sub-dict-"));
    const path = join(dir, "dictionary.json");
    try {
      saveDictionary(path, {
        zeta: { type: "terminology", translations: ["ซ"] },
        alpha: { type: "terminology", translations: ["อ"] },
      });
      const loaded = loadDictionary(path);
      expect(Object.keys(loaded)).toEqual(["alpha", "zeta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or corrupt file loads as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-sub-dict-"));
    try {
      expect(loadDictionary(join(dir, "nope.json"))).toEqual({});
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "not json", "utf8");
      expect(loadDictionary(bad)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
