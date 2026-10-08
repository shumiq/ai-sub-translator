import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appConfig } from "../config";
import { parseArgs, prompt } from "../src/cli";
import {
  assertFfmpegAvailable,
  probeStreams,
  runFfmpeg,
  type MediaStream,
} from "../src/ffmpeg";
import { Logger } from "../src/logger";
import { ensureDirs, listVideos, stemOf } from "../src/paths";
import { assToCues } from "../src/subtitle/ass";
import { parseSrt, stringifySrt } from "../src/subtitle/srt";
import { describeStream, TEXT_CODECS } from "../src/streams";

const ASS_CODECS = new Set(["ass", "ssa"]);

interface ExtractedSubtitles {
  srt: string;
  /** The source's own ASS script, when the track is ASS/SSA. */
  ass?: string;
}

async function extractStem(
  video: string,
  stream: MediaStream,
): Promise<ExtractedSubtitles> {
  const stem = stemOf(video);
  const temp = join(appConfig.tempDir, stem);
  ensureDirs([appConfig.tempDir]);

  if (ASS_CODECS.has(stream.codec_name)) {
    // Step 2.1 — pull the first subtitle out in its native ASS form.
    const assPath = `${temp}.ass`;
    await runFfmpeg([
      "-i",
      video,
      "-map",
      `0:${stream.index}`,
      "-f",
      "ass",
      assPath,
    ]);
    // Step 2.2 — ASS to SRT, in node. The raw ASS is kept as well: SRT has
    // nowhere to put styles, margins or `\pos`, and hardsub needs them.
    const ass = readFileSync(assPath, "utf8");
    const cues = assToCues(ass);
    if (cues.length === 0)
      throw new Error("No dialogue events found in the extracted ASS");
    return { srt: stringifySrt(cues), ass };
  }

  // Everything else text-based goes straight to SRT.
  const srtPath = `${temp}.srt`;
  await runFfmpeg([
    "-i",
    video,
    "-map",
    `0:${stream.index}`,
    "-f",
    "srt",
    srtPath,
  ]);
  const cues = parseSrt(readFileSync(srtPath, "utf8"));
  if (cues.length === 0)
    throw new Error("No cues found in the extracted subtitle");
  return { srt: stringifySrt(cues) };
}

/**
 * Print every subtitle stream of `video` and ask which one to extract.
 * Returns undefined when the user skips the file.
 */
