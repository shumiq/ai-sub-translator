import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Dictionary, DictionaryEntry } from "./types";
import { Logger } from "./logger";

/** Creates the dictionary on first run so the user has something to edit. */
export function ensureDictionary(path: string): Dictionary {
  if (existsSync(path)) return loadDictionary(path);

  Logger.info(`Creating ${path}`);
  const parent = dirname(path);
  // `recursive: true` still throws EEXIST for an existing "." on some runtimes.
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(path, "{}\n", "utf8");
  return {};
}

export function loadDictionary(path: string): Dictionary {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Dictionary;
    }
  } catch (error) {
    Logger.warn(`Could not parse ${path}: ${(error as Error).message}`);
  }
  return {};
}

export function saveDictionary(path: string, dictionary: Dictionary) {
  const sorted: Dictionary = {};
  for (const key of Object.keys(dictionary).sort()) {
    sorted[key] = dictionary[key]!;
  }
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/**
 * Narrows the shared glossary to the entries that actually occur in `text`,
 * so prompts stay small even as the dictionary grows across episodes.
 */
export function relevantTerms(
  dictionary: Dictionary,
  text: string,
): Record<string, DictionaryEntry> {
  const haystack = text.toLowerCase();
  const matched: Record<string, DictionaryEntry> = {};

  for (const [term, entry] of Object.entries(dictionary)) {
    if (haystack.includes(term.toLowerCase())) matched[term] = entry;
  }

  return matched;
}
