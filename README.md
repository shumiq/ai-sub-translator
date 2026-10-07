# ai-sub-translator

Translate soft subtitles from videos in `input/` into Thai, then burn them in.

Three commands, run in order. Every intermediate file is yours to inspect, and
you are expected to edit the translation before the final step.

## Setup

Requires [ffmpeg](https://ffmpeg.org/) and [ffprobe](https://ffmpeg.org/) on
`PATH`, plus Bun.

```bash
bun install
```

Create a `.env` file:

```
GEMINI_API_KEY=your-key-here
```

Comma-separate multiple keys to rotate between them when one hits a rate limit:

```
GEMINI_API_KEY=key-one,key-two,key-three
```

## Workflow

### 1. Put the video in `input/`

```bash
cp some-episode.mkv input/
```

### 2. Extract the subtitles

```bash
bun command/list.ts
bun command/extract.ts
```

`list.ts` is read-only: it prints every subtitle stream of every video in
`input/` — position, codec, language, title — and marks the one
`subtitleStream` in `config.ts` points at. Set that index, then `extract.ts`
writes `input/<name>.srt`. An ASS/SSA stream also leaves its script behind as
`input/<name>.ass` — SRT has nowhere to put styles, margins or `\pos`, and the
burn-in step reuses those positions. Everything else goes through ffmpeg as
SRT and has no `.ass`.

| Flag           | Effect                                                          |
| -------------- | --------------------------------------------------------------- |
| `--force`      | Re-extract, overwriting `.srt` and `.ass`                       |
| `--stream <n>` | Use the n-th stream instead of `subtitleStream` (this run only) |

Run with `DEBUG=1` to log ffprobe's raw stream details. Bitmap subtitles
(PGS, VobSub, DVD) cannot become text — `list.ts` and `extract.ts` both say
so; re-encode with a text track or point `subtitleStream` at a text stream.

### 3. Translate

```bash
bun command/translate.ts
```

Creates `dictionary.json` on first run, then for each `input/*.srt` runs the
pipeline below and writes `output/*.srt`.

| Flag              | Effect                                                 |
| ----------------- | ------------------------------------------------------ |
| `--file <name>`   | Only process one file (stem or filename)               |
| `--force`         | Overwrite existing `output/*.srt`                      |
| `--stages <list>` | Run a subset, e.g. `--stages translation,humanization` |
| `--model <name>`  | Override the Gemini model                              |

### 4. Review the output

Read `output/<name>.srt` and fix anything that reads badly. This is the
point of the whole tool — the model gets you 90% of the way, you do the rest.
Editing `dictionary.json` to pin a translation makes later runs consistent
with your choices.

### 5. Check for bad characters

```bash
bun command/validate.ts
```

Prints every line in `output/*.srt` that is likely wrong, for you to fix by
hand: characters outside Thai/Latin (leftover CJK or Cyrillic, emoji,
typographic quotes), Thai butted directly against Latin without a space, and
lines with no Thai at all. Both the allow-list and the report shape are taken
from [ai-novel-translator](https://github.com/shumiq/ai-novel-translator)'s
`utils/validate.ts` (`BAD_CHAR_RE` and `checkBadCharacters`); its
`tools/check_bad_characters.ts` is only the CLI wrapper around them. Like that
tool, this prints one warning per line with its code points and the offending
text underneath, and exits non-zero if anything was found. False positives are
expected and harmless — the allow-list is deliberately strict.

| Flag            | Effect                             |
| --------------- | ---------------------------------- |
| `--file <name>` | Only check one file (stem or name) |

### 6. Burn in

```bash
bun command/hardsub.ts
```

Re-renders `output/<name>.srt` as an ASS script and burns it into
`input/<name>.mkv`, writing `output/<name>.mp4`. When `input/<name>.ass` came
out of extract, that script is reused: `retextAss()` keeps its styles, margins
and `\pos` overrides and only swaps in the translated text, so nothing the SRT
format cannot hold is lost. Without it, a generated single-style script from
`hardsub.style` is burned instead.

The encode goes to a `.temp/<name>.mkv` first and is then renamed to `.mp4`:
matroska accepts any stream layout, the rename skips a remux, and no soft
subtitle track is carried over — the burned-in one is the only subtitle in the
output.

Burn-in uses `ass=<script>:shaping=complex`, not the `subtitles` filter. Only
`ass` exposes `shaping`, and the default (`auto`) picks libass's simple shaper,
which draws Thai vowels and tone marks side by side on one level instead of
stacking them. Complex shaping routes through HarfBuzz, so `นี้` and `เดี๋ยว`
come out correctly.

| Flag            | Effect                    |
| --------------- | ------------------------- |
| `--file <name>` | Only process one file     |
| `--force`       | Overwrite existing `.mp4` |

Codecs and rates come from `hardsub` in `config.ts`.

## The translation pipeline

Modelled on [shumiq/ai-novel-translator](https://github.com/shumiq/ai-novel-translator),
adapted from novels to subtitles. Four stages run in order; each one takes the
output of the previous stage.

1. **extraction** — Sweeps the source for character names, places and recurring
   jargon, and merges them into `dictionary.json`. Existing entries are never
   overwritten.
2. **translation** — Translates every cue, using the glossary for established
   renderings.
3. **consistency** — Checks the translation against the original and the
   glossary. Fixes drift, mistranslations and wrong-speaker errors; leaves
   correct cues alone.
4. **humanization** — Light cleanup so the Thai reads like a subtitler wrote
   it rather than a machine.

### Why cues, not lines

The upstream project asks the model to reproduce input line-for-line and then
counts lines to check it. Subtitles make that fragile: a cue can hold several
visual lines, and Thai rewraps differently from English. So each cue is sent as
JSON (`{"id": 1, "text": "..."}`) and the model must return one array entry per
input cue, constrained by `responseSchema`. Timings are never taken from the
model — they are copied from the source file — so a cue can never be lost,
reordered or retimed regardless of what comes back.

### Validation

Every chunk is validated before it is accepted (`src/validate.ts`):

- cue count matches the request
- no empty output where the source had words
- output actually contains Thai
- output is not a copy of the source, and is not majority-Latin

Failures feed the validator's message back to the model and retry. Once a chunk
exhausts its retries it is **bisected** and each half retried, so one stubborn
cue cannot block a whole episode. If a single cue still cannot be translated
the file is abandoned rather than silently written with a hole in it.

Content-filter blocks and exhausted rate limits skip the file and are reported
in the summary.

## Configuration

`config.ts` holds every tunable — model, thinking level, temperature, chunk and
context sizes, source/target languages, series hints, validation switches, retry
backoff, and the hardsub style. Read it for the current values; they are not
repeated here on purpose, so this file cannot drift out of date.

Set `DEBUG=1` for verbose logging (per-cue progress, rejected chunks, retries).

### Subtitle styling

`hardsub.style` in `config.ts` is the style for a **generated** script (the
fallback when there is no source `.ass`).

A source `.ass` is not rebuilt from that style — it keeps its own sizes and
layout, with three exceptions applied to every style in `retextAss()`:
`Fontname` is forced to `hardsub.style.fontName`, `Outline`/`Shadow` are
unified to `hardsub.style.outline`/`shadow` (source scripts mix everything from
0 to 3), and `Fontsize` is raised by `hardsub.inheritedFontSizeStep` since the
source tuned its sizes for its own font.

`playResX` / `playResY` are deliberately independent of the video. libass
scales the script, so the subtitle keeps the same _relative_ size regardless of
whether the source is 720p or 4K.

**On the font:** `hardsub.style.fontName` must equal the family name reported by
the font's name table — check it with a font inspector after swapping the file
in `assetDir`, because a mismatch does not error. libass silently falls back to
some other Thai face instead. Pick a face whose tone marks sit inside normal
line height, so stacked marks (`นี้`) never overlap the line above.

## Layout

```
command/     list.ts, extract.ts, translate.ts, validate.ts, hardsub.ts
config.ts    all tunables
dictionary.json   shared glossary (git-ignored; safe to edit in place)
test/        pipeline regression tests
src/
  ai/        Gemini client, key rotation, typed errors
  pipeline/  stage runner, glossary sweep, orchestrator
  subtitle/  SRT parse/stringify, ASS <-> SRT
  dictionary.ts  glossary load/save/filtering
  streams.ts     subtitle-stream listing (codec, language)
  prompts.ts     per-stage system instructions
  validate.ts    chunk validation
  badchars.ts    bad-character check for finished .srt files
  lang.ts        script detection
```

## Notes

- The SRT and ASS handling is hand-rolled (`src/subtitle/`) rather than
  delegated to `subtitle-converter`, which mangles real-world subtitle files.
  Only three runtime dependencies: `@google/genai`, `ass-parser`,
  `ass-stringify`.
- `.temp/` holds generated ASS files and ffmpeg intermediates, and is safe to
  delete at any time.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run test        # pipeline regression tests, no network or API key needed
bun run check       # both
bun run format      # prettier --write .
```
