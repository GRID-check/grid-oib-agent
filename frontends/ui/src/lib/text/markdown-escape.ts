/**
 * Text that stays text when it is written into Markdown: the one escape for
 * every writer that puts what a person typed, or what a stranger sent, into a
 * `.md` someone else reads. The Protokoll's Markdown export
 * (`lib/annotations/export.ts`) and the Outlook import's mail note
 * (`lib/mail-import/naming.ts`) use it.
 *
 * Two readers have to agree that the text is text, and they read lines
 * differently:
 *
 * - a CommonMark renderer (the preview's, or whatever the office pastes the
 *   file into), for which `# `, `- `, `1. `, `===`, `---`, a fence or a `[`
 *   all mean structure;
 * - the knowledge layer's Markdown chunker (`text_formats.py`), which cuts a
 *   section at every line `^#{1,6}\s+` outside a fence and toggles a fence at
 *   every line `^\s*(```|~~~)`. It splits with Python's `str.splitlines()`,
 *   which ends a line at `\v`, `\f`, `\x1c`–`\x1e`, `\x85`, `\u2028` and
 *   `\u2029` as well as at `\r` and `\n`, and its `\s` also matches `\x1c`–`\x1f`
 *   and `\x85`. A mail body is untrusted, so a line start or a space is
 *   whatever either reader counts as one (the pieces below): a body line `## 14.10.2026 · MA 37` after a form feed
 *   would otherwise be a citable section of the note under a heading nobody
 *   wrote.
 *
 * Every ASCII punctuation may be backslash-escaped in CommonMark, and an
 * escaped one renders as itself, so escaping more than needed costs a
 * backslash in the raw file and nothing on screen.
 */

/*
 * The expressions are literals, so a scanner sees each one whole, and they
 * share four pieces, spelled out in each:
 *
 * - line start, where either reader starts a line: the input's start, or
 *   after any terminator Python's `splitlines` honours,
 *   `(?<=^|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])`;
 * - line end, the same terminators ahead, `(?=$|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])`;
 * - space after a marker, what either reader counts as one: JavaScript's `\s`
 *   plus the separators only Python's `\s` holds, `[\s\x1c-\x1f\x85]`;
 * - indent, whitespace that is no line terminator, `[^\S\n\r\v\f\u2028\u2029]`.
 *   It must not cross a line end: a `\s*` indent ran on from every line start
 *   over all the blank lines after it, so a mail of whitespace-only lines
 *   took quadratic time (50,000 lines, 44 seconds).
 */

/** `#` to `######`, or a `+`/`-` bullet, at a line's start (a dash run is a thematic break or a setext underline). */
// eslint-disable-next-line no-control-regex -- the separators are the point: Python's splitlines ends a line at them
const MARKER_AT_START = /(?<=^|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])([^\S\n\r\v\f\u2028\u2029]*)(#{1,6}|[+-])(?=[\s\x1c-\x1f\x85]|[+-]|$)/g
/** `1.` or `1)`: an ordered list item. */
// eslint-disable-next-line no-control-regex -- as above
const ORDINAL_AT_START = /(?<=^|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])([^\S\n\r\v\f\u2028\u2029]*\d{1,9})([.)])(?=[\s\x1c-\x1f\x85]|$)/g
/** A line of `=` alone: a setext underline that would make the line above a heading. */
// eslint-disable-next-line no-control-regex -- as above
const SETEXT_LINE = /(?<=^|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])([^\S\n\r\v\f\u2028\u2029]*)(=+[^\S\n\r\v\f\u2028\u2029]*)(?=$|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])/g

/**
 * Text, escaped so that it stays text: an Anmerkung that carries a `*` or a
 * `[` is what a person typed, not Markdown. Only the characters that act
 * anywhere on a line are escaped here: emphasis, code spans and fences
 * (`` ` ``, `~`), links and images, raw HTML and autolinks, table cells, and
 * the backslash itself. Thematic breaks of `*` or `_` need nothing more. The
 * ones that act only at a line's start are {@link escapeLineStarts}'.
 */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, (char) => `\\${char}`)
}

/**
 * „# Termin“, „- offen“, „1. Stock“, `---` and `===` at a line's start are
 * text, not a heading, a list, a thematic break or a setext underline. `>` is
 * escaped inline, as are the fences, so a quote or a code block never opens
 * either. The input is expected to have been through {@link escapeInline}
 * already, or to be Markdown whose inline marks are meant.
 */
export function escapeLineStarts(text: string): string {
  return text
    .replace(MARKER_AT_START, (_match, indent: string, marker: string) => `${indent}\\${marker}`)
    .replace(ORDINAL_AT_START, (_match, digits: string, mark: string) => `${digits}\\${mark}`)
    .replace(SETEXT_LINE, (_match, indent: string, rule: string) => `${indent}\\${rule}`)
}

/** Inline text escaped and line starts neutralised: a string that stays text wherever it lands. */
export function escapeMarkdown(text: string): string {
  return escapeLineStarts(escapeInline(text))
}
