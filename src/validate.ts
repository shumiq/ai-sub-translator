import { appConfig } from "../config";
import {
  isThaiText,
  isTranslatable,
  latinRatio,
  normalizeForCompare,
} from "./lang";
import type { Cue } from "./types";

/**
 * Validates one chunk of a stage's output against its source cues.
 *
 * Returns the reason the chunk was rejected, or `null` when it is good. Every
 * check is fatal: the message goes straight back to the model as
 * `<correction_required>`, so a chunk that passes here can be spliced back
 * into the file as-is.
 */
export function validateChunk(
  sourceCues: Cue[],
  outputTexts: string[],
  label: string,
): string | null {
  const cfg = appConfig.validation;

  if (cfg.cueCount && outputTexts.length !== sourceCues.length) {
    return `Cue count mismatch for ${label}: expected ${sourceCues.length}, received ${outputTexts.length}. Return exactly one entry per input cue, in the same order.`;
  }

  for (let i = 0; i < sourceCues.length; i++) {
    const source = sourceCues[i]!;
    const output = outputTexts[i] ?? "";
    const sourceText = source.lines.join(" ");
    const where = `${label} cue ${source.index}`;

    // A cue with nothing to translate — a music note, a "---", a stray
    // glyph — is the model's to format however it likes.
    if (!isTranslatable(sourceText)) continue;

    if (cfg.emptyText && output.trim().length === 0) {
      return `Empty output for ${where}. Every cue with words in the source must receive a translation.`;
    }

    if (cfg.isThai && !isThaiText(output)) {
      return `Output for ${where} contains no Thai characters: "${output}". Translate it into Thai.`;
    }

    if (cfg.leftoverSource) {
      if (normalizeForCompare(output) === normalizeForCompare(sourceText)) {
        return `Output for ${where} is identical to the source. Translate it into Thai instead of echoing it.`;
      }
      const ratio = latinRatio(output);
      if (ratio > 0.6) {
        return `Output for ${where} is ${Math.round(ratio * 100)}% Latin characters, which means it was left untranslated. Translate it into Thai.`;
      }
    }

    if (cfg.lineCountPerCue) {
      const sourceLines = source.lines.length;
      const outputLines = output
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      // Fatal: a collapsed cue leaves a gap where the text used to be, and a
      // split cue overflows the line budget the source file was authored to.
      // The timings are never negotiable, so the break points have to give.
      if (outputLines !== sourceLines) {
        return `${where}: line count changed from ${sourceLines} to ${outputLines}. Return exactly ${sourceLines} line(s), joined by a single newline, breaking at the same point as the source.`;
      }
    }
  }

  return null;
}
