import type { AiClient } from "../ai/client";
import { Logger } from "../logger";
import { relevantTerms, saveDictionary } from "../dictionary";
import { stripInlineTags } from "../subtitle/srt";
import type { Cue, Dictionary, PipelineStage } from "../types";
import { runGlossaryStage } from "./glossary";
import { runTextStage } from "./stage";

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

    const texts = await runTextStage(client, {
      stage,
      source: original,
      // Review stages rewrite the previous stage's output; translation reads
      // the source directly and only borrows it as scene context.
      current: stage === "translation" ? [] : current,
      context: stage === "translation" ? original : current,
      glossary: relevantTerms(glossary, allText(current)),
      onProgress: progress(stage),
    });

    current = applyTexts(original, texts);
    Logger.info(`${stage}: ${current.length} cues ready`);
  }

  return current;
}
