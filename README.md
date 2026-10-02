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
bun command/extract.ts
```

Pulls the **first** subtitle stream out of every video in `input/` and writes
`input/<name>.srt`. ASS/SSA subtitles are extracted as `.ass` and converted to
`.srt` in Node; everything else goes straight through ffmpeg as SRT.

| Flag           | Effect                                      |
| -------------- | ------------------------------------------- |
| `--force`      | Overwrite existing `.srt` files             |
| `--stream <n>` | Pick the n-th subtitle stream (default `0`) |

Run with `DEBUG=1` to list every subtitle stream first. Bitmap subtitles
(PGS, VobSub, DVD) cannot become text — re-encode with a text track or choose
another stream with `--stream`.

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

Re-renders `output/<name>.srt` as a styled ASS script and muxes `input/<name>.mkv`
into `output/<name>.mp4`.

| Flag            | Effect                                              |
| --------------- | --------------------------------------------------- |
| `--file <name>` | Only process one file                               |
| `--force`       | Overwrite existing `.mp4`                           |
| `--keep-subs`   | Also copy the original soft subtitle tracks through |

Encoding is `libx264 -preset slow -b:v 2M`, `aac -b:a 192k`, `+faststart`.

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

`config.ts` holds everything:

| Key                                 | Default                    | Notes                                       |
| ----------------------------------- | -------------------------- | ------------------------------------------- |
| `model`                             | `gemini-flash-lite-latest` |                                             |
| `thinking`                          | `low`                      | `off` \| `low` \| `medium` \| `high`        |
| `temperature`                       | `0.3`                      |                                             |
| `chunkSize`                         | `60`                       | cues per request for stages 2-4             |
| `extractionChunkSize`               | `400`                      | cues per request for stage 1                |
| `previousCueCount`                  | `25`                       | finalised cues sent as context              |
| `sourceLanguage` / `targetLanguage` | `English` / `Thai`         |                                             |
| `additionalContext`                 | `[]`                       | series-specific hints added to every prompt |
| `validation.*`                      | see file                   | turn individual checks on or off            |

Set `DEBUG=1` for verbose logging (per-cue progress, rejected chunks, retries).

### Subtitle styling

`hardsub.style` in `config.ts` controls the ASS script: `fontName`, `fontSize`
(24), `outline`, `shadow`, margins and colours.

`playResX` / `playResY` are set to 1920x1080. libass scales the script to the
video, so the subtitle keeps the same _relative_ size regardless of whether the
source is 720p or 4K.

**On the font name:** Mali ships each weight as its own family, so
`Mali-Medium.ttf` reports a Win32 family name of `"Mali Medium"` with
subfamily `"Regular"`. A `Fontname` of plain `Mali` therefore resolves to
**Mali-Regular**, not Medium, with no warning. The default is `"Mali Medium"` —
change it to `"Mali SemiBold"`, `"Mali Bold"` and so on to pick another weight.

## Layout

```
command/     extract.ts, translate.ts, validate.ts, hardsub.ts
config.ts    all tunables
dictionary.json   shared glossary (git-ignored; safe to edit in place)
test/        pipeline regression tests
src/
  ai/        Gemini client, key rotation, typed errors
  pipeline/  stage runner, glossary sweep, orchestrator
  subtitle/  SRT parse/stringify, ASS <-> SRT
  dictionary.ts  glossary load/save/filtering
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
