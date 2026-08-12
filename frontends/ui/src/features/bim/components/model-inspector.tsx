'use client'

/**
 * What you get when you click something.
 *
 * The whole of the metadata story in this redesign, and it only exists once
 * there is a selection. That is the trade: the reader gets the entire viewport
 * for the building, and the moment they point at a wall they get a card about
 * that wall — rather than a permanent column of tables that was mostly empty
 * and always in the way.
 *
 * ## What it leads with
 *
 * A name, what kind of thing it is, and which floor it is on. Those three
 * answer "what did I just click", which is the only question a click has
 * asked. Everything a schema knows — GlobalId, PredefinedType, every property
 * set the exporter wrote — is real and occasionally decisive, so it is kept;
 * it is just folded away, because leading with `IfcWallStandardCase` and a
 * 22-character GlobalId is how the old page managed to make a building look
 * like a debugging console.
 *
 * ## Why "Ask Piloti" is the footer
 *
 * The card can only report what the exporter wrote. The question a reader
 * actually has — does this wall satisfy OIB 2, what does the Bauordnung say
 * about this opening — is not in the IFC, and the assistant is the surface
 * that can answer it. The GlobalId rides along in the question so the agent
 * queries THIS element rather than one it guesses from a description.
 */

import Link from 'next/link'
import { EyeOff, MessageSquarePlus, Scan } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { elementQuestionHref } from '../lib/element-question'
import { formatPropertyValue } from '../lib/format-value'
import { humaniseIfcType } from '../lib/stage-model'
import type { BimElementDetail } from '../hooks/use-bim-model'
import { ViewerField, ViewerFieldGroup, ViewerPanel } from './viewer'

export interface ModelInspectorProps {
  element: BimElementDetail | null
  isLoading: boolean
  error: string | null
  projectId: string
  modelFilename: string | null
  onClose: () => void
  /**
   * Take this component out of the way, or look at nothing but it.
   *
   * On the card rather than in the dock because both act on THIS element, and
   * a dock button whose meaning depends on an invisible selection is a control
   * that does something different every time it is pressed. Omitted by
   * surfaces that have nowhere to put the building back.
   */
  onHide?: () => void
  onIsolate?: () => void
  className?: string
}

export function ModelInspector({
  element,
  isLoading,
  error,
  projectId,
  modelFilename,
  onClose,
  onHide,
  onIsolate,
  className,
}: ModelInspectorProps): JSX.Element {
  const t = useTranslations('bim')
  const { locale } = useLocale()

  // The heading has to say something before the fetch lands, and it must not
  // say the WRONG thing: "Bauteil" while loading, never a stale name from the
  // element the reader clicked a second ago.
  /**
   * Three states, not two.
   *
   * The query answers a GlobalId this model does not contain with `200
   * {element: null}` — the normal outcome for a link written against another
   * revision, or for a link whose model could not be matched. That is not the
   * same fact as "not fetched yet", and rendering it as one left a card
   * permanently headed "Wird geladen…" whose body read "Wählen Sie ein
   * Bauteil" — inside a card that only exists because something IS selected.
   */
  const missing = !isLoading && !error && !element
  const title = element?.name?.trim()
    || (element ? humaniseIfcType(element.ifcType) : t(missing ? 'element.notFound' : 'stage.selection.loading'))

  const subtitle = element
    ? [humaniseIfcType(element.ifcType), element.storeyName].filter(Boolean).join(' · ')
    : undefined

  return (
    <ViewerPanel
      title={title}
      subtitle={subtitle}
      closeLabel={t('stage.selection.close')}
      onClose={onClose}
      className={className}
      footer={
        element && (
          <div className="space-y-1">
            {/*
              Two verbs, and they are different verbs: hiding takes THIS out
              of the way, isolating takes everything else. Side by side
              because the reader is choosing between them, not working down a
              list.
            */}
            {(onHide || onIsolate) && (
              <div className="flex gap-1">
                {onIsolate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 justify-start gap-2"
                    onClick={onIsolate}
                  >
                    <Scan className="size-4" aria-hidden="true" />
                    {t('stage.selection.isolate')}
                  </Button>
                )}
                {onHide && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 justify-start gap-2"
                    onClick={onHide}
                  >
                    <EyeOff className="size-4" aria-hidden="true" />
                    {t('stage.selection.hide')}
                  </Button>
                )}
              </div>
            )}
          <Button asChild variant="ghost" size="sm" className="w-full justify-start gap-2">
            <Link
              href={elementQuestionHref(
                projectId,
                {
                  globalId: element.globalId,
                  ifcType: element.ifcType,
                  name: element.name,
                  storeyName: element.storeyName,
                },
                { modelFilename }
              )}
            >
              <MessageSquarePlus className="size-4" aria-hidden="true" />
              {t('stage.selection.ask')}
            </Link>
          </Button>
          </div>
        )
      }
    >
      {error && <p className="text-destructive text-xs">{t('properties.loadFailed')}</p>}

      {!error && !element && (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          {isLoading && <Spinner className="size-3" />}
          {isLoading ? t('stage.selection.loading') : t('element.notFound')}
        </div>
      )}

      {element && (
        <>
          <ViewerFieldGroup label={t('stage.selection.about')}>
            <ViewerField label={t('properties.ifcType')}>{humaniseIfcType(element.ifcType)}</ViewerField>
            {element.storeyName && (
              <ViewerField label={t('properties.storey')}>{element.storeyName}</ViewerField>
            )}
            {element.tag && <ViewerField label={t('properties.tag')}>{element.tag}</ViewerField>}
            {element.materials.length > 0 && (
              <ViewerField label={t('properties.materials')}>
                {element.materials.join(', ')}
              </ViewerField>
            )}
          </ViewerFieldGroup>

          {/*
            Quantities are the one part of a schema an architect reads
            unprompted — an area, a volume, a length. They stay above the fold
            for that reason, while the property sets that describe HOW the
            exporter modelled the thing go below it.
          */}
          {Object.entries(element.quantities).map(([setName, quantities]) => (
            <ViewerFieldGroup key={setName} label={setName}>
              {Object.entries(quantities).map(([name, value]) => (
                <ViewerField key={name} label={name}>
                  <span className="tabular-nums">
                    {(Math.round(value * 1000) / 1000).toLocaleString(locale)}
                  </span>
                </ViewerField>
              ))}
            </ViewerFieldGroup>
          ))}

          <ModelInspectorDetails element={element} locale={locale} label={t('stage.selection.technical')} />
        </>
      )}
    </ViewerPanel>
  )
}

