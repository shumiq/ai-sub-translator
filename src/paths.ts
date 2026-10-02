import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * Absolute project root, so every command behaves the same no matter which
 * directory it was launched from. `import.meta.dirname` exists on both Node
 * 20.11+ and Bun.
 */
export const PROJECT_ROOT = join(import.meta.dirname, "..");

export const VIDEO_PATTERN = /\.(mkv|mp4|m4v|avi|mov|webm)$/i;
export const SRT_PATTERN = /\.srt$/i;

export function listVideos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => VIDEO_PATTERN.test(name))
    .map((name) => join(dir, name))
    .sort();
}

export function listSubtitles(
  dir: string,
  pattern: RegExp = SRT_PATTERN,
): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name))
    .sort();
}

/** `input/show.mkv` -> `show` */
export function stemOf(file: string): string {
  return basename(file, extname(file));
}

export function ensureDirs(dirs: string[]) {
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
