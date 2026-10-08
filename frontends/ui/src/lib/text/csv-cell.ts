/**
 * One cell of a CSV a person will open in a spreadsheet.
 *
 * RFC 4180 quoting (every cell quoted, embedded quotes doubled) keeps a comma in
 * an answer from shifting a column. It does nothing about formula injection: a
 * cell whose text starts with `=`, `+`, `-` or `@` is evaluated by Excel,
 * LibreOffice and Sheets even inside quotes, and so is one that starts with a tab
 * or a carriage return, which some of them strip before reading the rest. The
 * text in these exports is written by users and by a model (questions,
 * comments, answers), so a cell like `=HYPERLINK("https://…")` is one complaint
 * away. OWASP's mitigation: prefix such a cell with an apostrophe, which every
 * spreadsheet reads as "this is text" and does not display.
 *
 * A reader that wants the original back strips one leading apostrophe in front
 * of those characters (`scripts/feedback_to_cases.py` does).
 */

/** First characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const inert = FORMULA_LEAD.test(text) ? `'${text}` : text
  return `"${inert.replace(/"/g, '""')}"`
}
