import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface AssDescriptor {
  key: string;
  value: string | string[] | Record<string, string>;
}

export interface AssSection {
  section: string;
  body: AssDescriptor[];
}

/** `ass-parser` has no bundled types; this is the shape it actually returns. */
export const parseAss = require("ass-parser") as (text: string) => AssSection[];

/** `ass-stringify` has no bundled types either. */
export const stringifyAss = require("ass-stringify") as (
  ass: AssSection[],
) => string;
