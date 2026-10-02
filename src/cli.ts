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
