'use client'

/**
 * Platform → cards: what the agent can actually put on screen.
 *
 * Grid answers in prose plus cards, and the card set is the ceiling on how
 * richly it can answer anything. That ceiling used to be legible only from
 * `cards/models.py`, so the question "can Grid show me a Stellplatznachweis?"
 * had no answer inside the product — and the follow-up ("it can't; how do I
 * ask for it?") had none either.
 *
 * Every entry is a REAL render: the sample card goes through the same
 * `GridCards` dispatcher chat uses, so this page cannot show a card that the
 * renderers do not produce. The values each card carries come from the
 * catalog endpoint, which derives them from the Pydantic union — nothing on
 * this page is a second hand-maintained list.
 *
 * The previews are inert (see `InertPreview`): a `memory_proposal`'s "Yes"
 * writes an org-scoped memory and a `project_profile_patch`'s "Accept" applies
 * a JSON Patch. In a gallery those buttons are decoration, and decoration must
 * not be able to fire a write.
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Image as ImageIcon, Lock, MousePointerClick } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SectionCard } from '@/features/platform/components/section-card'
import { GridCards } from '@/features/grid-cards'
import { PREVIEW_EXCLUDED, previewFixtureFor } from '@/features/grid-cards/preview-fixtures'
import { useTranslations } from '@/i18n'

interface CardFieldDto {
  name: string
  type: string
  required: boolean
  description: string
  constraints: string[]
}

interface CatalogCardDto {
  type: string
  model: string
  summary: string
  emittedBy: 'agent' | 'system'
  interaction: 'presentational' | 'interactive'
  fields: CardFieldDto[]
}

interface CatalogDto {
  cards: CatalogCardDto[]
  buildingBlocks: Record<string, CardFieldDto[]>
  cardCount: number
  featureRequest: { repository: string; url: string; label: string }
}

/**
 * A preview that cannot be operated.
 *
 * `inert` is set through the DOM property rather than as a JSX attribute: this
 * app is on React 18, which passes unknown props through as attributes but
 * types them as errors. The property is the same switch — it removes the whole
 * subtree from hit-testing, focus order and the accessibility tree, which is
 * what a picture of a card should be. `pointer-events-none` alone would leave
 * the buttons keyboard-reachable, and a tabbed-to "Yes" still writes.
 */
const InertPreview: FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.inert = true
  }, [])
  return (
    <div ref={ref} className="pointer-events-none select-none">
      {children}
    </div>
  )
}

const CatalogEntry: FC<{ card: CatalogCardDto }> = ({ card }) => {
  const t = useTranslations('platform')
  const [open, setOpen] = useState(false)
  const fixture = useMemo(() => previewFixtureFor(card.type), [card.type])
  const excluded = PREVIEW_EXCLUDED[card.type]

  return (
    <li className="flex flex-col gap-3 py-5" data-testid={`platform-card-${card.type}`}>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{card.type}</code>
          {card.interaction === 'interactive' ? (
            <Badge variant="secondary" className="font-normal">
              <MousePointerClick className="size-3" aria-hidden />
              {t('cards.interactiveBadge')}
            </Badge>
          ) : null}
          {card.emittedBy === 'system' ? (
            <Badge variant="outline" className="text-muted-foreground font-normal">
              <Lock className="size-3" aria-hidden />
              {t('cards.systemBadge')}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm">{card.summary}</p>
      </div>

      {fixture ? (
        <InertPreview>
          <GridCards cards={[fixture]} projectId={null} />
        </InertPreview>
      ) : (
        <div className="text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-3 py-4 text-xs">
          <ImageIcon className="size-4 shrink-0" aria-hidden />
          {excluded === 'needsDocuments' ? t('cards.noPreviewDocuments') : t('cards.noPreviewModel')}
        </div>
      )}

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="self-start px-2">
            {open ? t('cards.hideValues') : t('cards.showValues', { count: String(card.fields.length) })}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* The field list is wide on small screens — scroll it in its own
              container so the page body never scrolls horizontally. */}
          <div className="overflow-x-auto">
            <dl className="mt-2 flex min-w-md flex-col divide-y text-xs">
              {card.fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
                  <dt className="sm:w-52 sm:shrink-0">
                    <code className="font-mono">{field.name}</code>
                    {field.required ? <span className="text-destructive ml-1">*</span> : null}
                    <span className="text-muted-foreground ml-2 font-mono">{field.type}</span>
                  </dt>
                  <dd className="text-muted-foreground min-w-0">
                    {field.description || '—'}
                    {field.constraints.length > 0 ? (
                      <span className="ml-1 font-mono">({field.constraints.join('; ')})</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

export const PlatformCards: FC = () => {
  const t = useTranslations('platform')
  const [payload, setPayload] = useState<CatalogDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/cards')
      if (!res.ok) throw new Error(String(res.status))
      setPayload((await res.json()) as CatalogDto)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const featureRequest = payload?.featureRequest

  return (
    <SectionCard
      title={t('cards.title')}
      description={t('cards.description')}
      loading={loading}
      skeletonRows={6}
      error={error}
      errorMessage={t('cards.loadError')}
      onRetry={() => void load()}
      testId="platform-cards"
      action={
        featureRequest ? (
          <Button asChild variant="outline" size="sm">
            <a href={featureRequest.url} target="_blank" rel="noopener noreferrer">
              {t('cards.requestCta')}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        ) : undefined
      }
    >
      <p className="text-muted-foreground text-sm">
        {t('cards.count', { count: String(payload?.cardCount ?? 0) })}
      </p>
      <ul className="mt-2 flex flex-col divide-y">
        {(payload?.cards ?? []).map((card) => (
          <CatalogEntry key={card.type} card={card} />
        ))}
      </ul>
      {featureRequest ? (
        // Repeated at the foot deliberately: the reader who has scrolled every
        // card and not found theirs is exactly the one with a request to file.
        <div className="bg-muted/40 mt-6 flex flex-col gap-2 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">{featureRequest.label}</p>
          <Button asChild size="sm" className="shrink-0">
            <a href={featureRequest.url} target="_blank" rel="noopener noreferrer">
              {t('cards.requestCta')}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        </div>
      ) : null}
    </SectionCard>
  )
}
