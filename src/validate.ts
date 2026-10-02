import { appConfig } from "../config";
import {
  isThaiText,
  isTranslatable,
  latinRatio,
  normalizeForCompare,
} from "./lang";
import type { Cue } from "./types";
import { Logger } from "./logger";

export interface ValidationResult {
  error: string | null;
  warnings: string[];
}

/**
 * Validates one chunk of a stage's output against its source cues.
 *
 * Every check except `lineCountPerCue` is fatal, because a chunk that fails
 * any of them cannot be spliced back together without losing cues. Warnings
 * are cosmetic only and never trigger a retry.
 */
export function validateChunk(
  sourceCues: Cue[],
  outputTexts: string[],
  label: string,
): ValidationResult {
  const warnings: string[] = [];
  const cfg = appConfig.validation;

  if (cfg.cueCount && outputTexts.length !== sourceCues.length) {
    return {
      error: `Cue count mismatch for ${label}: expected ${sourceCues.length}, received ${outputTexts.length}. Return exactly one entry per input cue, in the same order.`,
      warnings,
    };
  }

  for (let i = 0; i < sourceCues.length; i++) {
    const source = sourceCues[i]!;
    const output = outputTexts[i] ?? "";
    const sourceText = source.lines.join(" ");
    const where = `${label} cue ${source.index}`;

    if (!isTranslatable(sourceText)) continue;

    if (cfg.emptyText && output.trim().length === 0) {
      return {
        error: `Empty output for ${where}. Every cue with words in the source must receive a translation.`,
        warnings,
      };
    }

    if (cfg.isThai && !isThaiText(output)) {
      return {
        error: `Output for ${where} contains no Thai characters: "${output}". Translate it into Thai.`,
        warnings,
      };
    }

    if (cfg.leftoverSource) {
      if (normalizeForCompare(output) === normalizeForCompare(sourceText)) {
        return {
          error: `Output for ${where} is identical to the source. Translate it into Thai instead of echoing it.`,
          warnings,
        };
      }
      const ratio = latinRatio(output);
      if (ratio > 0.6) {
        return {
          error: `Output for ${where} is ${Math.round(ratio * 100)}% Latin characters, which means it was left untranslated. Translate it into Thai.`,
          warnings,
        };
      }
    }

    if (cfg.lineCountPerCue) {
      const sourceLines = source.lines.length;
      const outputLines = output
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      if (outputLines !== sourceLines) {
        const message = `${where}: line count changed from ${sourceLines} to ${outputLines}.`;
        if (warnings.length < 5) warnings.push(message);
        Logger.debug(message);
      }
    }
  }

  return { error: null, warnings };
}
