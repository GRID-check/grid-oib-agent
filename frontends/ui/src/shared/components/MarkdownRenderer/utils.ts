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
export const isMermaidFence = (className?: string): boolean =>
  /(?:^|\s)language-mermaid(?:$|\s)/.test(className ?? '')

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
