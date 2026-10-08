import {
  ApiError,
  GoogleGenAI,
  type GenerateContentResponse,
} from "@google/genai";
import { appConfig } from "../../config";
import { Logger } from "../logger";
import {
  AiConfigError,
  HighDemandError,
  ProhibitedContentError,
} from "./errors";

type ThinkingSetting = "off" | "low" | "medium" | "high";

const THINKING_BUDGET: Record<ThinkingSetting, number> = {
  off: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
};

export interface AiRequest {
  /** Goes to `systemInstruction`. */
  system: string;
  /** The user turn. */
  prompt: string;
  /** When set, the model is constrained to this JSON schema. */
  responseSchema?: unknown;
  /** Short identifier used in log lines, e.g. `translation 12-31`. */
  label?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const statusOf = (error: unknown): number | undefined =>
  error instanceof ApiError ? error.status : undefined;

const isRateLimited = (error: unknown) => statusOf(error) === 429;
const isRetryable = (error: unknown) => {
  const status = statusOf(error);
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
};

/**
 * Gemini wrapper over comma-separated keys with bounded retries.
 *
 * Keys are picked at random per attempt to spread load; a key that returns
 * 429 is dropped for the rest of the request so exhaustion means every key
 * really was tried. 5xx retries with exponential backoff. Blocks from content
 * filters are surfaced as typed errors so the pipeline can skip the offending
 * file.
 */
export class AiClient {
  private readonly clients: GoogleGenAI[];
  private readonly model: string;
  private readonly thinking: ThinkingSetting;

  constructor(
    keys: string[] = appConfig.apiKeys,
    model: string = appConfig.model,
    thinking: ThinkingSetting = appConfig.thinking,
  ) {
    if (keys.length === 0) {
      throw new AiConfigError(
        "No API keys found. Create a `.env` file containing `GEMINI_API_KEY=your-key` " +
          "(comma-separate multiple keys to rotate between them).",
      );
    }
    this.clients = keys.map((apiKey) => new GoogleGenAI({ apiKey }));
    this.model = model;
    this.thinking = thinking;
    Logger.debug(
      `AI client ready: model=${model} keys=${keys.length} thinking=${thinking}`,
    );
  }

  private pickKey(available: number[]): number {
    // ponytail: random per request spreads RPS/RPM load across keys
    return available[Math.floor(Math.random() * available.length)]!;
  }

  private async call(client: GoogleGenAI, request: AiRequest): Promise<string> {
    const response: GenerateContentResponse =
      await client.models.generateContent({
        model: this.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          temperature: appConfig.temperature,
          thinkingConfig: {
            thinkingBudget: THINKING_BUDGET[this.thinking],
            includeThoughts: false,
          },
          ...(request.responseSchema
            ? {
                responseMimeType: "application/json",
                responseSchema: request.responseSchema,
              }
            : {}),
        },
      });

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new ProhibitedContentError(`Prompt blocked (${blockReason})`);
    }

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === "PROHIBITED_CONTENT" || finishReason === "SPII") {
      throw new ProhibitedContentError(`Response blocked (${finishReason})`);
    }
    if (finishReason === "RECITATION" || finishReason === "SAFETY") {
      throw new ProhibitedContentError(
        `Response stopped early (${finishReason})`,
      );
    }

    const text = response.text;
    if (!text || text.trim().length === 0) {
      throw new ProhibitedContentError("Model returned an empty response");
    }
    return text;
  }

  /**
   * Sends one request, dropping rate-limited keys and backing off on 5xx.
   * Rate limiting gives up only once every key has been tried.
   */
  async generate(request: AiRequest): Promise<string> {
    const label = request.label ?? "request";
    const limited = new Set<number>();
    let attempt = 1;

    for (;;) {
      const available = this.clients
        .map((_, index) => index)
        .filter((index) => !limited.has(index));
      const keyIndex = this.pickKey(available);

      try {
        return await this.call(this.clients[keyIndex]!, request);
      } catch (error) {
        if (error instanceof ProhibitedContentError) throw error;
        if (!isRetryable(error)) throw error;

        if (isRateLimited(error)) {
          limited.add(keyIndex);
          if (limited.size >= this.clients.length) {
            throw new HighDemandError(
              `All ${this.clients.length} API key(s) hit a rate limit during ${label}.`,
            );
          }
          Logger.debug(
            `Rate limited during ${label}; retrying on another key (${limited.size}/${this.clients.length} tried)`,
          );
          continue;
        }

        if (attempt > appConfig.retry.maxAttempts) throw error;

        const delay = Math.min(
          appConfig.retry.baseDelayMs * 2 ** (attempt - 1),
          appConfig.retry.maxDelayMs,
        );
        Logger.debug(
          `Transient ${statusOf(error)} during ${label}; retrying in ${delay}ms`,
        );
        await sleep(delay);
        attempt++;
      }
    }
  }
}
