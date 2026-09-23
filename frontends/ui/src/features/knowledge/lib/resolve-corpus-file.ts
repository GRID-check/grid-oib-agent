/**
 * Map a human citation label ("OIB-Richtlinie 2.1", "OIB RL 4 Leitfaden",
 * "OIB Begriffsbestimmungen") to the matching base-corpus PDF filename.
 *
 * Chat cards carry only display strings — no file ids — so this heuristic
 * bridges citations to the source viewer. It only ever *adds* a view option:
 * unresolvable labels simply keep their existing external link.
 */

import { canonicalOibFileName } from '@/features/chat/lib/document-names'

export interface CorpusFileCandidate {
  fileName: string
  /** 'index_only' files have no source PDF on this server (seed deployments). */
  origin: string
}

const MAIN_DOC_PREFIX = 'oib-rl_'

export function resolveCorpusFileName(label: string, files: CorpusFileCandidate[]): string | null {
  const norm = label.trim().toLowerCase()
  if (!norm || !/(oib|richtlinie)/.test(norm)) return null

  // Only files whose source actually exists on this server are viewable.
  const viewable = files.filter((f) => f.origin !== 'index_only').map((f) => f.fileName)
  // Match on the canonical spelling (OIB-RL 2.2 ships as `oib-richtlinie_2.2_…`),
  // but hand back the name the file actually has on this server.
  const canonical = new Map(viewable.map((f) => [canonicalOibFileName(f), f]))
  const pick = (name: string | undefined): string | null => (name === undefined ? null : (canonical.get(name) ?? null))

  if (norm.includes('begriffsbestimmung')) {
    return pick([...canonical.keys()].find((f) => f.startsWith(`${MAIN_DOC_PREFIX}begriffsbestimmungen`)))
  }

  const code = /(?:^|\D)(\d(?:\.\d)?)(?:\D|$)/.exec(norm)?.[1]
  if (!code) return null

  const candidates = [...canonical.keys()].filter((f) => f.startsWith(`${MAIN_DOC_PREFIX}${code}_`) || f.startsWith(`${MAIN_DOC_PREFIX}${code}-`))
  if (candidates.length === 0) return null

  const wantsLeitfaden = norm.includes('leitfaden')
  const leitfaden = candidates.find((f) => f.includes('leitfaden'))
  const guideline = candidates.find((f) => !f.includes('leitfaden'))
  return pick((wantsLeitfaden ? leitfaden : guideline) ?? candidates[0])
}
