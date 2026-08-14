/**
 * Comment-aware source scanning, shared by every `doctor` rule that greps raw
 * lines for a token.
 *
 * Incident: running `no-theme-pin` against `~/nextjs/tours/app/layout.tsx`
 * flagged lines that were prose inside a `/** … *\/` block EXPLAINING that the
 * attribute is deliberately not set — a false positive that would have blocked
 * a clean app. A doctor rule that "greps for a string" has to first agree with
 * the language on what counts as code, or a comment describing the very
 * mistake the rule polices trips the rule itself.
 *
 * `stripComments` blanks out comment text while preserving every line break
 * and column offset, so line numbers in `Finding`s still point at the right
 * place in the ORIGINAL file. It is intentionally a lightweight character
 * scanner, not a real parser — good enough for the token-presence checks
 * `doctor` runs, not a substitute for a compiler.
 */

export interface StripOptions {
  /**
   * Treat `//` as starting a line comment. Default `true` (JS/TS/JSX). CSS has
   * no `//` comment syntax — `url(http://…)` would be truncated at the first
   * `//`, so CSS callers must pass `false`.
   */
  lineComments?: boolean;
}

type StringDelim = '"' | "'" | '`';

/**
 * Replace comment text with spaces (newlines preserved), leaving string
 * literals untouched — so a `//` or `/*` inside a URL or a string literal is
 * never mistaken for a comment start, and every remaining character keeps its
 * original line/column position.
 */
export function stripComments(source: string, opts: StripOptions = {}): string {
  const lineComments = opts.lineComments ?? true;
  let out = '';
  let i = 0;
  const n = source.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inString: StringDelim | null = null;

  while (i < n) {
    const c = source[i] as string;
    const next = i + 1 < n ? (source[i + 1] as string) : '';

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      } else {
        out += ' ';
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        out += '  ';
        i += 2;
        inBlockComment = false;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i++;
      continue;
    }

    if (lineComments && c === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      i += 2;
      continue;
    }

    if (c === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i += 2;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** `stripComments`, split into lines — same line count/indices as the source. */
export function stripCommentsLines(source: string, opts: StripOptions = {}): string[] {
  return stripComments(source, opts).split('\n');
}
