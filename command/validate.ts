import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { appConfig } from "../config";
import { checkCues } from "../src/badchars";
import { parseArgs } from "../src/cli";
import { isThaiText } from "../src/lang";
import { Logger } from "../src/logger";
import { listSubtitles, PROJECT_ROOT, stemOf } from "../src/paths";
import { formatSrtTime, parseSrt } from "../src/subtitle/srt";

function selectFiles(dir: string, only: string | undefined): string[] {
  const all = listSubtitles(dir);
  if (!only) return all;
  return all.filter((file) => stemOf(file) === only || basename(file) === only);
}

/**
 * Post-hoc check of `output/*.srt`, the counterpart to `translate.ts`'s
 * per-chunk validation: that one guards the model contract, this one reads
 * what actually landed on disk and hands the human a list to fix by hand.
 * Reports every hit rather than stopping at the first — a false positive is
 * cheaper than a missed one.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const files = selectFiles(appConfig.outputDir, args.values.file);
  if (files.length === 0) {
    Logger.warn(
      `No .srt files in ${appConfig.outputDir}/. Run \`bun command/translate.ts\` first.`,
    );
    return;
  }
  Logger.info(`Checking ${files.length} file(s) in ${appConfig.outputDir}/`);

  let flagged = 0;
  let issues = 0;
  let skipped = 0;

  for (const file of files) {
    const path = relative(PROJECT_ROOT, file);

    const cues = parseSrt(readFileSync(file, "utf8"));
    if (cues.length === 0) {
      Logger.warn(`${path}: no cues found, skipping`);
      skipped++;
      continue;
    }

    // A file with no Thai at all is almost certainly not a Thai translation,
    // so the target language must have been changed — reporting every line of
    // it would bury the real findings.
    if (!isThaiText(cues.map((cue) => cue.lines.join("\n")).join("\n"))) {
      Logger.info(`${path}: no Thai anywhere, skipping`);
      skipped++;
      continue;
    }

    const found = checkCues(cues);
    if (found.length === 0) {
      Logger.success(`${path}: clean (${cues.length} cues)`);
      continue;
    }

    flagged++;
    issues += found.length;
    Logger.step(`${path}: ${found.length} line(s) to fix`);
    for (const issue of found) {
      Logger.warn(
        `${path}:${issue.cue} (${formatSrtTime(issue.startMs)}): ${issue.detail}`,
      );
      Logger.info(`  ${issue.text}`);
    }
  }

  Logger.step("Summary");
  if (issues === 0) {
    Logger.success(`Nothing to fix in ${files.length - skipped} file(s).`);
    return;
  }
  Logger.error(
    `${issues} line(s) across ${flagged} file(s) need a manual fix (${skipped} skipped).`,
  );
  process.exitCode = 1;
}

main().catch((error: Error) => {
  Logger.error(error.message);
  process.exit(1);
});
