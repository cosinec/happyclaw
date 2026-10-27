/**
 * Markdown chunking that never leaves a fenced code block open across a
 * message boundary: a chunk split inside a fence is closed with ``` and the
 * next chunk reopens it with the same language tag. Shared by the channels
 * whose renderers need each message to stand alone (Discord, Telegram).
 */

/**
 * Split text into chunks of at most `limit` characters, preserving code fences.
 *
 * When a split occurs inside a fenced code block (``` ... ```), the current
 * chunk is closed with ``` and the next chunk reopens with ```lang.
 */
export function splitMarkdownWithCodeFences(
  text: string,
  limit: number,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let insideCodeBlock = false;
  let codeFenceLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point — prefer splitting at newlines near the limit
    let splitAt = limit;

    // Reserve space for potential closing/opening fences
    const reservedChars = insideCodeBlock ? 8 : 0; // "```\n" = 4, "```lang\n" ≈ up to ~20
    const effectiveLimit = limit - reservedChars;

    // Look for a newline near the effective limit (search within last 200 chars)
    const searchStart = Math.max(0, effectiveLimit - 200);
    const searchRegion = remaining.slice(searchStart, effectiveLimit);
    const lastNewline = searchRegion.lastIndexOf('\n');
    if (lastNewline !== -1) {
      splitAt = searchStart + lastNewline + 1; // Split after the newline
    } else {
      splitAt = effectiveLimit;
    }

    // Ensure we always make progress
    if (splitAt <= 0) splitAt = effectiveLimit > 0 ? effectiveLimit : limit;

    let chunk = remaining.slice(0, splitAt);

    // Track code fence state within this chunk
    const fenceState = trackCodeFences(chunk, insideCodeBlock, codeFenceLang);

    if (fenceState.insideCodeBlock) {
      // We're splitting inside a code block — close it
      chunk = chunk + '\n```';
      insideCodeBlock = true;
      codeFenceLang = fenceState.lang;
    } else {
      insideCodeBlock = false;
      codeFenceLang = '';
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt);

    // If we were inside a code block, reopen it in the next chunk
    if (insideCodeBlock && remaining.length > 0) {
      const opener = codeFenceLang ? '```' + codeFenceLang + '\n' : '```\n';
      remaining = opener + remaining;
    }
  }

  return chunks;
}

/**
 * Simple state machine to track whether we end up inside a code fence
 * after processing the given text.
 */
function trackCodeFences(
  text: string,
  initiallyInside: boolean,
  initialLang: string,
): { insideCodeBlock: boolean; lang: string } {
  let inside = initiallyInside;
  let lang = initialLang;

  // Match lines that start with ``` (with optional language tag)
  const fenceRegex = /^(`{3,})(.*)?$/gm;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (!inside) {
      // Opening fence
      inside = true;
      lang = (match[2] || '').trim();
    } else {
      // Closing fence
      inside = false;
      lang = '';
    }
  }

  return { insideCodeBlock: inside, lang };
}