/**
 * Everything the schema knows, folded away.
 *
 * A native `<details>`, not a Radix collapsible: it is disclosure and nothing
 * else, it is keyboard- and screen-reader-operable with no code, and it
 * survives a print or a find-in-page. The one thing added is that it stays
 * shut by default, which is the entire point of the redesign expressed in one
 * attribute.
 */
function ModelInspectorDetails({
  element,
  locale,
  label,
}: {
  element: BimElementDetail
  locale: string
  label: string
}): JSX.Element {
  const t = useTranslations('bim')
  const propertySets = Object.entries(element.properties)

  return (
    <details className="border-border mt-3 border-t pt-2">
      {/*
        `pointer-coarse:min-h-11`: an 11 px line of text was the entire hit
        area, and behind it sit the GlobalId, the classifications and every
        property set — everything this card deliberately folds away. On a phone
        that is a door the size of its own label.

        Grown with padding rather than `min-h` and a flex centre: changing a
        `<summary>`'s display has a history of costing it its toggle in Safari,
        and padding needs no display change at all.
      */}
      <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 marker:content-none pointer-coarse:min-h-11 pointer-coarse:py-3.5 cursor-pointer rounded text-[11px] font-semibold tracking-wide outline-none focus-visible:ring-2">
        {label}
      </summary>

      <div className="mt-2">
        <ViewerFieldGroup label={t('properties.identity')}>
          <ViewerField label={t('properties.globalId')}>
            <span className="font-mono text-[10px] break-all">{element.globalId}</span>
          </ViewerField>
          {element.predefinedType && (
            <ViewerField label={t('properties.predefinedType')}>{element.predefinedType}</ViewerField>
          )}
          {element.typeName && (
            <ViewerField label={t('properties.typeName')}>{element.typeName}</ViewerField>
          )}
        </ViewerFieldGroup>

        {element.classifications.length > 0 && (
          <ViewerFieldGroup label={t('properties.classifications')}>
            {element.classifications.map((classification) => (
              <ViewerField
                key={`${classification.system}-${classification.identification}`}
                label={classification.system ?? '—'}
              >
                {[classification.identification, classification.name].filter(Boolean).join(' ') || '—'}
              </ViewerField>
            ))}
          </ViewerFieldGroup>
        )}

        {propertySets.map(([setName, properties]) => (
          <ViewerFieldGroup key={setName} label={setName}>
            {Object.entries(properties).map(([name, value]) => (
              <ViewerField key={name} label={name}>
                {formatPropertyValue(value, locale)}
              </ViewerField>
            ))}
          </ViewerFieldGroup>
        ))}
      </div>
    </details>
  )
}
