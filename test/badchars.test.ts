import { describe, expect, test } from "bun:test";
import { checkCues, inspectLine } from "../src/badchars";
import { parseSrt } from "../src/subtitle/srt";

const kinds = (text: string) => inspectLine(text).map((i) => i.kind);

describe("inspectLine", () => {
  test("clean Thai line has no issues", () => {
    expect(kinds("ครับ, โอเค! (ดีมาก) 1,000")).toHaveLength(0);
  });

  test("allowed symbols pass", () => {
    expect(kinds("สวัสดี — … ①②♪")).toHaveLength(0);
  });

  test("flags curly quotes, CJK, Cyrillic and emoji", () => {
    expect(kinds("สวัสดี “เด็ก”")).toContain("badChar");
    expect(kinds("字幕คำบรรยาย")).toContain("badChar");
    expect(kinds("Привет ครับ")).toContain("badChar");
    expect(kinds("โอเค 😀")).toContain("badChar");
  });

  test("flags Thai/Latin with no separator", () => {
    expect(kinds("ข้อความtext")).toContain("mixedScript");
  });

  test("flags a line with no Thai letters", () => {
    expect(kinds("I said no.")).toContain("nonThai");
  });

  test("punctuation-only line is ignored", () => {
    expect(kinds("-")).toHaveLength(0);
  });
});

describe("checkCues", () => {
  test("issue carries cue number, timecode and code point", () => {
    const issues = checkCues(
      parseSrt(
        "1\n00:00:01,000 --> 00:00:03,000\nทดสอบภาษาไทย\n\n2\n00:00:04,000 --> 00:00:06,000\n字幕\nหวัดดี\n\n",
      ),
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.cue === 2 && i.startMs === 4000)).toBe(true);
    expect(issues.some((i) => i.detail.includes("U+5B57"))).toBe(true);
  });
});
