import { describe, expect, test } from "bun:test";
import {
  formatSrtTime,
  parseSrt,
  stringifySrt,
  stripInlineTags,
} from "../src/subtitle/srt";

describe("parseSrt", () => {
  test("parses timings into milliseconds", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:03,500\nHello\n\n");
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startMs).toBe(1000);
    expect(cues[0]!.endMs).toBe(3500);
    expect(cues[0]!.lines).toEqual(["Hello"]);
  });

  test("accepts dot decimals and multi-line bodies", () => {
    const cues = parseSrt("7\n0:00:02.250 --> 0:00:04.000\nOne\nTwo\n\n");
    expect(cues[0]!.startMs).toBe(2250);
    expect(cues[0]!.lines).toEqual(["One", "Two"]);
  });

  test("tolerates BOM, CRLF and missing cue numbers", () => {
    const text =
      "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n\r\n";
    const cues = parseSrt(text);
    expect(cues).toHaveLength(2);
    expect(cues[1]!.index).toBe(2);
  });

  test("drops inline markup from the body", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:02,000\n{\\i1}Hi {\\i0}<b>there</b>\n\n",
    );
    expect(cues[0]!.lines).toEqual(["Hi there"]);
  });
});

describe("stringifySrt", () => {
  test("round-trips through parseSrt", () => {
    const original = parseSrt(
      "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n2\n00:00:03,500 --> 00:00:05,000\nLine one\nLine two\n\n",
    );
    expect(parseSrt(stringifySrt(original))).toEqual(original);
  });
});

describe("formatSrtTime", () => {
  test("pads all fields", () => {
    expect(formatSrtTime(3_661_001)).toBe("01:01:01,001");
    expect(formatSrtTime(0)).toBe("00:00:00,000");
  });

  test("clamps negative input", () => {
    expect(formatSrtTime(-5)).toBe("00:00:00,000");
  });
});

describe("stripInlineTags", () => {
  test("removes ASS overrides and HTML entities", () => {
    expect(stripInlineTags("{\\pos(10,20)}Text &amp; more")).toBe(
      "Text & more",
    );
  });
});
