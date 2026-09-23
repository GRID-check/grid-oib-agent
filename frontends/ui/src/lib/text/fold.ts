/**
 * A name folded for comparison: trimmed and lower-cased in the reader's
 * locale rules. How the plan's Unterlagen, the picker and the run tell "the
 * same document" apart when the only identity on the wire is a file name —
 * `Plan.PDF` and ` plan.pdf` are one document.
 */
export const foldName = (name: string): string => name.trim().toLocaleLowerCase()
