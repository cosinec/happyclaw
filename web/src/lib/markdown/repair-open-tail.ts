import { endsInOpenFence, FENCE_PATTERN } from '../markdown-blocks';

/** `![alt`, `![alt]` or `![alt](partial-url` at the end of the line. */
const PARTIAL_IMAGE = /(^|[^\\])!\[[^\][`\n]*(?:\](?:\([^()\s`]*)?)?$/;
/** `[text](partial-url` at the end of the line. */
const PARTIAL_LINK = /(^|[^!\\])\[([^\][`\n]*)\]\([^()\s`]*$/;

const ESCAPE = /\\[!-/:-@[-`{-~]/g;
const BACKTICKS = /`+/g;
/** A literal URL, without the punctuation that ends a sentence after it. */
const LITERAL_URL = /(?:https?:\/\/|www\.)\S*?(?=[*_~.,:;!?'")\]]*(?:\s|$))/g;
const LINK_DESTINATION = /\]\([^()\s]*\)/g;

const SPACE = /\s/;
/**
 * Full-width punctuation counts as a letter, as remark-cjk-friendly reads it:
 * `**注意：**正文` is bold.
 */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const ASCII_WORD = /[A-Za-z0-9]/;

const isSpace = (char: string) => SPACE.test(char);
const isPunctuation = (char: string) =>
  PUNCTUATION.test(char) && !CJK.test(char);

/**
 * `text` with what cannot hold emphasis delimiters (code spans, escapes,
 * URLs, link destinations) masked by letters of the same length, or null
 * when a code span is still open.
 */
function maskLiterals(text: string): string | null {
  const mask = (match: string) => 'a'.repeat(match.length);
  const unescaped = text.replace(ESCAPE, mask);
  const ticks = [...unescaped.matchAll(BACKTICKS)];
  let masked = '';
  let from = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    const open = ticks[i];
    let close = i + 1;
    while (close < ticks.length && ticks[close][0].length !== open[0].length) {
      close += 1;
    }
    if (close === ticks.length) return null;
    const end = ticks[close].index + ticks[close][0].length;
    masked += unescaped.slice(from, open.index) + 'a'.repeat(end - open.index);
    from = end;
    i = close;
  }
  masked += unescaped.slice(from);
  return masked.replace(LITERAL_URL, mask).replace(LINK_DESTINATION, mask);
}

interface DelimiterRun {
  char: string;
  start: number;
  end: number;
  canOpen: boolean;
  canClose: boolean;
  /** A single tilde: as often a range (3~5 天) as a strikethrough. */
  loose: boolean;
}

/**
 * Emphasis delimiter runs of `masked` with whether each can open or close,
 * by CommonMark's flanking rules; null when one is ambiguous (`***`).
 */
function delimiterRuns(masked: string): DelimiterRun[] | null {
  const runs: DelimiterRun[] = [];
  for (let start = 0; start < masked.length; ) {
    const char = masked[start];
    if (char !== '*' && char !== '_' && char !== '~') {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (masked[end] === char) end += 1;
    if (end - start >= 3) return null;
    const before = masked[start - 1] ?? '\n';
    const after = masked[end] ?? '\n';
    const left =
      !isSpace(after) &&
      (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
    const right =
      !isSpace(before) &&
      (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
    let canOpen = left;
    let canClose = right;
    if (char === '_') {
      canOpen = left && (!right || isPunctuation(before));
      canClose = right && (!left || isPunctuation(after));
    } else if (ASCII_WORD.test(before) && ASCII_WORD.test(after)) {
      // `2*3` is arithmetic far more often than emphasis.
      canOpen = false;
    }
    const loose = char === '~' && end - start === 1;
    runs.push({ char, start, end, canOpen, canClose, loose });
    start = end;
  }
  return runs;
}

/**
 * A delimiter run at the very end with nothing after it yet, which the next
 * characters will most likely make an opener (`这是 **`).
 */
function isDanglingOpener(run: DelimiterRun, masked: string): boolean {
  if (run.loose || run.end !== masked.length) return false;
  const before = masked[run.start - 1] ?? '\n';
  if (isSpace(before) || isPunctuation(before)) return true;
  return run.char !== '_' && CJK.test(before);
}

/**
 * Close the emphasis still open at the end of `paragraph` (`masked` by
 * `maskLiterals`), whose last line starts at `lineStart`; the paragraph as
 * it is when nothing is open there, or when an opener is earlier or unsure.
 */
function closeEmphasis(
  paragraph: string,
  masked: string | null,
  lineStart: number,
): string {
  if (masked === null) return paragraph;
  const runs = delimiterRuns(masked);
  if (runs === null) return paragraph;
  let text = paragraph;
  const open: DelimiterRun[] = [];
  for (const run of runs) {
    const top = open[open.length - 1];
    if (run.canClose && open.some((entry) => entry.char === run.char)) {
      const length = run.end - run.start;
      const topLength = top.end - top.start;
      if (top.char === run.char && topLength === length) {
        open.pop();
        continue;
      }
      // A closer still being written: `**粗体*`.
      if (
        top.char === run.char &&
        length < topLength &&
        run.end === masked.length
      ) {
        text += run.char.repeat(topLength - length);
        open.pop();
        continue;
      }
      if (run.loose) continue;
      return paragraph;
    }
    if (run.loose) continue;
    if (run.canOpen) open.push(run);
    else if (isDanglingOpener(run, masked)) text = text.slice(0, run.start);
  }
  if (open.length === 0) return text;
  if (open[0].start < lineStart) return paragraph;
  // The opener must have text after it already: `**` alone stays.
  if (!/[^\s*_~]/.test(text.slice(open[open.length - 1].end))) {
    return paragraph;
  }
  const body = text.trimEnd();
  const closers = open
    .map((run) => run.char.repeat(run.end - run.start))
    .reverse()
    .join('');
  return body + closers + text.slice(body.length);
}

/** Where the paragraph holding the line at `lineStart` begins. */
function paragraphStart(block: string, lineStart: number): number {
  let start = lineStart;
  while (start > 0) {
    const previous = block.lastIndexOf('\n', start - 2) + 1;
    const line = block.slice(previous, start - 1);
    if (!line.trim() || FENCE_PATTERN.test(line)) break;
    start = previous;
  }
  return start;
}

/**
 * Display text for the open (last) block of a streamed reply: inline syntax
 * still being written at its end shows the way it will once it closes, so
 * the text does not flip as the closing characters arrive. `**粗体` is bold
 * instead of showing its asterisks, `[文字](https://exa` shows its text and
 * a half-written image nothing. Only the end of the last paragraph changes,
 * only where its reading is clear; code and anything unsure stay as written.
 * The final message renders the real text.
 */
export function repairOpenTail(block: string): string {
  if (!block || block.endsWith('\n') || endsInOpenFence(block)) return block;
  const lineStart = block.lastIndexOf('\n') + 1;
  const line = block.slice(lineStart);
  if (!line.trim() || FENCE_PATTERN.test(line)) return block;
  const start = paragraphStart(block, lineStart);
  const masked = maskLiterals(block.slice(start));
  // Inside a code span still being written, everything is code.
  if (masked === null) return block;
  const shown = line.replace(PARTIAL_IMAGE, '$1').replace(PARTIAL_LINK, '$1$2');
  const paragraph = block.slice(start, lineStart) + shown;
  return (
    block.slice(0, start) +
    closeEmphasis(
      paragraph,
      shown === line ? masked : maskLiterals(paragraph),
      lineStart - start,
    )
  );
}
