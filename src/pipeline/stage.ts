import { appConfig } from "../../config";
import type { AiClient } from "../ai/client";
import { AiResponseError } from "../ai/errors";
import { Logger } from "../logger";
import {
  stagePrompt,
  stageSystem,
  TEXTS_RESPONSE_SCHEMA,
  type PromptCue,
  type StagePromptInput,
} from "../prompts";
import { validateChunk } from "../validate";
import type { Cue, DictionaryEntry, Evaluation, PipelineStage } from "../types";

/**
 * Pulls the first JSON payload out of a model response. Constrained decoding
 * normally returns raw JSON, but a stray code fence or preamble should not
 * cost a whole chunk.
 */
export function extractJson(text: string): unknown {
  const withoutFences = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const objectStart = withoutFences.indexOf("{");
  const arrayStart = withoutFences.indexOf("[");
  const start =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart);
  const end = Math.max(
    withoutFences.lastIndexOf("}"),
    withoutFences.lastIndexOf("]"),
  );

  if (start === -1 || end <= start) {
    throw new AiResponseError("Response contained no JSON payload");
  }

  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch (error) {
    throw new AiResponseError(
      `Response was not valid JSON: ${(error as Error).message}`,
    );
  }
}

/** Accepts `["a","b"]` as well as `{"texts":["a","b"]}` from the model. */
export function toTextArray(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as Record<string, unknown>).texts)
      ? ((value as Record<string, unknown>).texts as unknown[])
      : null;

  if (!list) {
    throw new AiResponseError("Expected an array of strings under `texts`");
  }

  return list.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const nested = (item as Record<string, unknown>).text;
      if (typeof nested === "string") return nested;
    }
    throw new AiResponseError("Expected an array of strings under `texts`");
  });
}

export interface StageOptions {
  stage: PipelineStage;
  /** Cues this stage rewrites. For review stages this holds the ${original}. */
  source: Cue[];
  /** Text under revision, aligned 1:1 with `source`. */
  current?: Cue[];
  /**
   * Cues fed in as continuity context. Defaults to `current`, which is what
   * review stages want; translation passes the source so the model can still
   * see the surrounding scene while it is still writing in the source language.
   */
  context?: Cue[];
  chunkSize?: number;
  previousCueCount?: number;
  /** Speaker/addressee verdicts from the evaluation stage, keyed by cue index. */
  evaluation?: Evaluation;
  glossary?: Record<string, DictionaryEntry>;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Runs one AI pass over a list of cues.
 *
 * The range is walked one `chunkSize` chunk at a time. A chunk that fails
 * validation is retried with the validator's message fed back to the model;
 * once retries are exhausted the chunk is bisected and each half is retried, so
 * one stubborn cue can never block the whole file.
 */
export async function runTextStage(
  client: AiClient,
  options: StageOptions,
): Promise<string[]> {
  const {
    stage,
    source,
    current = [],
    chunkSize = appConfig.chunkSize,
    previousCueCount = appConfig.previousCueCount,
    evaluation = {},
    glossary = {},
    onProgress,
  } = options;

  const contextCues = options.context ?? current;

  if (source.length === 0) return [];

  const maxRetries = appConfig.validation.retriesLimit || 3;
  const system = stageSystem(stage);
  let completed = 0;

  // Texts this run has already committed, keyed by source cue index. Chunks
  // are walked in order, so everything before `from` is in here by the time a
  // request goes out — including the left half once a chunk has been bisected.
  const produced = new Map<number, string>();

  const outputBefore = (from: number): PromptCue[] => {
    const cues: PromptCue[] = [];
    for (let i = Math.max(0, from - previousCueCount); i < from; i++) {
      const text = produced.get(i);
      if (text === undefined) continue;
      cues.push({ id: source[i]!.index, text });
    }
    return cues;
  };

  const request = async (
    from: number,
    size: number,
    feedback: string | null,
  ) => {
    const chunk = source.slice(from, from + size);
    const evaluationCues: PromptCue[] = chunk
      .map((cue) => ({ id: cue.index, text: evaluation[cue.index] ?? "" }))
      .filter((item) => item.text.length > 0);
    const input: StagePromptInput = {
      source: chunk,
      current: current.slice(from, from + size),
      context: contextCues.slice(Math.max(0, from - previousCueCount), from),
      previousOutput: outputBefore(from),
      evaluation: evaluationCues,
      glossary,
      feedback,
    };

    const response = await client.generate({
      system,
      prompt: stagePrompt(stage, input),
      responseSchema: TEXTS_RESPONSE_SCHEMA,
      label: `${stage} ${from + 1}-${from + size}`,
    });

    return toTextArray(extractJson(response));
  };

  const processChunk = async (
    from: number,
    to: number,
    initialFeedback: string | null,
  ): Promise<string[]> => {
    const size = to - from;
    let feedback = initialFeedback;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let texts: string[];
      try {
        texts = await request(from, size, feedback);
      } catch (error) {
        if (!(error instanceof AiResponseError)) throw error;
        // A malformed response is worth another shot with clearer asks.
        Logger.debug(`  malformed response: ${error.message}`);
        feedback = `${error.message}. Return strict JSON of the form {"texts": ["...", "..."]}.`;
        continue;
      }

      const error = validateChunk(
        source.slice(from, to),
        texts,
        `${stage} cues ${from + 1}-${to}`,
      );
      if (!error) {
        texts.forEach((text, offset) => produced.set(from + offset, text));
        completed += size;
        onProgress?.(completed, source.length);
        return texts;
      }

      Logger.debug(`  cues ${from + 1}-${to} rejected: ${error}`);
      feedback = error;
    }

    if (size === 1) {
      throw new AiResponseError(
        `Stage "${stage}" failed on cue ${source[from]!.index} after ${maxRetries + 1} attempts.`,
      );
    }

    Logger.debug(
      `  splitting cues ${from + 1}-${to} after repeated validation failures`,
    );
    const middle = from + Math.floor(size / 2);
    const left = await processChunk(from, middle, feedback);
    const right = await processChunk(middle, to, feedback);
    return [...left, ...right];
  };

  const processRange = async (from: number, to: number): Promise<string[]> => {
    const texts: string[] = [];
    for (let start = from; start < to; start += chunkSize) {
      const end = Math.min(start + chunkSize, to);
      // Each chunk starts clean: whatever went wrong in the previous chunk
      // says nothing about this one.
      texts.push(...(await processChunk(start, end, null)));
    }
    return texts;
  };

  const texts = await processRange(0, source.length);

  // Belt and braces. Every cue must have come back, otherwise `applyTexts`
  // would write empty cues for the tail of the file and nothing would notice.
  if (texts.length !== source.length) {
    throw new AiResponseError(
      `Stage "${stage}" returned ${texts.length} texts for ${source.length} cues.`,
    );
  }

  return texts;
}
