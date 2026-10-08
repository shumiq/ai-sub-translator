import { createInterface } from "node:readline/promises";
import { Logger } from "./logger";

export interface ParsedArgs {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}

/**
 * Minimal GNU-ish parser: `--flag`, `--key value`, `--key=value`. There is no
 * dependency on a CLI library for three commands' worth of options.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        values[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        values[body] = next;
        i++;
      } else {
        flags.add(body);
      }
      continue;
    }

    positional.push(token);
  }

  return { flags, values, positional };
}

export interface PromptOptions {
  /** Shown in brackets and used when the answer is empty. */
  default?: string;
  /** Return an error message to re-ask, or undefined to accept. */
  validate?: (answer: string) => string | undefined;
}

/**
 * Ask one question on stdin and resolve with the answer. An empty line picks
 * `options.default`; a failing `validate` re-asks instead of throwing. The
 * caller is responsible for checking stdin is a TTY first — otherwise
 * `rl.question` hangs forever on piped input that never sends a newline.
 */
export async function prompt(
  question: string,
  options: PromptOptions = {},
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const raw = (
        await rl.question(
          options.default === undefined
            ? `${question} `
            : `${question} [${options.default}] `,
        )
      ).trim();
      const answer = raw === "" ? (options.default ?? "") : raw;
      const error = options.validate?.(answer);
      if (error === undefined) return answer;
      Logger.warn(error);
    }
  } finally {
    rl.close();
  }
}
