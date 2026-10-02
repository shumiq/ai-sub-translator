import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { appConfig } from "../config";
import { AiClient } from "../src/ai/client";
import { HighDemandError, ProhibitedContentError } from "../src/ai/errors";
import { parseArgs } from "../src/cli";
import { ensureDictionary, loadDictionary } from "../src/dictionary";
import { Logger } from "../src/logger";
import { runPipeline } from "../src/pipeline";
import { ensureDirs, listSubtitles, PROJECT_ROOT, stemOf } from "../src/paths";
import { parseSrt, stringifySrt } from "../src/subtitle/srt";
import type { PipelineStage } from "../src/types";

const STAGES: PipelineStage[] = [
  "extraction",
  "translation",
  "consistency",
  "humanization",
];

function selectStages(raw: string | undefined): PipelineStage[] {
  if (!raw) return appConfig.pipeline;
  const requested = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const unknown = requested.filter(
    (name) => !STAGES.includes(name as PipelineStage),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown stage(s): ${unknown.join(", ")}. Valid stages: ${STAGES.join(", ")}`,
    );
  }

  return requested as PipelineStage[];
}

function selectFiles(dir: string, only: string | undefined): string[] {
  const all = listSubtitles(dir);
  if (!only) return all;
  return all.filter((file) => stemOf(file) === only || basename(file) === only);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const force = args.flags.has("force");
  const stages = selectStages(args.values.stages);

  ensureDirs([appConfig.inputDir, appConfig.outputDir, appConfig.tempDir]);

  // Step 3.1 — bootstrap the shared dictionary on first run.
  ensureDictionary(appConfig.dictionaryPath);
  const dictionary = loadDictionary(appConfig.dictionaryPath);
  Logger.info(
    `${appConfig.dictionaryPath} holds ${Object.keys(dictionary).length} term(s); edit it between runs to pin wording`,
  );

  const files = selectFiles(appConfig.inputDir, args.values.file);
  if (files.length === 0) {
    Logger.warn(
      `No .srt files in ${appConfig.inputDir}/. Run \`bun command/extract.ts\` first.`,
    );
    return;
  }

  const client = new AiClient(undefined, args.values.model ?? appConfig.model);
  Logger.info(`Model: ${args.values.model ?? appConfig.model}`);
  Logger.info(`Stages: ${stages.join(" → ")}`);

  let translated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const stem = stemOf(file);
    const target = join(appConfig.outputDir, `${stem}.srt`);

    if (existsSync(target) && !force) {
      Logger.info(
        `${relative(PROJECT_ROOT, target)} already exists (use --force to overwrite)`,
      );
      skipped++;
      continue;
    }

    const original = parseSrt(readFileSync(file, "utf8"));
    if (original.length === 0) {
      Logger.warn(`${stem}: no cues found, skipping`);
      failed++;
      continue;
    }

    Logger.step(`Translating ${stem} (${original.length} cues)`);

    try {
      const cues = await runPipeline(original, {
        client,
        dictionary,
        dictionaryPath: appConfig.dictionaryPath,
        stages,
      });

      writeFileSync(target, stringifySrt(cues), "utf8");
      Logger.success(`Wrote ${relative(PROJECT_ROOT, target)}`);
      translated++;
    } catch (error) {
      if (error instanceof ProhibitedContentError) {
        Logger.warn(`${stem}: blocked by content filters, skipping this file`);
      } else if (error instanceof HighDemandError) {
        Logger.warn(`${stem}: ${error.message}`);
      } else {
        Logger.error(`${stem}: ${(error as Error).message}`);
      }
      failed++;
    }
  }

  Logger.step("Summary");
  Logger.info(`${translated} translated, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: Error) => {
  Logger.error(error.message);
  process.exit(1);
});
