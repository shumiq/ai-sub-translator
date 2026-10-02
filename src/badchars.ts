import { countScripts } from "./lang";
import type { Cue } from "./types";

/**
 * Allow-list copied verbatim from `BAD_CHAR_RE` in
 * shumiq/ai-novel-translator (utils/validate.ts): Thai, Latin, ASCII/Latin-1
 * punctuation, and the symbols Thai subtitles legitimately use. Anything else
 * is a leftover from another script — usually CJK or Cyrillic the model fell
 * back to — or a stray typographic/full-width character. The list is noisy on
 * purpose: this tool exists so a human can fix the file by hand, so a false
 * positive costs a glance rather than a re-translation.
 */
export const BAD_CHAR_RE =
  /[^\p{Script=Thai}\p{Script=Latin}0-9 \t!"#%&'\(\)\*\+,\-\.\/:;<=>\?@\[\\\]^_`{|}~¡¢$＄£¥¦©®°±·¹²³⁴⁵⁶⁷⁸⁹⁰µ×÷‐–—―ー━｜＼＿…‥‼⁉ ′″‵‶‷‸‹›※‼⁽⁾₀₁₂₃₄₅₆₇₈₉€฿₩₽₹￡℃℉№™℗℠℡ℓ♠♣♥♦♪♩♫♬♡○●◎◇◆□■△▲▽▼★☆✦✧←↑→↓↔↕⇒⇔αβγδεζηθικλμνξοπρςστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ∇∝∞∟∠∡∢∣∥∧∨∩∪∫∬∭∮∵∴≈≒≠≡≣≤≥≦≧≪≫⊂⊃⊆⊇⊥∂√∑∏＊＋✕－／＝＜＞«»＃＆％゛゜゠〜「」〖〗『』【】〔〕〈〉《》◤◢、・•´ˊˋ｀̀́ㅂ╹ᗜ\u2460-\u2473\u3251-\u325F\u32B1-\u32BF\uFF9F\uFF9E─♂♀♰✩▹＾￥⇨†✝︎｡Д･з﹃дꙪ᎑╮╯╰╭┐˘◉￣˙꒳ㅿ∀ㅅ＠〃¯˃˂о╬﹏￤◁▷▶✓⚠✽❤✿◕‑−｛｝〘〙〚〛｟｠⁅⁆♢⚪︎◯┣┓┃┛]/gu;

/**
 * A Thai character directly against a Latin one, e.g. `ข้อความtext`. Both
 * scripts are allowed here, but they need a space or a punctuation mark between
 * them, so adjacency is nearly always a typo.
 */
export const MIXED_SCRIPT_RE =
  /\p{Script=Latin}\p{Script=Thai}|\p{Script=Thai}\p{Script=Latin}/gu;

export type IssueKind = "badChar" | "mixedScript" | "nonThai";

export interface LineIssue {
  kind: IssueKind;
  /** Offending characters or script pairs, ready to print. */
  detail: string;
}

export interface SrtIssue extends LineIssue {
  /** 1-based cue number as written in the file. */
  cue: number;
  /** 1-based position of the offending display line inside the cue. */
  line: number;
  startMs: number;
  text: string;
}

function listChars(chars: Iterable<string>): string {
  return [...new Set(chars)]
    .map(
      (char) =>
        `"${char}" (U+${char
          .codePointAt(0)!
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")})`,
    )
    .join(", ");
}

/**
 * Every problem with a single subtitle line. A line can fail more than one
 * check, and all of them are reported: a half-translated line tends to fail
 * several at once, and seeing them together beats fixing them one at a time.
 */
export function inspectLine(text: string): LineIssue[] {
  const issues: LineIssue[] = [];

  const bad = text.match(BAD_CHAR_RE);
  if (bad) {
    issues.push({
      kind: "badChar",
      detail: `bad character: ${listChars(bad)}`,
    });
  }

  const mixed = text.match(MIXED_SCRIPT_RE);
  if (mixed) {
    const pairs = [...new Set(mixed)].map((pair) => `"${pair}"`).join(", ");
    issues.push({
      kind: "mixedScript",
      detail: `Thai/Latin with no separator: ${pairs}`,
    });
  }

  // Only lines with letters are judged: a cue that is just "-" or "…" is
  // punctuation, not an untranslated line.
  const { thai, letters } = countScripts(text);
  if (thai === 0 && letters > 0) {
    issues.push({
      kind: "nonThai",
      detail: "no Thai characters — line looks untranslated",
    });
  }

  return issues;
}

/** Runs `inspectLine` over every display line of every cue. */
export function checkCues(cues: Cue[]): SrtIssue[] {
  const issues: SrtIssue[] = [];

  for (const cue of cues) {
    for (let i = 0; i < cue.lines.length; i++) {
      const text = cue.lines[i]!;
      for (const issue of inspectLine(text)) {
        issues.push({
          ...issue,
          cue: cue.index,
          line: i + 1,
          startMs: cue.startMs,
          text,
        });
      }
    }
  }

  return issues;
}