async function chooseStream(
  video: string,
  streams: MediaStream[],
  defaultPos: number,
  hasDefault: boolean,
): Promise<number | undefined> {
  const stem = stemOf(video);
  Logger.step(`${stem}: subtitle streams`);
  streams.forEach((stream, position) =>
    Logger.info(describeStream(stream, position)),
  );

  const answer = await prompt("Extract which stream?", {
    default: hasDefault ? String(defaultPos) : undefined,
    validate: (value) => {
      if (value === "s") return undefined;
      if (value === "" || !Number.isInteger(Number(value)))
        return "Enter a stream position, or s to skip";
      const position = Number(value);
      if (position < 0 || position >= streams.length)
        return `Position out of range (0-${streams.length - 1})`;
      if (!TEXT_CODECS.has(streams[position]!.codec_name))
        return `#${position} (${streams[position]!.codec_name}) is a bitmap format and cannot be extracted`;
      return undefined;
    },
  });

  return answer === "s" ? undefined : Number(answer);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const force = args.flags.has("force");
  const requested = args.values.stream;

  // The per-file stream choice is the whole point of this command; without a
  // terminal on stdin `prompt()` would block forever instead of asking.
  if (!process.stdin.isTTY) {
    Logger.error(
      "stdin is not a TTY — extract.ts asks which subtitle stream to extract for each video",
    );
    process.exit(1);
  }

  ensureDirs([appConfig.inputDir, appConfig.tempDir]);
  await assertFfmpegAvailable();

  const videos = listVideos(appConfig.inputDir);
  if (videos.length === 0) {
    Logger.warn(
      `No videos found in ${appConfig.inputDir}/. Copy an .mkv there first.`,
    );
    return;
  }

  let failures = 0;

  for (const video of videos) {
    const stem = stemOf(video);
    const target = join(appConfig.inputDir, `${stem}.srt`);
    const assTarget = join(appConfig.inputDir, `${stem}.ass`);

    const streams = (await probeStreams(video)).filter(
      (s) => s.codec_type === "subtitle",
    );
    if (streams.length === 0) {
      Logger.warn(`${stem}: no subtitle stream found, skipping`);
      failures++;
      continue;
    }

    const defaultPos =
      requested === undefined ? appConfig.subtitleStream : Number(requested);
    if (requested !== undefined && !Number.isInteger(defaultPos)) {
      Logger.error(`--stream must be a number, got "${requested}"`);
      failures++;
      continue;
    }
    const defaultStream = streams[defaultPos];
    const hasDefault =
      defaultStream !== undefined && TEXT_CODECS.has(defaultStream.codec_name);

    // Already done? Decided before asking: a complete .srt (+ .ass when the
    // file has an ASS track at all) means there is nothing to choose. The
    // check repeats against the chosen stream below for the mixed case where
    // the existing output came from a different codec.
    const hasAssTrack = streams.some((s) => ASS_CODECS.has(s.codec_name));
    if (
      !force &&
      existsSync(target) &&
      (existsSync(assTarget) || !hasAssTrack)
    ) {
      Logger.info(
        `${relative(process.cwd(), target)} already exists (use --force to overwrite)`,
      );
      continue;
    }

    if (requested !== undefined && !hasDefault) {
      Logger.error(
        `${stem}: --stream ${requested} ` +
          (defaultStream === undefined
            ? `is out of range (0-${streams.length - 1})`
            : `(${defaultStream.codec_name}) is a bitmap format and cannot be converted to text`),
      );
      failures++;
      continue;
    }

    const position = await chooseStream(video, streams, defaultPos, hasDefault);
    if (position === undefined) {
      Logger.info(`${stem}: skipped`);
      continue;
    }
    const chosen = streams[position]!;

    // An ASS track yields two files, and both have to be current before the
    // video counts as done — an .srt from an older run with no matching .ass
    // would silently lose every position.
    const needsAss = ASS_CODECS.has(chosen.codec_name);
    if (existsSync(target) && (existsSync(assTarget) || !needsAss) && !force) {
      Logger.info(
        `${relative(process.cwd(), target)} already exists (use --force to overwrite)`,
      );
      continue;
    }

    Logger.step(`Extracting subtitles from ${stem}`);
    Logger.info(`Using subtitle stream ${position} (${chosen.codec_name})`);

    try {
      const extracted = await extractStem(video, chosen);
      writeFileSync(target, extracted.srt, "utf8");
      const cueCount = parseSrt(extracted.srt).length;
      Logger.success(
        `Wrote ${relative(process.cwd(), target)} (${cueCount} cues)`,
      );
      if (extracted.ass !== undefined) {
        writeFileSync(assTarget, extracted.ass, "utf8");
        Logger.info(`Wrote ${relative(process.cwd(), assTarget)} (positions)`);
      } else if (existsSync(assTarget)) {
        // An earlier run pulled an ASS track. Its positions belong to a
        // different stream, and `retextAss()` matches on timestamps, so
        // leaving it behind risks a mismatched script reaching the burn-in.
        unlinkSync(assTarget);
        Logger.info(
          `Removed ${relative(process.cwd(), assTarget)} (stale positions)`,
        );
      }
    } catch (error) {
      Logger.error(`${stem}: ${(error as Error).message}`);
      failures++;
    }
  }

  if (failures > 0) {
    Logger.warn(`${failures} video(s) were skipped`);
  }
}

main().catch((error: Error) => {
  Logger.error(error.message);
  process.exit(1);
});
