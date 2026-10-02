import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appConfig } from "../config";
import { parseArgs } from "../src/cli";
import { assertFfmpegAvailable, probeStreams, runFfmpeg } from "../src/ffmpeg";
import { Logger } from "../src/logger";
import { cuesToAss } from "../src/subtitle/ass";
import { parseSrt } from "../src/subtitle/srt";
import {
  ensureDirs,
  listSubtitles,
  listVideos,
  PROJECT_ROOT,
  stemOf,
} from "../src/paths";

/** Quotes a filter argument so spaces in file names survive the filter parser. */
const quoted = (value: string) =>
  `'${value.replace(/\\/g, "/").replace(/'/g, "\\'")}'`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const force = args.flags.has("force");
  const keepSubtitles =
    args.flags.has("keep-subs") || appConfig.hardsub.keepOriginalSubtitles;

  ensureDirs([appConfig.inputDir, appConfig.outputDir, appConfig.tempDir]);
  await assertFfmpegAvailable();

  const only = args.values.file;
  const subtitles = listSubtitles(appConfig.outputDir)
    .filter((file) => (only ? stemOf(file) === only : true))
    .map((file) => stemOf(file));

  if (subtitles.length === 0) {
    Logger.warn(
      `No .srt files in ${appConfig.outputDir}/. Run \`bun command/translate.ts\` and review them first.`,
    );
    return;
  }

  const videos = new Map(
    listVideos(appConfig.inputDir).map((video) => [stemOf(video), video]),
  );
  let built = 0;
  let failed = 0;

  for (const stem of subtitles) {
    const video = videos.get(stem);
    if (!video) {
      Logger.error(
        `${stem}: no matching video in ${appConfig.inputDir}/, skipping`,
      );
      failed++;
      continue;
    }

    const target = join(appConfig.outputDir, `${stem}.mp4`);
    if (existsSync(target) && !force) {
      Logger.info(
        `${relative(PROJECT_ROOT, target)} already exists (use --force to overwrite)`,
      );
      continue;
    }

    Logger.step(`Burning subtitles into ${stem}`);

    const cues = parseSrt(
      readFileSync(join(appConfig.outputDir, `${stem}.srt`), "utf8"),
    );
    if (cues.length === 0) {
      Logger.error(`${stem}: no cues found, skipping`);
      failed++;
      continue;
    }

    // Render the reviewed SRT as a single-style ASS script so libass can
    // burn it in with the bundled Thai typeface.
    const assRelative = `${appConfig.tempDir}/${stem}.ass`;
    const ass = cuesToAss(cues, {
      title: stem,
      style: appConfig.hardsub.style,
    });
    writeFileSync(join(PROJECT_ROOT, assRelative), ass, "utf8");

    const streams = await probeStreams(video);
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");
    const hasSubtitles = streams.some(
      (stream) => stream.codec_type === "subtitle",
    );

    const ffmpegArgs: string[] = [
      "-i",
      video,
      "-map_metadata",
      "0",
      "-map",
      "0:v:0",
    ];
    if (hasAudio) ffmpegArgs.push("-map", "0:a");
    if (keepSubtitles && hasSubtitles) ffmpegArgs.push("-map", "0:s");

    ffmpegArgs.push(
      "-vf",
      `subtitles=${quoted(assRelative)}:fontsdir=${quoted(appConfig.assetDir)}`,
      "-c:v",
      "libx264",
      "-preset",
      appConfig.hardsub.preset,
      "-b:v",
      appConfig.hardsub.videoBitrate,
      "-maxrate",
      appConfig.hardsub.videoBitrate,
      "-bufsize",
      appConfig.hardsub.videoBufSize,
      "-pix_fmt",
      "yuv420p",
    );

    if (hasAudio) {
      ffmpegArgs.push("-c:a", "aac", "-b:a", appConfig.hardsub.audioBitrate);
    }

    ffmpegArgs.push("-movflags", "+faststart", target);

    Logger.info(
      `Mali ${appConfig.hardsub.style.fontSize}px · ${appConfig.hardsub.preset} · ` +
        `${appConfig.hardsub.videoBitrate} video · ${appConfig.hardsub.audioBitrate} audio`,
    );

    try {
      await runFfmpeg(ffmpegArgs, { stream: true });
      Logger.success(`Wrote ${relative(PROJECT_ROOT, target)}`);
      built++;
    } catch (error) {
      Logger.error(`${stem}: ffmpeg failed — ${(error as Error).message}`);
      failed++;
    }
  }

  Logger.step("Summary");
  Logger.info(`${built} encoded, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: Error) => {
  Logger.error(error.message);
  process.exit(1);
});
