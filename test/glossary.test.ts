import { describe, expect, test } from "bun:test";
import type { AiClient } from "../src/ai/client";
import { runGlossaryStage } from "../src/pipeline/glossary";
import type { Cue, Dictionary } from "../src/types";

const SOURCE: Cue[] = [
  { index: 1, startMs: 0, endMs: 1000, lines: ["Alice met Bob near Gunsmith"] },
];

const stub = (items: unknown) =>
  ({
    generate: async () => JSON.stringify({ items }),
  }) as unknown as AiClient;

const entry = (name: string, translation: string) => ({
  name,
  type: "character",
  translations: [translation],
});

const run = (dictionary: Dictionary, items: unknown) =>
  runGlossaryStage(stub(items), { source: SOURCE, dictionary });

describe("runGlossaryStage", () => {
  test("collects new terms with lowercase keys, skips empty translations", async () => {
    const found = await run({}, [
      entry("Alice", "อลิซ"),
      { name: "Gunsmith", type: "terminology", translations: [] },
      { name: "Door", type: "terminology" },
    ]);
    expect(Object.keys(found)).toEqual(["alice"]);
    expect(found.alice!.translations).toEqual(["อลิซ"]);
  });

  test("never re-proposes a term the dictionary already has", async () => {
    const found = await run(
      { alice: { type: "character", translations: ["อลิซ"] } },
      [entry("Alice", "โอเล")],
    );
    expect(found).toEqual({});
  });

  test("a hand-edited key survives a re-proposal with different case", async () => {
    // Model always returns lowercase keys, so "Bob" must match a "Bob" the
    // user typed by hand — otherwise the self-edit gets a duplicate shadow.
    const found = await run(
      { Bob: { type: "character", translations: ["บ๊อบ"] } },
      [entry("Bob", "บ๊อบปี้")],
    );
    expect(found).toEqual({});
  });
});
