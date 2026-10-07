import { appConfig } from "../../config";
import type { AiClient } from "../ai/client";
import { AiResponseError } from "../ai/errors";
import { Logger } from "../logger";
import {
  extractionPrompt,
  extractionSystem,
  GLOSSARY_RESPONSE_SCHEMA,
  type StagePromptInput,
} from "../prompts";
import { extractJson } from "./stage";
import type { Cue, Dictionary, DictionaryEntry } from "../types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseItems(value: unknown): Record<string, unknown>[] {
  const items =
    isRecord(value) && Array.isArray(value.items) ? value.items : null;
  if (!items)
    throw new AiResponseError("Expected an object with an `items` array");

  return items.filter(isRecord);
}

function toEntry(raw: Record<string, unknown>): DictionaryEntry | null {
  const rawTranslations = raw.translations;
  const translations = Array.isArray(rawTranslations)
    ? rawTranslations.map(String).filter(Boolean)
    : [];
  if (translations.length === 0) return null;

  const entry: DictionaryEntry = {
    type: raw.type === "character" ? "character" : "terminology",
    translations,
  };

  if (typeof raw.description === "string" && raw.description) {
    entry.description = raw.description;
  }
  if (
    raw.gender === "male" ||
    raw.gender === "female" ||
    raw.gender === "neutral"
  ) {
    entry.gender = raw.gender;
  }
  if (typeof raw.speakingStyle === "string" && raw.speakingStyle) {
    entry.speakingStyle = raw.speakingStyle;
  }
  if (Array.isArray(raw.prohibitedPhrases)) {
    const phrases = raw.prohibitedPhrases.map(String).filter(Boolean);
    if (phrases.length > 0) entry.prohibitedPhrases = phrases;
  }

  return entry;
}

export interface GlossaryStageOptions {
  source: Cue[];
  dictionary: Dictionary;
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Sweeps the source cues for new glossary entries. Existing keys are never
 * overwritten, so an established rendering survives every later episode.
 * The caller merges the returned terms into the shared dictionary.
 */
export async function runGlossaryStage(
  client: AiClient,
  options: GlossaryStageOptions,
): Promise<Record<string, DictionaryEntry>> {
  const {
    source,
    dictionary,
    chunkSize = appConfig.extractionChunkSize,
    onProgress,
  } = options;

  const collected: Record<string, DictionaryEntry> = {};
  const system = extractionSystem();
  const maxRetries = appConfig.validation.retriesLimit || 3;

  for (let from = 0; from < source.length; from += chunkSize) {
    const chunk = source.slice(from, from + chunkSize);
    let feedback: string | null = null;
    let items: Record<string, unknown>[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const input: StagePromptInput = {
        source: chunk,
        current: [],
        context: [],
        previousOutput: [],
        glossary: dictionary,
        feedback,
      };

      try {
        const response = await client.generate({
          system,
          prompt: extractionPrompt(input),
          responseSchema: GLOSSARY_RESPONSE_SCHEMA,
          label: `extraction cues ${from + 1}-${from + chunk.length}`,
        });
        items = parseItems(extractJson(response));
        break;
      } catch (error) {
        if (!(error instanceof AiResponseError)) throw error;
        Logger.debug(`  malformed glossary response: ${error.message}`);
        feedback = `${error.message}. Return strict JSON of the form {"items": []}.`;
      }
    }

    let added = 0;
    for (const raw of items) {
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) continue;

      const key = name.toLowerCase();
      if (dictionary[key] || collected[key]) continue;

      const entry = toEntry(raw);
      if (!entry) continue;

      collected[key] = entry;
      added++;
    }

    Logger.debug(
      `  cues ${from + 1}-${from + chunk.length}: ${added} new term(s)`,
    );
    onProgress?.(Math.min(from + chunk.length, source.length), source.length);
  }

  return collected;
}
