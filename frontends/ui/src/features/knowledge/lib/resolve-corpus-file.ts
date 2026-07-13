/**
 * Map a human citation label ("OIB-Richtlinie 2.1", "OIB RL 4 Leitfaden",
 * "OIB Begriffsbestimmungen") to the matching base-corpus PDF filename.
 *
 * Chat cards carry only display strings — no file ids — so this heuristic
 * bridges citations to the source viewer. It only ever *adds* a view option:
 * unresolvable labels simply keep their existing external link.
 */

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

  if (norm.includes('begriffsbestimmung')) {
    return viewable.find((f) => f.startsWith(`${MAIN_DOC_PREFIX}begriffsbestimmungen`)) ?? null
  }

  const code = /(?:^|\D)(\d(?:\.\d)?)(?:\D|$)/.exec(norm)?.[1]
  if (!code) return null

  const candidates = viewable.filter((f) => f.startsWith(`${MAIN_DOC_PREFIX}${code}_`) || f.startsWith(`${MAIN_DOC_PREFIX}${code}-`))
  if (candidates.length === 0) return null

  const wantsLeitfaden = norm.includes('leitfaden')
  const leitfaden = candidates.find((f) => f.includes('leitfaden'))
  const guideline = candidates.find((f) => !f.includes('leitfaden'))
  return (wantsLeitfaden ? leitfaden : guideline) ?? candidates[0]
}
