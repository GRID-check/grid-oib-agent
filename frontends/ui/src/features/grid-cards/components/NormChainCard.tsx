/**
 * NormChainCard — the Normenkette (norm hierarchy) rendered FOR THIS ANSWER,
 * marking what binds and what only interprets.
 *
 * A trust artifact: the chain is drawn top-to-bottom along a connective rail,
 * and each link's `rank` sets its weight. Binding ranks (Bundes-/Landesgesetz,
 * Verordnung, and an OIB-Richtlinie where a Land has declared it) render at full
 * ink with a „bindend" tag; interpretive ranks (ÖNORM, Leitfaden) render muted
 * with „auslegend". The distinction is carried by the tag word, not by colour
 * alone, so it survives a greyscale screenshot into a submission.
 */

import { type FC } from 'react'
import { ListTree } from 'lucide-react'
import { SchematicCard } from '../schematics/kit'
import { cn } from '@/lib/utils'
import type { NormChainLinkData, NormChainRank } from '../schematics/types'

interface NormChainCardProps {
  title: string
  links: NormChainLinkData[]
}

interface RankMeta {
  /** German label for the rank badge. */
  label: string
  /** Whether this rank binds (vs. merely interprets). */
  binding: boolean
  /** The binding tag word, when it needs a caveat. */
  bindingTag?: string
}

const RANK: Record<NormChainRank, RankMeta> = {
  bundesgesetz: { label: 'Bundesgesetz', binding: true },
  landesgesetz: { label: 'Landesgesetz', binding: true },
  verordnung: { label: 'Verordnung', binding: true },
  // Binding only where a Land has declared it — the caveat rides in the tag so
  // the card never overstates the chain.
  oib_richtlinie: { label: 'OIB-Richtlinie', binding: true, bindingTag: 'bindend, wenn erklärt' },
  oenorm: { label: 'ÖNORM', binding: false },
  leitfaden: { label: 'Leitfaden', binding: false },
}

export const NormChainCard: FC<NormChainCardProps> = ({ title, links }) => {
  return (
    <SchematicCard icon={ListTree} eyebrow="Normenkette" title={title}>
      <ol className="flex flex-col">
        {links.map((link, index) => {
          const meta = RANK[link.rank] ?? { label: link.rank, binding: false }
          const isLast = index === links.length - 1
          return (
            <li key={`${link.label}-${index}`} className="flex gap-3">
              {/* Rail: a node per link, a connector down to the next. */}
              <div className="flex flex-col items-center" aria-hidden="true">
                <span
                  className={cn(
                    'mt-1.5 size-2.5 shrink-0 rounded-full border',
                    meta.binding
                      ? 'border-foreground bg-foreground'
                      : 'border-muted-foreground bg-transparent',
                  )}
                />
                {!isLast && <span className="w-px flex-1 bg-border" />}
              </div>

              <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', isLast ? 'pb-0' : 'pb-3')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'text-[13.5px] leading-tight',
                      meta.binding ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
                    )}
                  >
                    {link.label}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                    {meta.label}
                  </span>
                  <span
                    className={cn(
                      'text-[11px] font-medium',
                      meta.binding ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {meta.binding ? (meta.bindingTag ?? 'bindend') : 'auslegend'}
                  </span>
                </div>
                {link.note && (
                  <p className="text-xs leading-relaxed text-muted-foreground">{link.note}</p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </SchematicCard>
  )
}
