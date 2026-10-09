import { appConfig } from "../../config";
import type { AiClient } from "../ai/client";
import { Logger } from "../logger";
import { relevantTerms, saveDictionary } from "../dictionary";
import { formatSrtTime, stripInlineTags } from "../subtitle/srt";
import type { Cue, Dictionary, Evaluation, PipelineStage } from "../types";
import { runEvaluationStage } from "./evaluation";
import { runGlossaryStage } from "./glossary";
import { runTextStage } from "./stage";
import { runVerificationStage } from "./verification";

const progress = (stage: string) => (done: number, total: number) => {
  Logger.debug(`  ${stage}: ${done}/${total} cues`);
};

const allText = (cues: Cue[]) =>
  cues.map((cue) => cue.lines.join("\n")).join("\n");

/** Attaches translated text to the original timings of `source`. */
function applyTexts(source: Cue[], texts: string[]): Cue[] {
  return source.map((cue, index) => ({
    ...cue,
    lines: (texts[index] ?? "")
      .split("\n")
      .map(stripInlineTags)
      .filter((line) => line.length > 0),
  }));
}

export interface PipelineOptions {
  client: AiClient;
  dictionary: Dictionary;
  dictionaryPath: string;
  stages: PipelineStage[];
}

/**
 * Audits the finished target text against the source and repairs only the cues
 * the audit flagged. Each drifted cue is sent for repair together with a few
 * neighbours so the model has scene context, but the neighbours' rewrites are
 * discarded — a rewrite is itself a chance to introduce drift, so the blast
 * radius stays exactly the set that was already wrong.
 *
 * Re-auditing is scoped: the first round audits every cue, every round after
 * that audits only the cues that were just drifted. Since those are the only
 * cues the repair touched, the drifted count can only stay level or fall —
 * never grow. A round that shrinks drift resets the budget and the loop keeps
 * going, so `maxRounds` only bites when drift stops falling: that many stalled
 * rounds and it gives up. A file that still drifts is written anyway and the
 * leftovers are listed for manual review — drift is a quality flag, not a
 * reason to abandon the file.
 */
async function refineHumanization(options: {
  client: AiClient;
  original: Cue[];
  current: Cue[];
  evaluation: Evaluation;
  glossary: Dictionary;
}): Promise<Cue[]> {
  const { client, original, evaluation, glossary } = options;
  let current = options.current;
  const { maxRounds, neighborCount } = appConfig.verification;

  // Audits exactly the given positions and returns the drifted source cue ids.
  const audit = (positions: number[]): Promise<number[]> =>
    runVerificationStage(client, {
      source: positions.map((position) => original[position]!),
      current: positions.map((position) => current[position]!),
      evaluation,
      onProgress: progress("verification"),
    });

  let drift = new Set(await audit(original.map((_, position) => position)));
  if (drift.size === 0) {
    Logger.info(`verification: all ${original.length} cue(s) match`);
    return current;
  }
  Logger.info(`verification: ${drift.size} cue(s) drifted`);

  // `maxRounds` counts stalled rounds only: a round that reduces drift resets
  // it, because a shrinking loop converges on its own and needs no cap.
  let stalled = 0;
  let round = 0;
  while (drift.size > 0 && stalled < maxRounds) {
    round++;
    const driftPositions = original
      .map((cue, position) => (drift.has(cue.index) ? position : -1))
      .filter((position) => position >= 0);
    if (driftPositions.length === 0) break;

    const window = new Set<number>();
    for (const position of driftPositions) {
      const first = Math.max(0, position - neighborCount);
      const last = Math.min(original.length - 1, position + neighborCount);
      for (let p = first; p <= last; p++) window.add(p);
    }
    const ordered = [...window].sort((a, b) => a - b);

    const subSource = ordered.map((position) => original[position]!);
    const texts = await runTextStage(client, {
      stage: "humanization",
      source: subSource,
      current: ordered.map((position) => current[position]!),
      evaluation,
      glossary: relevantTerms(glossary, allText(current)),
      onProgress: progress(`humanization ${round}`),
    });
    const refined = applyTexts(subSource, texts);
    ordered.forEach((position, offset) => {
      // Neighbours came along only as context; keep the source's own fix.
      if (!drift.has(original[position]!.index)) return;
      current[position] = refined[offset]!;
    });

    const before = drift.size;
    drift = new Set(await audit(driftPositions));
    if (drift.size === 0) {
      Logger.info(
        `verification: all ${original.length} cue(s) match after ${round} re-humanize round(s)`,
      );
      break;
    }

    if (drift.size < before) {
      stalled = 0;
      Logger.info(
        `verification: drift ${before} → ${drift.size}; re-humanizing ${drift.size} cue(s)`,
      );
    } else {
      stalled++;
      Logger.warn(
        `verification: no progress (${before} → ${drift.size}); attempt ${stalled}/${maxRounds}`,
      );
    }
  }

  if (drift.size > 0) reportDrift(original, current, drift);

  return current;
}

/**
 * Lists the cues still drifting when the loop gives up, so the operator knows
 * exactly what to fix by hand. The file is still written — this is a review
 * flag on the output, not a failure.
 */
function reportDrift(
  original: Cue[],
  current: Cue[],
  drift: Set<number>,
): void {
  Logger.warn(
    `verification: ${drift.size} cue(s) still drifted; review these by hand:`,
  );
  original.forEach((cue, position) => {
    if (!drift.has(cue.index)) return;
    const translated = current[position]?.lines.join(" / ") ?? "";
    Logger.warn(
      `  #${cue.index} @ ${formatSrtTime(cue.startMs)} — "${translated}" (source: "${cue.lines.join(" / ")}")`,
    );
  });
}

/**
 * Runs the configured stages over one file's cues and returns the final
 * translated cues. Timings always come from the source file, so no cue can be
 * lost or reordered no matter what the model returns.
 */
export async function runPipeline(
  original: Cue[],
  options: PipelineOptions,
): Promise<Cue[]> {
  const { client, dictionary, dictionaryPath, stages } = options;
  let glossary = dictionary;
  let evaluation: Evaluation = {};
  let current = original;

  for (const stage of stages) {
    Logger.step(`Stage: ${stage}`);

    if (stage === "extraction") {
      const found = await runGlossaryStage(client, {
        source: original,
        dictionary: glossary,
        onProgress: progress(stage),
      });

      const added = Object.keys(found).length;
      glossary = { ...glossary, ...found };
      saveDictionary(dictionaryPath, glossary);
      Logger.info(
        added > 0
          ? `Added ${added} new term(s) to ${dictionaryPath}`
          : `No new terms found; ${dictionaryPath} unchanged`,
      );
      continue;
    }

    if (stage === "evaluation") {
      evaluation = await runEvaluationStage(client, {
        source: original,
        onProgress: progress(stage),
      });
      Logger.info(
        `evaluation: ${Object.keys(evaluation).length} cue(s) classified`,
      );
      continue;
    }

    const texts = await runTextStage(client, {
      stage,
      source: original,
      // Review stages rewrite the previous stage's output; translation reads
      // the source directly and only borrows it as scene context.
      current: stage === "translation" ? [] : current,
      context: stage === "translation" ? original : current,
      evaluation,
      glossary: relevantTerms(glossary, allText(current)),
      onProgress: progress(stage),
    });

    current = applyTexts(original, texts);
    Logger.info(`${stage}: ${current.length} cues ready`);
  }

  if (stages.includes("humanization")) {
    current = await refineHumanization({
      client,
      original,
      current,
      evaluation,
      glossary,
    });
  }

  return current;
}
