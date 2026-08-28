'use client'

/**
 * Dev preview for the structured-analysis disclosure — the advanced half of a
 * visual chunk's description, rendered on its own and already expanded.
 *
 * It lives here rather than only inside `/dev/file-preview` because it is two
 * collapsed levels deep in the real pane (Detailed information → Structured
 * data), which a screenshot cannot reach. What must be visible for review is
 * the shape of the rendering: one labelled line per vocabulary category, layers
 * in order, figures that keep their meaning, relations as triples, and the
 * provenance line that stops an inferred reading from looking measured.
 *
 * The second fixture is the point of the whole design: a domain this build has
 * no translations for still renders, from its keys. That is what "adding a
 * domain on the backend needs no frontend release" looks like on screen.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { DrawingStructuredDetails } from '@/features/documents/components/drawing-structured-details'
import { normalizeDrawingStructured } from '@/lib/documents/drawing-structured'

/** An architectural sheet, in the vocabulary this build ships. */
const ARCHITECTURE = {
  schema_version: 4,
  registry: 'architecture+general@850c9b2d770a',
  segment: {
    domain: 'architecture',
    segment_type: 'floor_plan',
    title: 'Regelgeschoss',
    scale: '1:100',
    summary: 'Regelgeschoss mit vier Wohneinheiten um einen zentralen Erschließungskern.',
    entities: [
      { name: 'Wohnen/Essen', category: 'space', role: 'Aufenthalt', measure: '38,4 m²' },
      { name: 'Laubengang', category: 'circulation', role: 'Erschließung', measure: null },
      { name: 'Sicherheitstreppenhaus', category: 'circulation', role: null, measure: null },
      { name: 'Stützenraster 5,40 m', category: 'structure', role: null, measure: null },
      { name: 'Wärmepumpe Sole/Wasser', category: 'services', role: null, measure: null },
      {
        name: 'Schallschutz Wohnungstrennwand',
        category: 'building_physics',
        role: 'R′w 55 dB',
        measure: null,
      },
      { name: 'Brettsperrholz', category: 'material', role: null, measure: null },
    ],
    compositions: [
      {
        component: 'Außenwand',
        layers: [
          { material: 'Lärchenschalung', thickness: '24 mm', function: 'Witterungsschutz' },
          { material: 'Mineralwolle', thickness: '200 mm', function: 'Dämmung' },
          { material: 'Brettsperrholz', thickness: '100 mm', function: 'tragend' },
        ],
      },
    ],
    states: [
      { element: 'Bestandsmauer Hof', state: 'existing' },
      { element: 'Laubengang', state: 'new' },
    ],
    quantities: [
      {
        object: 'Bausubstanz erhalten',
        property: 'Anteil',
        value: '71',
        unit: '%',
        source: 'text',
        confidence: 'high',
      },
      {
        object: 'Wohneinheiten',
        property: 'Anzahl',
        value: '4',
        unit: null,
        source: 'visual',
        confidence: 'high',
      },
    ],
    relations: [
      { subject: 'Laubengang', relation: 'erschließt', object: 'alle vier Wohneinheiten' },
    ],
    annotations: ['5,40', '38,4 m²'],
    source: 'visual',
    confidence: 'medium',
  },
  document: {
    title: 'Wohnbau Nord',
    subtitle: 'Transformation eines Bestandsbaus',
    slogans: ['ABRISS STOPPEN'],
    author: 'Arch. DI Huber',
    institution: 'TU Wien',
    supervision: null,
    location: 'Linz',
    strategies: ['Bestandserhalt', 'Vorfertigung'],
    process_steps: ['Abriss stoppen', 'Bestand transformieren', 'gemeinschaftlich wohnen'],
  },
}

/**
 * A domain that does not exist in this build — categories and states it has no
 * translation for. Everything must still render, from the keys.
 */
const UNKNOWN_DOMAIN = {
  schema_version: 4,
  registry: 'electrical+general@0000deadbeef',
  segment: {
    domain: 'electrical',
    segment_type: 'single_line_diagram',
    title: 'Verteiler UV-2',
    scale: null,
    summary: 'Einpoliges Übersichtsschaltbild der Unterverteilung im 2. Obergeschoss.',
    entities: [
      {
        name: 'Leitungsschutzschalter B16',
        category: 'protective_device',
        role: null,
        measure: null,
      },
      { name: 'FI-Schutzschalter 30 mA', category: 'protective_device', role: null, measure: null },
      {
        name: 'Steigleitung NYM-J 5×10',
        category: 'cable_route',
        role: 'Einspeisung',
        measure: '10 mm²',
      },
    ],
    compositions: [],
    states: [{ element: 'Verteiler UV-2', state: 'planned' }],
    quantities: [
      {
        object: 'Anschlussleistung',
        property: 'Bemessung',
        value: '24',
        unit: 'kW',
        source: 'text',
        confidence: 'high',
      },
    ],
    relations: [{ subject: 'UV-2', relation: 'versorgt', object: 'Wohnungen 2.01 bis 2.04' }],
    annotations: ['UV-2'],
    source: 'text',
    confidence: 'high',
  },
  document: {
    title: 'Elektroplanung',
    subtitle: null,
    slogans: [],
    author: null,
    institution: null,
    supervision: null,
    location: null,
    strategies: [],
    process_steps: [],
  },
}

function Panel({ title, note, payload }: { title: string; note: string; payload: unknown }) {
  const structured = normalizeDrawingStructured(payload)
  if (!structured) return null
  return (
    <section className="border-border bg-card max-w-xl rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-medium">{title}</h2>
      <p className="text-muted-foreground mt-1 text-xs">{note}</p>
      <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
        {structured.segment.summary}
      </p>
      <DrawingStructuredDetails structured={structured} defaultOpen />
    </section>
  )
}

export default function DrawingStructuredDevPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="bg-background min-h-screen space-y-6 p-8">
      <header>
        <h1 className="text-foreground text-lg font-semibold">Structured analysis</h1>
        <p className="text-muted-foreground mt-1 max-w-xl text-sm">
          The advanced disclosure under a visual chunk&apos;s description, opened. The second panel
          uses a domain this build ships no vocabulary for.
        </p>
      </header>
      <Panel
        title="Known domain"
        note="Architecture — categories and states resolve to translated labels."
        payload={ARCHITECTURE}
      />
      <Panel
        title="Unknown domain"
        note="Electrical — no translations exist, so every label is humanized from its key."
        payload={UNKNOWN_DOMAIN}
      />
    </main>
  )
}
