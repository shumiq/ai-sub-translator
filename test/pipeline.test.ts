/**
 * Pipeline regression tests. These run with no network access: the Gemini
 * client is replaced by a stub so the parts that are easy to break — the
 * retry-on-feedback loop, malformed-response recovery and chunk bisection —
 * are covered without spending a single token.
 *
 *   bun run test
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appConfig } from "../config";
import type { AiClient } from "../src/ai/client";
import { runPipeline } from "../src/pipeline";
import { extractJson, toTextArray } from "../src/pipeline/stage";
import { parseSrt } from "../src/subtitle/srt";

let failures = 0;
const check = (name: string, passed: boolean, detail = "") => {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const CUES = parseSrt(
  [
    "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n",
    "2\n00:00:03,500 --> 00:00:05,000\nAre you serious?\n\n",
    "3\n00:00:05,500 --> 00:00:07,000\nI have no idea.\n\n",
  ].join(""),
);

const ok = (texts: string[]) => JSON.stringify({ texts });
const inputIds = (prompt: string) =>
  JSON.parse(prompt.match(/<input>\n([\s\S]*?)\n<\/input>/)![1]!) as {
    id: number;
    text: string;
  }[];

function stubClient(handler: (prompt: string, call: number) => string) {
  const prompts: string[] = [];
  const client = {
    async generate(request: { prompt: string }) {
      prompts.push(request.prompt);
      return handler(request.prompt, prompts.length - 1);
    },
  } as unknown as AiClient;
  return { client, prompts };
}

const tempDir = mkdtempSync(join(tmpdir(), "ai-sub-test-"));
const dictionaryPath = join(tempDir, "dictionary.json");

console.log("\nresponse parsing");
check("plain object", typeof extractJson('{"texts":["a"]}') === "object");
check(
  "fenced block",
  Array.isArray(
    (extractJson('```json\n{"texts":["a"]}\n```') as { texts: string[] }).texts,
  ),
);
check(
  "prose around payload",
  Array.isArray(
    (extractJson('Here you go:\n{"texts":["x"]}\nDone.') as { texts: string[] })
      .texts,
  ),
);
check("bare array", Array.isArray(extractJson('["a","b"]')));
check(
  "rejects non-JSON",
  (() => {
    try {
      extractJson("no json at all");
      return false;
    } catch {
      return true;
    }
  })(),
);
check("object form", toTextArray({ texts: ["a"] })[0] === "a");
check("array form", toTextArray(["a"])[0] === "a");
check("object items", toTextArray([{ text: "a" }])[0] === "a");
check(
  "rejects wrong shape",
  (() => {
    try {
      toTextArray({ nope: 1 });
      return false;
    } catch {
      return true;
    }
  })(),
);

console.log("\nhappy path");
{
  const { client, prompts } = stubClient((prompt) =>
    ok(inputIds(prompt).map((cue) => `แปล${cue.id}`)),
  );
  const out = await runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["translation"],
  });
  check(
    "single request for a small file",
    prompts.length === 1,
    `got ${prompts.length}`,
  );
  check("cue count preserved", out.length === CUES.length, `got ${out.length}`);
  check(
    "texts applied in order",
    out[1]!.lines[0] === "แปล2",
    out[1]!.lines[0],
  );
  check(
    "timings copied from source, never from the model",
    out[1]!.startMs === 3500 && out[1]!.endMs === 5000,
    `${out[1]!.startMs}-${out[1]!.endMs}`,
  );
}

console.log("\nretry with validator feedback");
{
  let retryPrompt = "";
  const { client, prompts } = stubClient((prompt) => {
    const retried = prompt.includes("<correction_required>");
    if (retried) retryPrompt = prompt;
    return ok(
      inputIds(prompt).map((cue) => (retried ? `คำตอบ${cue.id}` : "Hello")),
    );
  });
  const out = await runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["translation"],
  });
  check(
    "untranslated output is rejected and retried",
    prompts.length === 2,
    `got ${prompts.length}`,
  );
  check(
    "the validator's reason is fed back to the model",
    retryPrompt.includes("<correction_required>") &&
      retryPrompt.includes("contains no Thai characters"),
    "feedback block missing",
  );
  check(
    "retry result is used",
    out[0]!.lines[0] === "คำตอบ1",
    out[0]!.lines[0],
  );
}

console.log("\nmalformed response recovery");
{
  const { client, prompts } = stubClient((_, call) =>
    call === 0 ? "I could not comply, sorry!" : ok(["ตอบ1", "ตอบ2", "ตอบ3"]),
  );
  const out = await runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["translation"],
  });
  check(
    "garbage response triggers a retry",
    prompts.length === 2,
    `got ${prompts.length}`,
  );
  check(
    "recovered after the retry",
    out[2]!.lines[0] === "ตอบ3",
    out[2]!.lines[0],
  );
}

console.log("\nrefusing to write a lossy file");
{
  // Always one entry short, so the full chunk can never validate.
  const { client } = stubClient(() => ok(["ตอบ1", "ตอบ2"]));
  let failed = false;
  try {
    await runPipeline(CUES, {
      client,
      dictionary: {},
      dictionaryPath,
      stages: ["translation"],
    });
  } catch {
    failed = true;
  }
  check("aborts rather than silently dropping a cue", failed);
}

console.log("\nbisection");
{
  // Two cues in one chunk. While both are in scope the stub returns a
  // one-entry array, which can never validate; asked for a single cue it
  // answers correctly. The runner must split the chunk to make progress.
  const two = CUES.slice(0, 2);
  const { client, prompts } = stubClient((prompt) => {
    const ids = inputIds(prompt);
    return ids.length === 1 ? ok([`ตอบ${ids[0]!.id}`]) : ok(["ตอบ1"]);
  });
  const out = await runPipeline(two, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["translation"],
  });
  check("both cues survive the split", out.length === 2, `got ${out.length}`);
  check("first cue translated", out[0]!.lines[0] === "ตอบ1", out[0]!.lines[0]);
  check("second cue translated", out[1]!.lines[0] === "ตอบ2", out[1]!.lines[0]);
  check(
    "timings still match the source after splitting",
    out[1]!.startMs === 3500 && out[1]!.endMs === 5000,
  );
  check(
    "took more than one request",
    prompts.length > 1,
    `got ${prompts.length}`,
  );
}

console.log("\nglossary extraction");
{
  const { client } = stubClient(() =>
    JSON.stringify({
      items: [
        {
          name: "Alice",
          type: "character",
          translations: ["อลิซ"],
          description: "protagonist",
        },
        { name: "Gunsmith", type: "terminology", translations: ["ช่างอาวุธ"] },
      ],
    }),
  );
  await runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["extraction"],
  });
  const saved = JSON.parse(readFileSync(dictionaryPath, "utf8"));
  check(
    "keys lowercased",
    saved.alice !== undefined && saved.gunsmith !== undefined,
  );
  check("translations preserved", saved.alice.translations[0] === "อลิซ");
  check("persisted to disk", Object.keys(saved).length === 2);

  // A second pass must not clobber an established rendering.
  const again = stubClient(() =>
    JSON.stringify({
      items: [{ name: "Alice", type: "character", translations: ["โอเล"] }],
    }),
  );
  await runPipeline(CUES, {
    client: again.client,
    dictionary: saved,
    dictionaryPath,
    stages: ["extraction"],
  });
  const merged = JSON.parse(readFileSync(dictionaryPath, "utf8"));
  check(
    "existing entries are never overwritten",
    merged.alice.translations[0] === "อลิซ",
  );
}

console.log("\nstage wiring");
{
  let sawOriginal = false;
  let sawTranslated = false;
  const { client } = stubClient((prompt) => {
    sawOriginal ||= prompt.includes("<original>");
    sawTranslated ||= prompt.includes("<translated>");
    return ok(["ปรับ1", "ปรับ2", "ปรับ3"]);
  });
  await runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["translation", "humanization"],
  });
  check("humanization sees the original cues", sawOriginal);
  check("humanization sees the stage output", sawTranslated);
}

console.log("\nglossary injection");
{
  let sawGlossary = false;
  let sawIrrelevant = false;
  const { client } = stubClient((prompt) => {
    sawGlossary ||= prompt.includes("<glossary>");
    sawIrrelevant ||= prompt.includes("unrelatedterm");
    return ok(["ก1", "ก2", "ก3"]);
  });
  await runPipeline(CUES, {
    client,
    dictionary: {
      hello: { type: "terminology", translations: ["สวัสดี"] },
      unrelatedterm: { type: "terminology", translations: ["ไม่เกี่ยว"] },
    },
    dictionaryPath,
    stages: ["translation"],
  });
  check("relevant term injected", sawGlossary);
  check("terms absent from the chunk are filtered out", !sawIrrelevant);
}

rmSync(tempDir, { recursive: true, force: true });

void appConfig;
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exit(1);
