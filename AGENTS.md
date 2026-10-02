# AGENTS.md

Guidance for coding agents working in this repository.

## Runtime and toolchain

- **Runtime:** Bun. Scripts are plain `.ts` files run with `bun <file>.ts`.
- **Module system:** ES modules (`"type": "module"`). Never use `require()`
  for project code — the only exception is `src/vendor.ts`, which loads the two
  untyped CommonJS packages (`ass-parser`, `ass-stringify`) via
  `createRequire`.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `noEmit`. Prefer `import type { X } from ...` for type-only imports —
  `verbatimModuleSyntax` will not allow them to be elided otherwise.
- **No build step.** `tsconfig.json` only type-checks.

## Commands

```bash
bun run typecheck   # tsc --noEmit — must be clean
bun run test        # pipeline regression tests, no network / API key required
bun run check       # both, run before finishing any change
bun run format      # prettier --write .
```

Formatting is prettier with stock defaults and no config file — the committed
source is already prettier-clean, so `bun run format` should be a no-op. If it
produces a diff on files you did not touch, the defaults drifted; fix that in a
dedicated commit rather than mixing it into a feature change.

The pipeline entry points are `command/extract.ts`,
`command/translate.ts`, `command/hardsub.ts`, plus `command/validate.ts` for
post-hoc checks on finished `output/*.srt` files. Run them from the project
root (`bun command/extract.ts`); they resolve `PROJECT_ROOT` themselves, so
cwd does not actually matter, but relative paths in logs assume the root.

## Invariants — do not break these

These are the properties the design exists to guarantee. Each is covered by a
check in `test/pipeline.test.ts`.

1. **Timings always come from the source file.** The model only ever returns
   cue _text_. `applyTexts()` in `src/pipeline/index.ts` spreads the original
   cue and replaces `lines`. Never let model output touch `startMs`/`endMs`.
2. **One cue in, one cue out.** Cues are exchanged as JSON
   (`{"id":…, "text":…}`) against a `responseSchema`, never as free text with
   line counting. Do not "simplify" this back to counting lines — that was the
   upstream project's approach and it is why subtitles break. This holds across
   the _whole_ range: `processRange` walks it one `chunkSize` chunk at a time
   and `runTextStage` throws if it did not get one text back per cue. A stage
   that translated only its first chunk once shipped a file with cues 61..1603
   blank, so keep the count assertion even if it looks redundant.
3. **A file is never written lossy.** If a cue cannot be translated after
   retries, `runTextStage` throws and the file is abandoned. Do not add a
   fallback that fills a failed cue with the source text.
4. **Dictionary entries are append-only.** `runGlossaryStage` skips keys that
   already exist. Users edit `dictionary.json` to pin wording; silently
   overwriting their choices would defeat the point.
5. **`Fontname` must match the bundled font's family name.** libass resolves
   it silently and falls back to another Thai face when it does not match, so
   `hardsub.style.fontName` in `config.ts` is the single source of truth: it is
   written into generated scripts and forced onto every style of an inherited
   source script in `retextAss()`. Never name a font in code or docs — change
   the config and the bundled asset together, or the two contradict each other.

## Where things live

| Concern                             | File                       |
| ----------------------------------- | -------------------------- |
| All tunables                        | `config.ts`                |
| Shared types                        | `src/types.ts`             |
| Gemini calls, key rotation, retries | `src/ai/client.ts`         |
| Retry-on-feedback, chunk bisection  | `src/pipeline/stage.ts`    |
| Glossary sweep                      | `src/pipeline/glossary.ts` |
| Stage orchestration                 | `src/pipeline/index.ts`    |
| Prompt text                         | `src/prompts.ts`           |
| Chunk validation                    | `src/validate.ts`          |
| Bad-character check for output      | `src/badchars.ts`          |
| SRT read/write                      | `src/subtitle/srt.ts`      |
| ASS read/write                      | `src/subtitle/ass.ts`      |
| ffmpeg/ffprobe wrappers             | `src/ffmpeg.ts`            |

## Conventions

- **Logging:** use `Logger` from `src/logger.ts`. `Logger.debug` is gated on
  `DEBUG=1`. Never `console.log` in `src/` or `command/`.
- **Errors:** the three commands catch at top level, print via `Logger.error`
  and set a non-zero exit code. In the library code, throw typed errors from
  `src/ai/errors.ts`; never let a raw SDK error escape to the user.
- **Paths:** run ffmpeg with `cwd: PROJECT_ROOT` (already the default in
  `runFfmpeg`) and pass _relative_ paths. Absolute Windows paths need escaping
  in the `ass` filter and are a known source of breakage.
- **Comments:** explain _why_, especially for the invariants above. Do not
  narrate what the code does.

## Gotchas

- **ASS centiseconds, not milliseconds.** `assTimeToMs()` multiplies the fourth
  field by 10. Getting this wrong shifts subtitles by up to 90ms per timestamp
  and is easy to miss on short clips.
- **ASS files get a UTF-8 BOM** on write (`cuesToAss`). Some libass builds
  mis-detect Thai without it.
- **`playResX/Y` is independent of the video.** libass scales the script, so
  the configured value keeps the subtitle the same relative size at 720p and at
  4K. Changing it changes apparent size.
- **Content-filter blocks are per-file, not per-request.** A `ProhibitedContentError`
  aborts the whole file; a `HighDemandError` means every key was rate-limited.
  Both are reported in the summary rather than crashing the run.
- **bitmap subtitles cannot be extracted.** PGS/VobSub/DVB have no text form;
  `extract.ts` says so and suggests `--stream`. This is not a bug to fix.
- **Burn-in must use `ass=…:shaping=complex`.** The `subtitles` filter has no
  `shaping` option, and libass's default (`auto`) picks the simple shaper, which
  puts Thai vowels and tone marks on one level instead of stacking them — every
  stacked syllable (`นี้`, `เดี๋ยว`) renders wrong. Verified empirically: outline,
  shadow, font size and the `Encoding` field make no difference at all (libass
  ignores `Encoding` entirely), only the shaper does.
- **`-ss` before `-i` makes libass draw nothing.** Fast input seeking resets the
  timestamps the filter sees, so subtitles appear absent. Put `-ss` after `-i`
  when test-rendering a single frame.
