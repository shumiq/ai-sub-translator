import { appConfig } from "../../config";
import type { AiClient } from "../ai/client";
import { AiResponseError } from "../ai/errors";
import { Logger } from "../logger";
import {
  EVALUATION_RESPONSE_SCHEMA,
  evaluationPrompt,
  evaluationSystem,
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

export interface EvaluationStageOptions {
  source: Cue[];
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Classifies each cue's speaker and addressee. One verdict per cue is
 * mandatory — later stages treat a missing line as "no evidence", not as
 * "translate freely" — so a chunk that does not come back complete is retried
 * and, if it never does, the whole file is abandoned rather than written with
 * a cue whose evaluation silently defaulted to neutral (invariant 3).
 */
export async function runEvaluationStage(
  client: AiClient,
  options: EvaluationStageOptions,
): Promise<Evaluation> {
  const { source, chunkSize = appConfig.chunkSize, onProgress } = options;

  const system = evaluationSystem();
  const maxRetries = appConfig.validation.retriesLimit || 3;
  const evaluation: Evaluation = {};

  for (let from = 0; from < source.length; from += chunkSize) {
    const chunk = source.slice(from, from + chunkSize);
    let feedback: string | null = null;
    let classified = false;

    // ponytail: no bisection like runTextStage has — a cue the model keeps
    // skipping burns the whole chunk's retries instead of being isolated.
    // Split the chunk only if a real run ever stalls here.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await client.generate({
          system,
          prompt: evaluationPrompt(chunk, feedback),
          responseSchema: EVALUATION_RESPONSE_SCHEMA,
          label: `evaluation cues ${from + 1}-${from + chunk.length}`,
        });

        const byId = new Map<number, string>();
        for (const raw of parseItems(extractJson(response))) {
          const id = Number(raw.id);
          const text =
            typeof raw.evaluation === "string" ? raw.evaluation.trim() : "";
          if (Number.isFinite(id) && text.length > 0) byId.set(id, text);
        }

        const missing = chunk
          .filter((cue) => !byId.has(cue.index))
          .map((cue) => cue.index);
        if (missing.length > 0) {
          feedback = `Missing an evaluation for cue(s): ${missing.join(", ")}. Return one entry per input cue, each with its exact id.`;
          continue;
        }

        for (const cue of chunk) evaluation[cue.index] = byId.get(cue.index)!;
        classified = true;
        break;
      } catch (error) {
        if (!(error instanceof AiResponseError)) throw error;
        Logger.debug(`  malformed evaluation response: ${error.message}`);
        feedback = `${error.message}. Return strict JSON of the form {"items": [{"id": 1, "evaluation": "male to female"}]}.`;
      }
    }

    if (!classified) {
      throw new AiResponseError(
        `Evaluation failed for cues ${from + 1}-${from + chunk.length} after ${maxRetries + 1} attempts.`,
      );
    }

    Logger.debug(
      `  cues ${from + 1}-${from + chunk.length}: ${chunk.length} classified`,
    );
    onProgress?.(Math.min(from + chunk.length, source.length), source.length);
  }

  return evaluation;
}
