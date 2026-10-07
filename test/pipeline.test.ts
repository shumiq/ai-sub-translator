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
import { checkCues, inspectLine } from "../src/badchars";
import { runPipeline } from "../src/pipeline";
import { extractJson, toTextArray } from "../src/pipeline/stage";
import { retextAss } from "../src/subtitle/ass";
import { parseSrt } from "../src/subtitle/srt";
import { parseAss } from "../src/vendor";

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
  const systems: string[] = [];
  const client = {
    async generate(request: { system: string; prompt: string }) {
      systems.push(request.system);
      prompts.push(request.prompt);
      return handler(request.prompt, prompts.length - 1);
    },
  } as unknown as AiClient;
  return { client, prompts, systems };
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

console.log("\nmulti-chunk coverage");
// The regression that produced a file whose cues 61..1603 were empty: the
// range walker stopped after one chunk, so only the first chunkSize cues were
// ever translated and the rest were written out as empty cues.
{
  const savedChunkSize = appConfig.chunkSize;
  appConfig.chunkSize = 2;
  try {
    const many = CUES.concat(
      parseSrt(["4\n00:00:07,500 --> 00:00:09,000\nFourth line.\n\n"].join("")),
      parseSrt(["5\n00:00:09,500 --> 00:00:11,000\nFifth line.\n\n"].join("")),
    );
    const { client, prompts } = stubClient((prompt) =>
      ok(inputIds(prompt).map((cue) => `แปล${cue.id}`)),
    );
    const out = await runPipeline(many, {
      client,
      dictionary: {},
      dictionaryPath,
      stages: ["translation"],
    });
    check(
      "every cue past the first chunk is translated",
      out.length === 5 &&
        out.every((cue) => cue.lines.length === 1 && cue.lines[0] !== ""),
      out.map((cue) => cue.lines.join("")).join("|"),
    );
    check(
      "the tail cue keeps its source timing",
      out[4]!.startMs === 9500 && out[4]!.endMs === 11000,
      `${out[4]!.startMs}-${out[4]!.endMs}`,
    );
    check(
      "one request per chunk",
      prompts.length === 3,
      `got ${prompts.length}`,
    );
  } finally {
    appConfig.chunkSize = savedChunkSize;
  }
}

console.log("\nprevious-chunk context");
// Each chunk past the first is handed the source cues before it plus the
// output this run already produced for them, so register and gender choices
// do not restart at every chunk boundary.
{
  const savedChunkSize = appConfig.chunkSize;
  appConfig.chunkSize = 2;
  try {
    const many = CUES.concat(
      parseSrt(["4\n00:00:07,500 --> 00:00:09,000\nFourth line.\n\n"].join("")),
      parseSrt(["5\n00:00:09,500 --> 00:00:11,000\nFifth line.\n\n"].join("")),
    );
    const { client, prompts } = stubClient((prompt) =>
      ok(inputIds(prompt).map((cue) => `แปล${cue.id}`)),
    );
    await runPipeline(many, {
      client,
      dictionary: {},
      dictionaryPath,
      stages: ["translation"],
    });

    check(
      "the first chunk opens cold",
      !prompts[0]!.includes("<previous_input>") &&
        !prompts[0]!.includes("<previous_output>"),
      prompts[0]!.slice(0, 80),
    );
    check(
      "the second chunk sees the previous source cues",
      prompts[1]!.includes("<previous_input>") &&
        prompts[1]!.includes("Hello there."),
      "previous_input missing or empty",
    );
    check(
      "the second chunk sees this run's own output",
      prompts[1]!.includes("<previous_output>") &&
        prompts[1]!.includes("แปล1") &&
        prompts[1]!.includes("แปล2"),
      "previous_output missing or empty",
    );
    check(
      "the third chunk sees the chunk before it, not the first",
      prompts[2]!.includes("แปล3") &&
        prompts[2]!.includes("แปล4") &&
        !prompts[2]!.includes("แปล1"),
      "stale or missing output context",
    );
  } finally {
    appConfig.chunkSize = savedChunkSize;
  }
}

