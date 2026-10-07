import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { appConfig } from "../config";
import { parseArgs } from "../src/cli";
import { assertFfmpegAvailable, probeStreams, runFfmpeg } from "../src/ffmpeg";
import { Logger } from "../src/logger";
import { cuesToAss, retextAss } from "../src/subtitle/ass";
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
  const faststart = args.flags.has("faststart");

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

    const target = join(PROJECT_ROOT, appConfig.outputDir, `${stem}.mp4`);
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

    // The original ASS script knows where every line sits — styles, margins,
    // `\pos` overrides. Reuse it with the translated text so SRT's loss of
    // that information never reaches the burn-in; only files extracted from a
    // non-ASS track have no original, and those get a generated script.
    const assRelative = `${appConfig.tempDir}/${stem}.ass`;
    const originalAss = join(PROJECT_ROOT, appConfig.inputDir, `${stem}.ass`);
    let ass: string | null = null;
    if (existsSync(originalAss)) {
      const s = appConfig.hardsub.style;
      ass = retextAss(readFileSync(originalAss, "utf8"), cues, {
        fontName: s.fontName,
        outline: s.outline,
        shadow: s.shadow,
        fontSizeStep: appConfig.hardsub.inheritedFontSizeStep,
      });
      if (ass === null) {
        Logger.warn(
          `${stem}: ${relative(PROJECT_ROOT, originalAss)} does not line up with the translated cues, using the default style`,
        );
      }
    }
    if (ass === null) {
      ass = cuesToAss(cues, {
        title: stem,
        style: appConfig.hardsub.style,
      });
    }
    writeFileSync(join(PROJECT_ROOT, assRelative), ass, "utf8");

    const streams = await probeStreams(video);
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");

    // Matroska first, then a plain rename to .mp4: the mp4 muxer rejects some
    // stream layouts while mkv takes anything, and the rename skips a remux.
    // Soft subtitle tracks are never mapped — only the burned-in one remains.
    const encodedRelative = `${appConfig.tempDir}/${stem}.mkv`;
    const ffmpegArgs: string[] = [
      "-i",
      video,
      "-map_metadata",
      "0",
      "-map",
      "0:v:0",
    ];
    if (hasAudio) ffmpegArgs.push("-map", "0:a");

    ffmpegArgs.push(
      "-vf",
      // `ass`, not `subtitles`: only the `ass` filter exposes `shaping`, and
      // the default (`auto`) picks the simple shaper, which draws Thai tone
      // marks and vowels at one level instead of stacking them. Thai needs
      // complex (HarfBuzz) shaping.
      `ass=${quoted(assRelative)}:fontsdir=${quoted(appConfig.assetDir)}:shaping=complex`,
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

    ffmpegArgs.push(encodedRelative);

    Logger.info(
      `${appConfig.hardsub.style.fontName} · ${appConfig.hardsub.preset} · ` +
        `${appConfig.hardsub.videoBitrate} video · ${appConfig.hardsub.audioBitrate} audio`,
    );

    try {
      await runFfmpeg(ffmpegArgs, { stream: true });
      if (faststart) {
        // Renaming the .mkv keeps the moov atom at the end of the file, so a
        // browser can neither start playback nor seek until the whole download
        // arrives. Remux into a real .mp4 with +faststart instead — streams
        // are copied, so the extra pass costs nothing in quality.
        const faststartRelative = `${appConfig.tempDir}/${stem}.faststart.mp4`;
        await runFfmpeg(
          [
            "-i",
            encodedRelative,
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            faststartRelative,
          ],
          { stream: true },
        );
        unlinkSync(join(PROJECT_ROOT, encodedRelative));
        if (existsSync(target)) unlinkSync(target);
        renameSync(join(PROJECT_ROOT, faststartRelative), target);
      } else {
        if (existsSync(target)) unlinkSync(target);
        renameSync(join(PROJECT_ROOT, encodedRelative), target);
      }
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
