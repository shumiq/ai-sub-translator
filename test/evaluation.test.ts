import { describe, expect, test } from "bun:test";
import type { AiClient } from "../src/ai/client";
import { runEvaluationStage } from "../src/pipeline/evaluation";
import type { Cue } from "../src/types";

const SOURCE: Cue[] = [
  { index: 1, startMs: 0, endMs: 1000, lines: ["Hola, Juan."] },
  { index: 2, startMs: 1000, endMs: 2000, lines: ["Soy su padre."] },
];

const stub = (items: unknown) =>
  ({
    generate: async () => JSON.stringify({ items }),
  }) as unknown as AiClient;

describe("runEvaluationStage", () => {
  test("maps one evaluation per cue id", async () => {
    const result = await runEvaluationStage(
      stub([
        { id: 1, evaluation: "female to male (Juan)" },
        { id: 2, evaluation: "male" },
      ]),
      { source: SOURCE, chunkSize: 10 },
    );
    expect(result).toEqual({ 1: "female to male (Juan)", 2: "male" });
  });

  test("retries until every cue in the chunk is classified", async () => {
    let calls = 0;
    const client = {
      generate: async () => {
        calls++;
        const items =
          calls === 1
            ? [{ id: 1, evaluation: "neutral" }]
            : [
                { id: 1, evaluation: "neutral" },
                { id: 2, evaluation: "male" },
              ];
        return JSON.stringify({ items });
      },
    } as unknown as AiClient;

    const result = await runEvaluationStage(client, {
      source: SOURCE,
      chunkSize: 10,
    });
    expect(result).toEqual({ 1: "neutral", 2: "male" });
    expect(calls).toBe(2);
  });
});
