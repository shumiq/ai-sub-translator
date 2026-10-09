import { appConfig } from "../../config";
import type { AiClient } from "../ai/client";
import { AiResponseError } from "../ai/errors";
import { Logger } from "../logger";
import {
  VERIFICATION_RESPONSE_SCHEMA,
  verificationPrompt,
  verificationSystem,
  type StagePromptInput,
} from "../prompts";
import { extractJson } from "./stage";
import type { Cue, Evaluation } from "../types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseItems(value: unknown): Record<string, unknown>[] {
  const items =
    isRecord(value) && Array.isArray(value.items) ? value.items : null;
  if (!items)
    throw new AiResponseError("Expected an object with an `items` array");

  return items.filter(isRecord);
}

export interface VerificationStageOptions {
  /** Source-language cues, the fidelity reference. */
  source: Cue[];
  /** Finished target text, aligned 1:1 with `source`. */
  current: Cue[];
  /** Speaker/addressee verdicts from the evaluation stage. May be empty. */
  evaluation: Evaluation;
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Audits the finished target text against the source, cue by cue, and returns
 * the source cue indices whose translation no longer carries the original's
 * meaning or speaker. This replaces a whole-file consistency pass: detection
 * is one verdict per cue, and only the flagged cues get repaired. One verdict
 * per cue is mandatory, so a short chunk is retried and, if it never comes
 * back complete, the file is abandoned rather than trusted (invariant 3).
 */
export async function runVerificationStage(
  client: AiClient,
  options: VerificationStageOptions,
): Promise<number[]> {
  const {
    source,
    current,
    evaluation,
    chunkSize = appConfig.chunkSize,
    onProgress,
  } = options;

  const system = verificationSystem();
  const maxRetries = appConfig.validation.retriesLimit || 3;
  const drifted: number[] = [];

  for (let from = 0; from < source.length; from += chunkSize) {
    const chunk = source.slice(from, from + chunkSize);
    let feedback: string | null = null;
    let audited = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const input: StagePromptInput = {
        source: chunk,
        current: current.slice(from, from + chunk.length),
        context: current.slice(
          Math.max(0, from - appConfig.previousCueCount),
          from,
        ),
        previousOutput: [],
        evaluation: chunk
          .map((cue) => ({ id: cue.index, text: evaluation[cue.index] ?? "" }))
          .filter((item) => item.text.length > 0),
        glossary: {},
        feedback,
      };

      try {
        const response = await client.generate({
          system,
          prompt: verificationPrompt(input),
          responseSchema: VERIFICATION_RESPONSE_SCHEMA,
          label: `verification cues ${from + 1}-${from + chunk.length}`,
        });

        const byId = new Map<number, boolean>();
        for (const raw of parseItems(extractJson(response))) {
          const id = Number(raw.id);
          if (Number.isFinite(id)) byId.set(id, raw.ok === true);
        }

        const missing = chunk
          .filter((cue) => !byId.has(cue.index))
          .map((cue) => cue.index);
        if (missing.length > 0) {
          feedback = `Missing a verdict for cue(s): ${missing.join(", ")}. Return one entry per input cue, each with its exact id.`;
          continue;
        }

        for (const cue of chunk) {
          if (byId.get(cue.index) === false) drifted.push(cue.index);
        }
        audited = true;
        break;
      } catch (error) {
        if (!(error instanceof AiResponseError)) throw error;
        Logger.debug(`  malformed verification response: ${error.message}`);
        feedback = `${error.message}. Return strict JSON of the form {"items": [{"id": 1, "ok": true}]}.`;
      }
    }

    if (!audited) {
      throw new AiResponseError(
        `Verification failed for cues ${from + 1}-${from + chunk.length} after ${maxRetries + 1} attempts.`,
      );
    }

    Logger.debug(`  cues ${from + 1}-${from + chunk.length}: audited`);
    onProgress?.(Math.min(from + chunk.length, source.length), source.length);
  }

  return drifted;
}
