import { spawn } from "node:child_process";
import { Logger } from "./logger";
import { PROJECT_ROOT } from "./paths";

export interface RunOptions {
  cwd?: string;
  /** Stream the child process output to the console instead of capturing it. */
  stream?: boolean;
  signal?: AbortSignal;
}

export class ProcessError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`Command failed (${code ?? "signal"}): ${command}`);
    this.name = "ProcessError";
  }
}

function spawnProcess(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      signal: options.signal,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      if (options.stream) process.stdout.write(chunk);
      else stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (options.stream) process.stderr.write(chunk);
      else stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(new ProcessError(`${command} ${args.join(" ")}`, code, stderr));
    });
  });
}

async function ensureAvailable(command: string) {
  try {
    await spawnProcess(command, ["-version"], {});
  } catch {
    throw new Error(
      `\`${command}\` was not found on PATH. Install ffmpeg and make sure it is available in your shell.`,
    );
  }
}

export async function assertFfmpegAvailable() {
  await ensureAvailable("ffmpeg");
  await ensureAvailable("ffprobe");
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
) {
  Logger.debug(`$ ${command} ${args.join(" ")}`);
  return spawnProcess(command, args, options);
}

export async function runFfmpeg(
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return run(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-loglevel", "warning", "-y", ...args],
    { cwd: PROJECT_ROOT, ...options },
  );
}

export interface MediaStream {
  index: number;
  codec_type: string;
  codec_name: string;
  tags?: Record<string, string>;
}

export async function probeStreams(file: string): Promise<MediaStream[]> {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name:stream_tags=language,title",
      "-of",
      "json",
      file,
    ],
    { cwd: PROJECT_ROOT },
  );

  const parsed: unknown = JSON.parse(stdout);
  const streams = (parsed as { streams?: MediaStream[] }).streams ?? [];
  return streams;
}
