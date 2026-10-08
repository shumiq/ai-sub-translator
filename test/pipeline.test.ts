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

const run = (client: AiClient) =>
  runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath: "unused.json",
    stages: ["translation"],
  });

const savedRetries = appConfig.validation.retriesLimit;
afterEach(() => {
  appConfig.validation.retriesLimit = savedRetries;
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
});
