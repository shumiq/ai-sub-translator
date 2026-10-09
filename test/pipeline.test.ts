import { afterEach, describe, expect, test } from "bun:test";
import { appConfig } from "../config";
import type { AiClient } from "../src/ai/client";
import { runPipeline } from "../src/pipeline";
import { parseSrt } from "../src/subtitle/srt";

const CUES = parseSrt(
  [
    "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n",
    "2\n00:00:03,500 --> 00:00:05,000\nAre you serious?\n\n",
    "3\n00:00:05,500 --> 00:00:07,000\nI have no idea.\n\n",
  ].join(""),
);

const stub = (texts: string[]): AiClient =>
  ({
    generate: async () => JSON.stringify({ texts }),
  }) as unknown as AiClient;

/** Returns each response in turn; keeps replaying the last once exhausted. */
const scripted = (responses: unknown[]): AiClient => {
  let cursor = 0;
  return {
    generate: async () => {
      const value = responses[Math.min(cursor++, responses.length - 1)];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  } as unknown as AiClient;
};

const run = (client: AiClient) =>
  runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath: "unused.json",
    stages: ["translation"],
  });

// A fresh clone on every restore: tests mutate `appConfig.verification` in
// place, so handing back a shared object would let one test's knobs leak into
// the next.
const savedRetries = appConfig.validation.retriesLimit;
const savedVerification = { ...appConfig.verification };
afterEach(() => {
  appConfig.validation.retriesLimit = savedRetries;
  appConfig.verification = { ...savedVerification };
});

describe("runPipeline", () => {
  test("timings come from the source, the model only supplies text", async () => {
    const out = await run(stub(["แปล1", "แปล2", "แปล3"]));
    expect(out).toHaveLength(3);
    expect(out[1]!.lines).toEqual(["แปล2"]);
    expect(out[1]!.startMs).toBe(3500);
    expect(out[1]!.endMs).toBe(5000);
  });

  test("aborts instead of writing a lossy file", async () => {
    appConfig.validation.retriesLimit = 1;
    await expect(run(stub(["ตอบ1", "ตอบ2"]))).rejects.toThrow();
  });

  test("sends neighbours for context but keeps only the drifted cue's fix", async () => {
    appConfig.verification.neighborCount = 1;
    const client = scripted([
      {
        items: [
          { id: 1, evaluation: "neutral" },
          { id: 2, evaluation: "male" },
          { id: 3, evaluation: "neutral" },
        ],
      },
      { texts: ["หนึ่ง", "สอง", "สาม"] },
      {
        items: [
          { id: 1, ok: true },
          { id: 2, ok: false, reason: "meaning changed" },
          { id: 3, ok: true },
        ],
      },
      // Repairs the whole window (cues 1-3), but only cue 2's is kept.
      { texts: ["หนึ่งแก้", "สองแก้", "สามแก้"] },
      { items: [{ id: 2, ok: true }] },
    ]);

    const out = await runPipeline(CUES, {
      client,
      dictionary: {},
      dictionaryPath: "unused.json",
      stages: ["evaluation", "humanization"],
    });

    expect(out[0]!.lines).toEqual(["หนึ่ง"]);
    expect(out[1]!.lines).toEqual(["สองแก้"]);
    expect(out[2]!.lines).toEqual(["สาม"]);
  });

  test("re-audits only the drifted cues, so drift can only shrink", async () => {
    appConfig.verification.neighborCount = 0;
    const client = scripted([
      {
        items: [
          { id: 1, evaluation: "neutral" },
          { id: 2, evaluation: "male" },
          { id: 3, evaluation: "neutral" },
        ],
      },
      { texts: ["หนึ่ง", "สอง", "สาม"] },
      {
        items: [
          { id: 1, ok: true },
          { id: 2, ok: false, reason: "meaning changed" },
          { id: 3, ok: false, reason: "meaning changed" },
        ],
      },
      { texts: ["สองแก้", "สามแก้"] },
      {
        items: [
          { id: 2, ok: true },
          { id: 3, ok: false, reason: "still wrong" },
        ],
      },
      { texts: ["สามแก้2"] },
      { items: [{ id: 3, ok: true }] },
    ]);

    const out = await runPipeline(CUES, {
      client,
      dictionary: {},
      dictionaryPath: "unused.json",
      stages: ["evaluation", "humanization"],
    });

    expect(out.map((cue) => cue.lines.join(""))).toEqual([
      "หนึ่ง",
      "สองแก้",
      "สามแก้2",
    ]);
  });

  test("stops after maxRounds stalled rounds but still writes the output", async () => {
    appConfig.verification.neighborCount = 0;
    appConfig.verification.maxRounds = 2;
    const client = scripted([
      {
        items: [
          { id: 1, evaluation: "neutral" },
          { id: 2, evaluation: "male" },
          { id: 3, evaluation: "neutral" },
        ],
      },
      { texts: ["หนึ่ง", "สอง", "สาม"] },
      {
        items: [
          { id: 1, ok: true },
          { id: 2, ok: false, reason: "meaning changed" },
          { id: 3, ok: true },
        ],
      },
      { texts: ["สองแย่"] },
      { items: [{ id: 2, ok: false, reason: "still wrong" }] },
      { texts: ["สองแย่2"] },
      { items: [{ id: 2, ok: false, reason: "still wrong" }] },
    ]);

    const out = await runPipeline(CUES, {
      client,
      dictionary: {},
      dictionaryPath: "unused.json",
      stages: ["evaluation", "humanization"],
    });

    expect(out[1]!.lines).toEqual(["สองแย่2"]);
  });
});
