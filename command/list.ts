import { appConfig } from "../config";
import { assertFfmpegAvailable, probeStreams } from "../src/ffmpeg";
import { Logger } from "../src/logger";
import { ensureDirs, listVideos, stemOf } from "../src/paths";
import { describeStream } from "../src/streams";

/**
 * Read-only companion to `extract.ts`: prints every subtitle stream of every
 * video in `input/` so the index to put in `subtitleStream` can be chosen
 * without extracting anything. Marks the stream `extract.ts` would take.
 */
async function main() {
  ensureDirs([appConfig.inputDir]);
  await assertFfmpegAvailable();

  const videos = listVideos(appConfig.inputDir);
  if (videos.length === 0) {
    Logger.warn(
      `No videos found in ${appConfig.inputDir}/. Copy an .mkv there first.`,
    );
    return;
  }

  for (const video of videos) {
    const stem = stemOf(video);
    const streams = (await probeStreams(video)).filter(
      (s) => s.codec_type === "subtitle",
    );
    if (streams.length === 0) {
      Logger.warn(`${stem}: no subtitle stream`);
      continue;
    }

    Logger.step(stem);
    streams.forEach((stream, position) => {
      const mark =
        position === appConfig.subtitleStream ? "  <- subtitleStream" : "";
      Logger.info(`${describeStream(stream, position)}${mark}`);
    });
  }

  Logger.info(
    `subtitleStream = ${appConfig.subtitleStream} in config.ts (overridable with --stream)`,
  );
}

main().catch((error: Error) => {
  Logger.error(error.message);
  process.exit(1);
});
