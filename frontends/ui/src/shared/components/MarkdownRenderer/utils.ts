import { transliterateGerman } from '@/lib/text/latinize'
import type { SupportedLanguage } from './types'

const LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  ts: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  python: 'python',
  json: 'json',
  bash: 'bash',
  sh: 'shell',
  shell: 'shell',
  html: 'html',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
}

/**
 * Extract language from markdown code fence className
 * e.g., "language-typescript" -> "typescript"
 */
export const getLanguageFromClassName = (className?: string): SupportedLanguage => {
  if (!className) return 'bash' // Default fallback for unlabeled code blocks

  const match = className.match(/language-(\w+)/)
  if (!match) return 'bash'

  const lang = match[1].toLowerCase()
  return LANGUAGE_MAP[lang] || 'bash'
}

/**
 * Is this fence a diagram rather than a listing?
 *
 * Asked of the RAW class name, not of `getLanguageFromClassName`, because that
 * function's job is to pick a highlighting theme and it answers `bash` for
 * everything it does not know — including mermaid. Widening its union to carry
 * a language nothing highlights would make every consumer of
 * `SupportedLanguage` handle a member that is not one.
 */
/**
 * Mermaid's diagram keywords, as they appear on a graph's FIRST line.
 *
 * Deliberately anchored to the first line rather than searched for: `graph` and
 * `pie` are ordinary words, and a shell listing that mentions one mid-file is a
 * listing. A real diagram declares its type before anything else.
 */
const MERMAID_OPENERS =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta|C4Context)\b/

/** `%%{init: …}%%` and `%% comment` lines may precede the diagram keyword. */
const MERMAID_PREAMBLE = /^%%/

export const isMermaidFence = (className?: string, source?: string): boolean => {
  if (/(?:^|\s)language-mermaid(?:$|\s)/.test(className ?? '')) return true

  // The fence the model actually writes. Asked for a diagram it reaches for
  // mermaid and then, often enough to be the common case rather than the edge
  // one, opens the fence bare — ``` with no language, or with a language it
  // guessed. `getLanguageFromClassName` answers `bash` for anything it does not
  // know, so the answer promised a drawing and printed a shell listing.
  //
  // Sniffing the CONTENT is the deterministic half of that fix: a fence whose
  // first line is a mermaid diagram keyword is a diagram whatever its tag says,
  // and no shell, Python or TypeScript listing opens with `flowchart TD`. The
  // model-side half — teaching it to tag the fence — belongs in the prompt and
  // cannot be relied on alone, which is why this reads the source.
  const firstLine = (source ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !MERMAID_PREAMBLE.test(line))
  return firstLine !== undefined && MERMAID_OPENERS.test(firstLine)
}

/**
 * Heading anchor ids.
 *
 * German letters are spelled out rather than dropped: `[^\w\s-]` below treats
 * every one of them as punctuation, so "Gebäude" slugified to "gebude" and
 * "Außenwand" to "auenwand" — ids no in-page link ever names. The content this
 * renders is German (chat answers, OIB reports), so that is the common
 * heading, not an edge case, and a missed anchor is silent: `scrollToAnchor`
 * returns when `getElementById` finds nothing.
 *
 * Deliberately `transliterateGerman` and NOT `latinize`: folding every other
 * diacritic would change ids that are already published in links, where today
 * an `é` is simply dropped. Everything from the trim down is likewise
 * unchanged, so every ASCII id already in use (and the `1.2` → `12`
 * punctuation shape) stays byte-identical.
 *
 * Lives here, beside the renderer that assigns the ids, rather than inside it:
 * anything that wants to LINK to a heading has to spell the id the same way,
 * and a second implementation of this is the one bug such a feature reliably
 * ships with. The report outline calls it.
 */
export const headingAnchorId = (text: string): string =>
  transliterateGerman(text.toLowerCase())
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
