'use client'

/**
 * Dev preview — every card, drawn the way the chat draws it: through A2UI
 * (`GridCardItem` → `A2uiCard` → `A2uiSurface` on the Piloti catalog,
 * ADR-0065), plus compositions an answer may emit.
 *
 * Each section's `data-a2ui-surface` marks a card A2UI drew; a section without
 * one fell back to the direct component, and the console says why. The
 * gallery (`/dev/cards`) draws the components directly and is the place to
 * review a card's own design; this page is the place to review the path.
 *
 * 404s outside development. Pinned to German.
 */

import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { GridCardItem } from '@/features/grid-cards/components/GridCards'
import { CARD_PREVIEW_FIXTURES } from '@/features/grid-cards/preview-fixtures'
import { validateGridCards, type GridCard } from '@/shared/cards/schemas'

const OIB2 = { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' }

/** Compositions: the shapes ADR-0065 lets an answer build. Values show form only. */
const COMPOSITIONS = validateGridCards([
  {
    type: 'surface',
    title: 'Tragende Bauteile — nach Gebäudeklasse',
    components: [
      {
        id: 'root',
        component: 'Tabs',
        tabs: [
          { title: 'GK 4', child: 'gk4' },
          { title: 'GK 5', child: 'gk5' },
        ],
      },
      {
        id: 'gk4',
        component: 'legal_basis',
        law: 'OIB-Richtlinie 2',
        article: '3.1',
        section: 'Tabelle 1b',
        original_text: 'Tragende Bauteile in Gebäuden der Gebäudeklasse 4 sind in REI 60 auszuführen.',
        summary: 'In GK 4 genügt REI 60 für tragende Bauteile oberirdisch.',
      },
      {
        id: 'gk5',
        component: 'legal_basis',
        law: 'OIB-Richtlinie 2',
        article: '3.1',
        section: 'Tabelle 1b',
        original_text: 'Tragende Bauteile in Gebäuden der Gebäudeklasse 5 sind in R 90 auszuführen.',
        summary: 'In GK 5 verlangen tragende Bauteile R 90.',
      },
    ],
  },
  {
    type: 'surface',
    title: 'Treppe und Geländer nebeneinander',
    components: [
      { id: 'root', component: 'Row', children: ['treppe', 'gelaender'] },
      {
        id: 'treppe',
        component: 'calculation',
        title: 'Schrittmaßregel',
        steps: [
          {
            label: 'Schrittmaß',
            operation: 'sum',
            unit: 'cm',
            operands: [
              { label: 'Steigung', value: 17, unit: 'cm', factor: 2, provenance: 'declared' },
              { label: 'Auftritt', value: 30, unit: 'cm', provenance: 'declared' },
            ],
          },
        ],
        limit: { comparator: 'between', value: 59, upper: 65, label: 'Schrittmaßregel', reference: OIB2 },
      },
      {
        id: 'gelaender',
        component: 'legal_basis',
        law: 'OIB-Richtlinie 4',
        article: '4.1',
        summary: 'Absturzsicherungen ab 1,00 m Absturzhöhe; über 12 m 1,10 m.',
      },
    ],
  },
]).filter((card): card is GridCard => Boolean(card))

const CARDS = Object.entries(CARD_PREVIEW_FIXTURES) as [string, GridCard][]

export default function A2uiPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="text-foreground mx-auto flex w-full max-w-[680px] flex-col gap-8 p-6">
        <h1 className="text-lg font-semibold">A2UI — every card through the chat&apos;s path</h1>
        {COMPOSITIONS.map((card, index) => (
          <section key={`composition-${index}`} data-card={`composition_${index}`} className="flex flex-col gap-2">
            <h2 className="text-muted-foreground font-mono text-xs">composition {index + 1}</h2>
            <GridCardItem card={card} index={index} />
          </section>
        ))}
        {CARDS.map(([type, card], index) => (
          <section key={type} data-card={type} className="flex flex-col gap-2">
            <h2 className="text-muted-foreground font-mono text-xs">{type}</h2>
            <GridCardItem card={card} index={index + COMPOSITIONS.length} />
          </section>
        ))}
      </main>
    </I18nProvider>
  )
}
