import type { MediaStream } from "./ffmpeg";

/** Subtitle codecs ffmpeg can hand back as text. */
export const TEXT_CODECS = new Set([
  "ass",
  "ssa",
  "subrip",
  "webvtt",
  "mov_text",
  "text",
  "sami",
  "microdvd",
  "mpsub",
  "subviewer",
  "realtext",
  "stl",
  "ttml",
  "hdmv_text_subtitle",
  "eia_608",
  "eia_708",
  "dvb_teletext",
]);

/** ffprobe reports ISO 639-2/B codes; a name makes the listing readable. */
const LANGUAGE_NAMES: Record<string, string> = {
  ara: "Arabic",
  chi: "Chinese",
  deu: "German",
  eng: "English",
  fra: "French",
  ger: "German",
  hin: "Hindi",
  ind: "Indonesian",
  ita: "Italian",
  jpn: "Japanese",
  kor: "Korean",
  nld: "Dutch",
  pol: "Polish",
  por: "Portuguese",
  rus: "Russian",
  spa: "Spanish",
  tha: "Thai",
  tur: "Turkish",
  ukr: "Ukrainian",
  vie: "Vietnamese",
  zho: "Chinese",
};

/**
 * One line per subtitle stream: the position `subtitleStream` / `--stream`
 * refers to, the ffprobe facts, and a warning when the codec cannot become
 * text at all.
 */
export function describeStream(stream: MediaStream, position: number): string {
  const code = stream.tags?.language ?? "und";
  const name = LANGUAGE_NAMES[code];
  const language = name === undefined ? code : `${code} · ${name}`;
  const title = stream.tags?.title ? ` "${stream.tags.title}"` : "";
  const bitmap = TEXT_CODECS.has(stream.codec_name)
    ? ""
    : " [bitmap, cannot extract]";
  return `  [${position}] #${stream.index} ${stream.codec_name} (${language})${title}${bitmap}`;
}