console.log("\ngendered forms fall back to neutral");
{
  const { client, systems } = stubClient((prompt) =>
    ok(inputIds(prompt).map((cue) => `ตอบ${cue.id}`)),
  );
  await runPipeline(CUES, {
    client,
    dictionary: {},
    dictionaryPath,
    stages: ["translation", "consistency"],
  });
  check(
    "gendered forms are gated on evidence in translation",
    systems[0]!.includes("solid evidence") &&
      systems[0]!.includes("ฉัน, เรา, คุณ"),
    "rule missing from the translation system prompt",
  );
  check(
    "consistency strips unjustified gendered particles",
    systems[1]!.includes("solid evidence") &&
      systems[1]!.includes("strip gendered particles"),
    "rule missing from the consistency system prompt",
  );
}

console.log("\nline count per cue");
// CUES are all single-line, so a two-line answer is a mismatch.
{
  const savedLineCount = appConfig.validation.lineCountPerCue;
  appConfig.validation.lineCountPerCue = true;
  try {
    const { client, prompts } = stubClient((prompt) => {
      const retried = prompt.includes("<correction_required>");
      return ok(
        inputIds(prompt).map((cue) =>
          retried ? `บรรทัดเดียว${cue.id}` : `บรรทัดแรก${cue.id}\nบรรทัดที่สอง`,
        ),
      );
    });
    const out = await runPipeline(CUES, {
      client,
      dictionary: {},
      dictionaryPath,
      stages: ["translation"],
    });
    check(
      "a changed line count is rejected",
      prompts.length === 2,
      `got ${prompts.length}`,
    );
    check(
      "the reason names the line counts",
      prompts[1]!.includes("line count changed from 1 to 2"),
      "feedback missing the line-count reason",
    );
    check(
      "the retried answer is what lands",
      out[0]!.lines.join("|") === "บรรทัดเดียว1",
      out[0]!.lines.join("|"),
    );
  } finally {
    appConfig.validation.lineCountPerCue = savedLineCount;
  }
}

{
  // A symbol-only source cue carries nothing to translate, so the model is
  // free to answer with any number of lines.
  const symbols = parseSrt(
    ["1\n00:00:01,000 --> 00:00:03,000\n♪\n---\n\n"].join(""),
  );
  const savedLineCount = appConfig.validation.lineCountPerCue;
  appConfig.validation.lineCountPerCue = true;
  try {
    const { client, prompts } = stubClient(() =>
      ok(["♪\n---\n---\n---\n---\n---\n---"]),
    );
    const out = await runPipeline(symbols, {
      client,
      dictionary: {},
      dictionaryPath,
      stages: ["translation"],
    });
    check(
      "symbol-only cue is exempt from the line count",
      prompts.length === 1,
    );
    check("and still keeps its timing", out[0]!.startMs === 1000);
  } finally {
    appConfig.validation.lineCountPerCue = savedLineCount;
  }
}

