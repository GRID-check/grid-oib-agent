'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { humanizeTerm, type DrawingStructured } from '@/lib/documents/drawing-structured'

/**
 * The advanced half of one visual chunk's description: everything the vision
 * model recognised as STRUCTURE rather than prose — the things it named,
 * assembly layers, figures with their meaning, relations, and how sure it is.
 *
 * Collapsed inside an already-collapsed section on purpose. The free-text
 * description above answers "what is this drawing"; this answers "what exactly
 * did Piloti record about it", which a much smaller number of people ask,
 * usually when checking whether an answer can be trusted. That is also why
 * provenance and confidence are shown at all: an inferred scale must never
 * read like a measured one.
 *
 * Nothing here knows a domain. Categories and states arrive as vocabulary
 * keys; a key this build has a translation for is translated, and one it has
 * never seen is humanized from the key — so a domain added on the backend
 * shows up here without a frontend release.
 *
 * `defaultOpen` exists for the `/dev` preview: in the real pane this sits two
 * collapsed levels deep, so a screenshot of it closed is a screenshot of one
 * grey word, and the visual-evidence gate would be satisfied by a picture
 * showing none of what the change does.
 */
export function DrawingStructuredDetails({
  structured,
  defaultOpen = false,
}: {
  structured: DrawingStructured
  defaultOpen?: boolean
}) {
  const t = useTranslations('files')
  const [open, setOpen] = useState(defaultOpen)
  const { segment, document } = structured

  /**
   * A vocabulary term's label. The translator returns the NAMESPACED key path
   * when there is no entry (`files.preview.…`), so the miss is detected by
   * suffix rather than equality. A miss is expected, not a defect: it is what
   * a domain added on the backend after this build shipped looks like, and the
   * humanized key is a readable label until someone adds a translation. The
   * dev-only warning the translator logs is the nudge to do that.
   */
  const term = (group: string, key: string) => {
    const path = `preview.visualDetails.structured.${group}.${key}`
    const translated = t(path)
    return translated.endsWith(path) ? humanizeTerm(key) : translated
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="touch-target text-muted-foreground duration-snap hover:text-foreground flex items-center gap-1 text-[11px] font-medium transition-colors ease-out motion-reduce:transition-none"
      >
        {t('preview.visualDetails.structured.toggle')}
        <ChevronDown
          className={cn(
            'duration-quick size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>

      {open && (
        <dl className="border-border/60 mt-1.5 space-y-1 border-l pl-2.5 text-[11px] leading-relaxed">
          {segment.entityGroups.map((group) => (
            <Row key={group.category} label={term('categories', group.category)}>
              {group.entities
                .map((entity) => {
                  const extras = [entity.role, entity.measure].filter(Boolean).join(', ')
                  return extras ? `${entity.name} (${extras})` : entity.name
                })
                .join(' · ')}
            </Row>
          ))}

          {segment.compositions.map((composition, index) => (
            <Row
              key={`${composition.component}-${index}`}
              label={t('preview.visualDetails.structured.composition', {
                component: composition.component,
              })}
            >
              {composition.layers
                .map((layer) =>
                  [layer.material, layer.thickness, layer.purpose && `(${layer.purpose})`]
                    .filter(Boolean)
                    .join(' ')
                )
                .join(' | ')}
            </Row>
          ))}

          {segment.states.length > 0 && (
            <Row label={t('preview.visualDetails.structured.states')}>
              {segment.states
                .map((entry) => `${entry.element}: ${term('state', entry.state)}`)
                .join(' · ')}
            </Row>
          )}

          {segment.quantities.map((quantity, index) => (
            <Row
              key={`${quantity.object}-${index}`}
              label={`${quantity.object} — ${quantity.property}`}
            >
              {[quantity.value, quantity.unit].filter(Boolean).join(' ')}
            </Row>
          ))}

          {segment.relations.length > 0 && (
            <Row label={t('preview.visualDetails.structured.relations')}>
              {segment.relations
                .map((r) => `${r.subject} → ${r.relation} → ${r.object}`)
                .join(' · ')}
            </Row>
          )}

          {segment.annotations.length > 0 && (
            <Row label={t('preview.visualDetails.structured.annotations')}>
              {segment.annotations.join(' · ')}
            </Row>
          )}

          <DocumentRows document={document} />

          {(segment.source || segment.confidence) && (
            <Row label={t('preview.visualDetails.structured.provenance')}>
              {[
                segment.source && term('source', segment.source),
                segment.confidence &&
                  t('preview.visualDetails.structured.confidenceValue', {
                    level: term('confidence', segment.confidence),
                  }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Row>
          )}
        </dl>
      )}
    </div>
  )
}

/**
 * Document-level facts (title block, strategies) — identical for every segment
 * on the sheet, so they read as context rather than as this drawing's own.
 */
function DocumentRows({ document }: { document: DrawingStructured['document'] }) {
  const t = useTranslations('files')
  const credits = [document.author, document.institution, document.supervision, document.location]
    .filter(Boolean)
    .join(', ')

  return (
    <>
      {document.title && (
        <Row label={t('preview.visualDetails.structured.project')}>
          {[document.title, document.subtitle].filter(Boolean).join(' — ')}
        </Row>
      )}
      {credits && <Row label={t('preview.visualDetails.structured.credits')}>{credits}</Row>}
      {document.slogans.length > 0 && (
        <Row label={t('preview.visualDetails.structured.slogans')}>
          {document.slogans.join(' · ')}
        </Row>
      )}
      {document.strategies.length > 0 && (
        <Row label={t('preview.visualDetails.structured.strategies')}>
          {document.strategies.join(' · ')}
        </Row>
      )}
      {document.processSteps.length > 0 && (
        <Row label={t('preview.visualDetails.structured.processSteps')}>
          {document.processSteps.join(' → ')}
        </Row>
      )}
    </>
  )
}

/** One `label: value` line. The label never truncates; the value wraps. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground/80 shrink-0">{label}</dt>
      <dd className="text-foreground/90 min-w-0">{children}</dd>
    </div>
  )
}
