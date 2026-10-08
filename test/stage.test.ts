import { describe, expect, test } from "bun:test";
import { extractJson, toTextArray } from "../src/pipeline/stage";

describe("extractJson", () => {
  test("plain object", () => {
    expect(extractJson('{"texts":["a"]}')).toEqual({ texts: ["a"] });
  });

  test("fenced block", () => {
    expect(extractJson('```json\n{"texts":["a"]}\n```')).toEqual({
      texts: ["a"],
    });
  });

  test("prose around the payload", () => {
    expect(extractJson('Here you go:\n{"texts":["x"]}\nDone.')).toEqual({
      texts: ["x"],
    });
  });

  test("bare array", () => {
    expect(extractJson('["a","b"]')).toEqual(["a", "b"]);
  });

  test("rejects a response with no JSON", () => {
    expect(() => extractJson("no json at all")).toThrow("no JSON payload");
  });

  test("rejects invalid JSON", () => {
    expect(() => extractJson("{not json}")).toThrow("not valid JSON");
  });
});

describe("toTextArray", () => {
  test("reads all accepted shapes", () => {
    expect(toTextArray({ texts: ["a"] })).toEqual(["a"]);
    expect(toTextArray(["a"])).toEqual(["a"]);
    expect(toTextArray([{ text: "a" }])).toEqual(["a"]);
  });

  test("rejects the wrong shape", () => {
    expect(() => toTextArray({ nope: 1 })).toThrow();
    expect(() => toTextArray([{ nope: 1 }])).toThrow();
  });
});
