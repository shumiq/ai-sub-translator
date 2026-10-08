import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("parseArgs", () => {
  test("reads flags, values and positionals", () => {
    const args = parseArgs([
      "translate",
      "--verbose",
      "--stream",
      "2",
      "a.mkv",
    ]);
    expect(args.flags.has("verbose")).toBe(true);
    expect(args.values.stream).toBe("2");
    expect(args.positional).toEqual(["translate", "a.mkv"]);
  });

  test("supports --key=value", () => {
    expect(parseArgs(["--model=x"]).values.model).toBe("x");
  });

  test("a value that looks like a flag stays a flag", () => {
    const args = parseArgs(["--stream", "--force"]);
    expect(args.flags.has("stream")).toBe(true);
    expect(args.flags.has("force")).toBe(true);
  });
});