console.log("\nline break instructions follow the flag");
// The validator and the prompt have to agree: telling the model it may re-break
// while the validator rejects it just burns retries.
{
  const savedLineCount = appConfig.validation.lineCountPerCue;
  const systemsOf = async (lineCountPerCue: boolean) => {
    appConfig.validation.lineCountPerCue = lineCountPerCue;
    const { client, systems } = stubClient(() => ok(["ก1", "ก2", "ก3"]));
    await runPipeline(CUES, {
      client,
      dictionary: {},
      dictionaryPath,
      stages: ["translation", "consistency", "humanization"],
    });
    return systems;
  };

  try {
    const strict = await systemsOf(true);
    check(
      "on: all three stages forbid re-breaking",
      strict.length === 3 &&
        strict.every((s) => s.includes("exactly the same number of lines")),
      `checked ${strict.length} system prompt(s)`,
    );
    check(
      "on: does not mention re-breaking",
      strict.every((s) => !s.includes("splitting them further is fine")),
    );

    const loose = await systemsOf(false);
    check(
      "off: all three stages allow merging and splitting",
      loose.length === 3 &&
        loose.every((s) => s.includes("splitting them further is fine")),
      `checked ${loose.length} system prompt(s)`,
    );
    check(
      "off: still demands non-empty, two lines at most",
      loose.every(
        (s) => s.includes("never leave a cue empty") && s.includes("two lines"),
      ),
    );
    check(
      "off: does not promise an exact line count",
      loose.every((s) => !s.includes("exactly the same number of lines")),
    );
  } finally {
    appConfig.validation.lineCountPerCue = savedLineCount;
  }
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

console.log("\nretextAss (inherited burn-in script)");
{
  const fixture = [
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
    "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\pos(100,50)\\fnImpact}Hello there.",
    "Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\pos(10,10)}Stacked sign",
    "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Leftover source line",
  ].join("\n");

  // Two cues share a start (stacked signs): the exact-end match must win.
  const cues = [
    { index: 1, startMs: 1000, endMs: 2000, lines: ["แปลเครื่องหมาย"] },
    { index: 2, startMs: 1000, endMs: 3000, lines: ["แปลบทสนทนา"] },
  ];
  // The expected face comes from config, never a literal: swapping the bundled
  // font must not require touching this file (invariant 5).
  const burnInFont = appConfig.hardsub.style.fontName;
  const options = {
    fontName: burnInFont,
    outline: appConfig.hardsub.style.outline,
    shadow: appConfig.hardsub.style.shadow,
    fontSizeStep: appConfig.hardsub.inheritedFontSizeStep,
  };
  const result = retextAss(fixture, cues, options);
  check("cues matched onto the script", result !== null);

  if (result) {
    const styles = Object.fromEntries(
      parseAss(result.replace(/^﻿/, ""))
        .find((section) => /^v4\+ styles$/i.test(section.section))!
        .body.filter((descriptor) => /^style$/i.test(descriptor.key))
        .map((descriptor) => {
          const value = descriptor.value as Record<string, string>;
          return [value.Name, value];
        }),
    );
    const def = styles.Default;
    const sign = styles.Sign;
    check(
      "font retargeted to the burn-in face",
      def?.Fontname === "Sarabun" && sign?.Fontname === "Sarabun",
      `${def?.Fontname}/${sign?.Fontname}`,
    );
    check(
      "outline and shadow unified",
      def?.Outline === String(options.outline) &&
        def?.Shadow === String(options.shadow) &&
        sign?.Outline === String(options.outline) &&
        sign?.Shadow === String(options.shadow),
      `${def?.Outline}/${def?.Shadow} ${sign?.Outline}/${sign?.Shadow}`,
    );
    check(
      "sizes raised by the configured step",
      def?.Fontsize === String(20 + options.fontSizeStep) &&
        sign?.Fontsize === String(40 + options.fontSizeStep),
      `${def?.Fontsize}/${sign?.Fontsize}`,
    );
    check(
      "layout tags kept, font overrides dropped",
      result.includes("{\\an8\\pos(100,50)}แปลบทสนทนา") &&
        result.includes("{\\pos(10,10)}แปลเครื่องหมาย") &&
        !result.includes("\\fn"),
      "position prefix",
    );
    check(
      "dialogue without a cue is dropped",
      !result.includes("Leftover source line"),
    );
    check("BOM preserved for libass", result.charCodeAt(0) === 0xfeff);
  }

  check(
    "unmatched cue falls back instead of guessing",
    retextAss(
      fixture,
      [...cues, { index: 3, startMs: 9999, endMs: 10999, lines: ["x"] }],
      options,
    ) === null,
  );
}

console.log("\noutput character checks");
{
  const kinds = (text: string) => inspectLine(text).map((i) => i.kind);
  check("clean Thai line", kinds("ครับ, โอเค! (ดีมาก) 1,000").length === 0);
  check("Thai and allowed symbols", kinds("สวัสดี — … ①②♪").length === 0);
  check("curly quotes flagged", kinds("สวัสดี “เด็ก”").includes("badChar"));
  check("Thai/Latin adjacency", kinds("ข้อความtext").includes("mixedScript"));
  check("untranslated line", kinds("I said no.").includes("nonThai"));
  check("CJK flagged", kinds("字幕คำบรรยาย").includes("badChar"));
  check("Cyrillic flagged", kinds("Привет ครับ").includes("badChar"));
  check("emoji flagged", kinds("โอเค 😀").includes("badChar"));
  check("punctuation-only line ignored", kinds("-").length === 0);

  const checked = checkCues(
    parseSrt(
      [
        "1\n00:00:01,000 --> 00:00:03,000\nทดสอบภาษาไทย\n\n",
        "2\n00:00:04,000 --> 00:00:06,000\n字幕\nหวัดดี\n\n",
      ].join(""),
    ),
  );
  check(
    "issue carries cue number and timecode",
    checked.length === 2 &&
      checked.every((i) => i.cue === 2 && i.startMs === 4000),
    `${checked.length} issue(s)`,
  );
  check(
    "bad character reported with its code point",
    checked.some((i) => i.kind === "badChar" && i.detail.includes("U+5B57")),
  );
}

void appConfig;
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exit(1);
