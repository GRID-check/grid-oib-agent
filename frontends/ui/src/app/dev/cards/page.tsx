'use client'

/**
 * Card-gallery dev page: renders every Grid card type with realistic fixture
 * data so visual changes can be reviewed (and screenshotted) in one place.
 * Not linked from anywhere and returns 404 outside development.
 *
 * The whole gallery is pinned to German with `fixedLocale`. Without it the
 * provider falls back to `defaultLocale` ('en'), which is how the committed
 * screenshot came to show an English „Ask about this" chip in the middle of a
 * German Anforderungsliste: the cards whose copy is hardcoded German looked
 * right and only the translated ones leaked. See docs/ux/visual-screenshots.md.
 */

import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { SummaryCard } from '@/features/grid-cards/components/SummaryCard'
import { KeyTakeawaysCard } from '@/features/grid-cards/components/KeyTakeawaysCard'
import { VerdictHeaderCard } from '@/features/grid-cards/components/VerdictHeaderCard'
import { ConditionTreeCard } from '@/features/grid-cards/components/ConditionTreeCard'
import { CalloutCard } from '@/features/grid-cards/components/CalloutCard'
import { CalculationCard } from '@/features/grid-cards/components/CalculationCard'
import { ProcessMapCard } from '@/features/grid-cards/components/ProcessMapCard'
import { DocumentChecklistCard } from '@/features/grid-cards/components/DocumentChecklistCard'
import { DeadlineTimelineCard } from '@/features/grid-cards/components/DeadlineTimelineCard'
import { ChangeImpactCard } from '@/features/grid-cards/components/ChangeImpactCard'
import { DiagramCard } from '@/features/grid-cards/components/DiagramCard'
import { FollowUpsCard } from '@/features/grid-cards/components/FollowUpsCard'
import { LegalBasisCard } from '@/features/grid-cards/components/LegalBasisCard'
import { RequirementChecklistCard } from '@/features/grid-cards/components/RequirementChecklistCard'
import { ComparisonTableCard } from '@/features/grid-cards/components/ComparisonTableCard'
import { BuildingSectionCard } from '@/features/grid-cards/schematics/BuildingSectionCard'
import { StairDiagramCard } from '@/features/grid-cards/schematics/StairDiagramCard'
import { DimensionDiagramCard } from '@/features/grid-cards/schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '@/features/grid-cards/schematics/SetbackPlanCard'
import { EgressDiagramCard } from '@/features/grid-cards/schematics/EgressDiagramCard'
import { DaylightIncidenceCard } from '@/features/grid-cards/schematics/DaylightIncidenceCard'
import { GuardrailCheckCard } from '@/features/grid-cards/schematics/GuardrailCheckCard'
import { DensityCheckCard } from '@/features/grid-cards/schematics/DensityCheckCard'
import { FireAccessPlanCard } from '@/features/grid-cards/schematics/FireAccessPlanCard'
import { AcousticCheckCard } from '@/features/grid-cards/schematics/AcousticCheckCard'
import { FireCompartmentCard } from '@/features/grid-cards/schematics/FireCompartmentCard'
import { ThermalEnvelopeCard } from '@/features/grid-cards/schematics/ThermalEnvelopeCard'
import { EnergyPerformanceCard } from '@/features/grid-cards/schematics/EnergyPerformanceCard'
import { ElevatorRequirementCard } from '@/features/grid-cards/schematics/ElevatorRequirementCard'
import { ParkingRequirementCard } from '@/features/grid-cards/schematics/ParkingRequirementCard'
import { GridCards } from '@/features/grid-cards/components/GridCards'
import type { GridCard } from '@/shared/cards/schemas'

const OIB2 = { document: 'OIB-Richtlinie 2', section: 'Pkt. 3.1', edition: 'Ausgabe Mai 2023' }
const OIB3 = { document: 'OIB-Richtlinie 3', section: 'Pkt. 9.1.1', edition: 'Ausgabe Mai 2023' }
const OIB4 = { document: 'OIB-Richtlinie 4', section: 'Pkt. 2.2', edition: 'Ausgabe Mai 2023' }
const OIB6 = { document: 'OIB-Richtlinie 6', section: 'Pkt. 4.2', edition: 'Ausgabe Mai 2023' }

const Section = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <section id={id} data-card={id} className="flex flex-col gap-2">
    <h2 className="font-mono text-xs text-muted-foreground">{id}</h2>
    {children}
  </section>
)

export default function CardsGalleryPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Gallery />
    </I18nProvider>
  )
}

function Gallery() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <h1 className="text-lg font-semibold">Grid card gallery</h1>

      <Section id="summary">
        <SummaryCard
          type="summary"
          title="Gebäudeklasse 4 – Anforderungen im Überblick"
          content="Für Ihr Wohngebäude mit Fluchtniveau 9,8 m gilt Gebäudeklasse 4. Daraus folgen erhöhte Anforderungen an Brandschutz und Erschließung."
          key_points={[
            'Fluchtniveau 9,8 m → GK 4 (Grenze: 11 m)',
            'Treppenhaus als gesicherter Fluchtbereich erforderlich',
            'Barrierefreier Aufzug ab 3 oberirdischen Geschossen',
          ]}
        />
      </Section>

      {/* The §A2 cross-card rule, which only exists when both cards are on
          screen: the same summary under a verdict header demotes its title
          from the Value step to a muted Body/600 lead-in, because two 15px+
          lines arriving together give the reader two places to start. Demoted
          and not dropped — the field the model filled still renders. Rendered
          through the dispatcher so it goes through the same provider the chat
          uses — the rule is invisible from either component alone. */}
      <Section id="summary_under_verdict">
        <GridCards
          cards={
            [
              {
                type: 'verdict_header',
                verdict: 'Gebäudeklasse 4',
                subject: 'Einstufung des Gebäudes',
                confidence: 'high',
              },
              {
                type: 'summary',
                title: 'Gebäudeklasse 4 – Anforderungen im Überblick',
                content:
                  'Für Ihr Wohngebäude mit Fluchtniveau 9,8 m gilt Gebäudeklasse 4. Daraus folgen erhöhte Anforderungen an Brandschutz und Erschließung.',
                key_points: [
                  'Fluchtniveau 9,8 m → GK 4 (Grenze: 11 m)',
                  'Treppenhaus als gesicherter Fluchtbereich erforderlich',
                ],
              },
            ] as GridCard[]
          }
          projectId={null}
        />
      </Section>

      <Section id="key_takeaways">
        <KeyTakeawaysCard
          title="Gebäudeklasse 4 – was daraus folgt"
          items={[
            {
              text: 'Fluchtniveau 9,80 m → Gebäudeklasse 4',
              detail:
                'Maßgeblich ist das oberste Fluchtniveau über dem angrenzenden Gelände; die Grenze zu GK 5 liegt bei 11 m.',
            },
            {
              text: 'Tragende Bauteile mindestens REI 60',
              detail: 'In Kellergeschossen gilt REI 90, unabhängig von der Gebäudeklasse.',
            },
            {
              text: 'Treppenhaus als gesicherter Fluchtbereich erforderlich',
              detail:
                'Rauchdichte Abtrennung in jedem Geschoss; die Ausführung ist mit der Brandschutzplanung abzustimmen.',
            },
            { text: 'Barrierefreier Aufzug ab drei oberirdischen Geschossen' },
          ]}
        />
      </Section>

      {/* All four kinds side by side: the word carries the signal, the tone
          only reinforces it — which is exactly what has to be reviewable in
          both themes at once. */}
      <Section id="callout">
        <CalloutCard
          kind="hinweis"
          text="Für Zu- und Umbauten im Bestand gelten die Anforderungen nur im Umfang des Eingriffs."
          detail="Wird die Gebäudeklasse durch den Zubau angehoben, ist das gesamte Gebäude neu zu beurteilen."
        />
        <CalloutCard
          kind="achtung"
          title="Gilt nur in Wien"
          text="Die Wiener Bauordnung weicht bei der Berechnung des Fluchtniveaus von den übrigen Ländern ab."
        />
        <CalloutCard
          kind="frist"
          text="Die Bauverhandlung ist binnen sechs Wochen nach Einreichung anzuberaumen."
          detail="Die Frist ruht, solange die Behörde eine Ergänzung des Einreichplans verlangt hat."
        />
        <CalloutCard
          kind="tipp"
          text="Ein Schnitt durch das Treppenhaus mit eingetragenem Fluchtniveau erspart in der Regel eine Rückfrage der Behörde."
        />
      </Section>

      {/* Three derivations, chosen so the review question is „did the card
          compute this, and does the number agree with the verdict beside it?":
          the Schrittmaßregel inside its range with a propagated band; a GFZ
          over its limit; and a two-step U-value whose exact result (0,2504)
          would round to the limit itself, so the card must print the fourth
          decimal rather than contradict its own „nicht erfüllt". */}
      <Section id="calculation">
        <CalculationCard
          title="Schrittmaßregel – Treppenlauf Haus A"
          steps={[
            {
              label: 'Schrittmaß',
              operation: 'sum',
              unit: 'cm',
              operands: [
                {
                  label: 'Steigung',
                  value: 17,
                  unit: 'cm',
                  factor: 2,
                  provenance: 'computed',
                  tolerance: 0.5,
                  source: 'Einreichplan, Schnitt A-A',
                },
                { label: 'Auftritt', value: 30, unit: 'cm', provenance: 'declared' },
              ],
            },
          ]}
          limit={{
            comparator: 'between',
            value: 59,
            upper: 65,
            label: 'Schrittmaßregel',
            reference: OIB4,
          }}
        />
        <CalculationCard
          title="Geschossflächenzahl – Grundstück Musterweg 12"
          steps={[
            {
              label: 'GFZ',
              operation: 'quotient',
              operands: [
                { label: 'Bruttogeschossfläche', value: 2400, unit: 'm²', source: 'Flächenaufstellung, Stand 03/2026' },
                { label: 'Grundfläche', value: 800, unit: 'm²', provenance: 'declared' },
              ],
            },
          ]}
          limit={{ comparator: '<=', value: 2.5, label: 'Bebauungsplan PD 8123' }}
          note="Terrassen und Loggien sind in der Bruttogeschossfläche nicht enthalten."
        />
        <CalculationCard
          title="U-Wert Außenwand aus den Wärmedurchlasswiderständen"
          steps={[
            {
              label: 'Wärmedurchgangswiderstand',
              operation: 'sum',
              unit: 'm²K/W',
              operands: [
                { label: 'Rsi', value: 0.13, unit: 'm²K/W' },
                { label: 'Dämmung 20 cm', value: 3.5, unit: 'm²K/W' },
                { label: 'Ziegel 25 cm', value: 0.31, unit: 'm²K/W' },
                { label: 'Rse', value: 0.04, unit: 'm²K/W' },
              ],
            },
            {
              label: 'U-Wert',
              operation: 'quotient',
              unit: 'W/(m²K)',
              operands: [{ label: '', value: 1 }, { label: 'Rges', step: 1 }],
            },
          ]}
          limit={{ comparator: '<=', value: 0.25, reference: OIB6 }}
        />
      </Section>

      {/* At rest: the step the project is at is open with its Voraussetzungen
          and its Grundlage, everything before it ticked off, everything after
          hollow. The switched state — another step opened against it — has its
          own target, /dev/process-map. */}
      <Section id="process_map">
        <ProcessMapCard
          title="Baubewilligungsverfahren – Wien"
          current_step={2}
          steps={[
            {
              label: 'Einreichung',
              summary: 'Einreichunterlagen werden bei der Baubehörde eingebracht.',
              actor: 'Bauwerber',
              requires: ['Einreichplan', 'Baubeschreibung', 'Energieausweis'],
              produces: ['Aktenzeichen'],
              reference: { document: 'Wiener Bauordnung', section: '§ 63' },
            },
            {
              label: 'Bauverhandlung',
              summary: 'Mündliche Verhandlung mit Nachbarn und Amtssachverständigen.',
              actor: 'Baubehörde',
              duration: 'binnen sechs Wochen',
              produces: ['Verhandlungsschrift'],
              reference: { document: 'Wiener Bauordnung', section: '§ 70' },
            },
            {
              label: 'Baubewilligung',
              summary: 'Bescheid mit den Auflagen aus der Verhandlung.',
              actor: 'Baubehörde',
              produces: ['Baubewilligungsbescheid'],
            },
            {
              label: 'Baubeginnsanzeige',
              summary: 'Der Baubeginn ist der Behörde anzuzeigen.',
              actor: 'Bauwerber',
              requires: ['rechtskräftige Baubewilligung'],
            },
            {
              label: 'Fertigstellungsanzeige',
              summary: 'Nach Fertigstellung, mit den Ausführungsbestätigungen.',
              actor: 'Bauwerber',
              requires: ['Ausführungsbestätigungen der Fachplaner'],
            },
          ]}
          reference={{ document: 'Wiener Bauordnung', section: '§§ 60 ff.' }}
        />
      </Section>

      {/* Two cards, because the pair IS the review: the first has statuses the
          conversation settled and the tally counts them; the second has none at
          all and says so in a sentence where the first draws numbers. A single
          fixture would only ever show one of the two, and the one it hid is the
          common case. */}
      <Section id="document_checklist">
        <DocumentChecklistCard
          title="Einreichunterlagen – Neubau Wohngebäude, Wien"
          items={[
            {
              label: 'Einreichplan',
              requirement: 'required',
              issuer: 'Ziviltechniker:in',
              status: 'present',
              note: 'dreifach, im Maßstab 1:100',
              reference: { document: 'Wiener Bauordnung', section: '§ 63 Abs. 1 lit. a' },
            },
            {
              label: 'Baubeschreibung',
              requirement: 'required',
              issuer: 'Ziviltechniker:in',
              reference: { document: 'Wiener Bauordnung', section: '§ 63 Abs. 1 lit. b' },
            },
            {
              label: 'Energieausweis',
              requirement: 'required',
              issuer: 'befugte Fachperson',
              status: 'missing',
              reference: OIB6,
            },
            {
              label: 'Grundbuchsauszug',
              requirement: 'conditional',
              condition: 'nur wenn der Bauwerber nicht Eigentümer der Liegenschaft ist',
              issuer: 'Bauwerber',
            },
            {
              label: 'Gutachten der MA 19',
              requirement: 'conditional',
              condition: 'nur bei einem Gebäude in einer Schutzzone',
              issuer: 'Baubehörde',
            },
          ]}
          reference={{ document: 'Wiener Bauordnung', section: '§ 63' }}
        />
        <DocumentChecklistCard
          title="Einreichunterlagen – Zubau, ohne Angaben zum Stand"
          items={[
            {
              label: 'Auswechslungsplan',
              requirement: 'required',
              issuer: 'Ziviltechniker:in',
              reference: { document: 'Wiener Bauordnung', section: '§ 73' },
            },
            {
              label: 'Statische Vorbemessung',
              requirement: 'conditional',
              condition: 'nur bei Eingriff in tragende Bauteile',
              issuer: 'Tragwerksplanung',
            },
            {
              label: 'Zustimmung der Miteigentümer',
              requirement: 'conditional',
              condition: 'nur bei Wohnungseigentum',
              issuer: 'Bauwerber',
            },
          ]}
          note="Die Gemeinde kann im Einzelfall weitere Unterlagen verlangen."
        />
      </Section>

      {/* The rail is evenly spaced on purpose: four weeks and four years do not
          share a timeline, because each one starts from a different event. What
          to review here is that the drawing never suggests otherwise, and that
          no period has quietly become a date. */}
      <Section id="deadline_timeline">
        <DeadlineTimelineCard
          title="Fristen im Bauverfahren – Wien"
          deadlines={[
            {
              label: 'Beschwerdefrist',
              period: 'binnen vier Wochen',
              starts_from: 'ab Zustellung des Baubewilligungsbescheids',
              actor: 'Nachbar oder Bauwerber',
              consequence: 'Der Bescheid wird rechtskräftig.',
              reference: { document: 'VwGVG', section: '§ 7 Abs. 4' },
            },
            {
              label: 'Geltungsdauer der Baubewilligung',
              period: 'binnen vier Jahren ist mit dem Bau zu beginnen',
              starts_from: 'ab Rechtskraft der Baubewilligung',
              actor: 'Bauwerber',
              consequence: 'Die Baubewilligung erlischt.',
              reference: { document: 'Wiener Bauordnung', section: '§ 74 Abs. 1' },
            },
            {
              label: 'Baubeginnsanzeige',
              period: 'vor Beginn der Bauführung',
              starts_from: 'bezogen auf den beabsichtigten Baubeginn',
            },
            {
              label: 'Fertigstellungsanzeige',
              period: 'unverzüglich',
              starts_from: 'ab Fertigstellung des Bauvorhabens',
              actor: 'Bauwerber',
              reference: { document: 'Wiener Bauordnung', section: '§ 128' },
            },
          ]}
        />
      </Section>

      {/* Again a pair. The first knows where the project stands today, so the
          header reads „7 bis 11 m → über 11 m"; the second does not, and has to
          say that rather than print a plausible starting point. The fourth row
          of the first card is `unchanged`, which is the value that keeps the
          card from reading as a list of penalties. */}
      <Section id="change_impact">
        <ChangeImpactCard
          title="Fluchtniveau über 11 m – was sich ändert"
          factor="Fluchtniveau"
          from_value="7 bis 11 m"
          to_value="über 11 m"
          consequences={[
            {
              aspect: 'Gebäudeklasse',
              before: 'GK 4',
              after: 'GK 5',
              direction: 'tightens',
              reference: { document: 'OIB-Begriffsbestimmungen', section: 'Gebäudeklassen' },
            },
            {
              aspect: 'Feuerwiderstand tragender Bauteile',
              before: 'R 60',
              after: 'R 90',
              direction: 'tightens',
              detail: 'Die Anforderung gilt für die tragenden Bauteile der oberirdischen Geschoße.',
              reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1', edition: 'Ausgabe Mai 2023' },
            },
            {
              aspect: 'Aufzug',
              after: 'Aufzug erforderlich',
              direction: 'tightens',
              reference: OIB4,
            },
            {
              aspect: 'Schallschutz zwischen den Wohnungen',
              before: 'DnT,w mindestens 55 dB',
              after: 'DnT,w mindestens 55 dB',
              direction: 'unchanged',
              detail: 'Der Schallschutz hängt an der Nutzung, nicht an der Gebäudeklasse.',
              reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1', edition: 'Ausgabe Mai 2023' },
            },
          ]}
          reference={{ document: 'OIB-Begriffsbestimmungen', section: 'Gebäudeklassen' }}
        />
        <ChangeImpactCard
          title="Nutzungsänderung zu Beherbergung – was sich ändert"
          factor="Hauptnutzung"
          to_value="Beherbergungsstätte"
          consequences={[
            {
              aspect: 'Fluchtwegbreite',
              after: 'mindestens 1,20 m',
              direction: 'tightens',
              reference: { document: 'OIB-Richtlinie 2', section: 'Pkt. 5', edition: 'Ausgabe Mai 2023' },
            },
            {
              aspect: 'Barrierefreie Zimmer',
              after: 'anteilig barrierefrei auszuführen',
              direction: 'tightens',
              reference: OIB4,
            },
          ]}
          note="Ob eine Widmungsänderung nötig ist, hängt vom Flächenwidmungsplan ab."
        />
      </Section>

      {/* Four chips of very different lengths, because the thing to review here
          is that a long question truncates to one line instead of turning the
          chip into a paragraph — and that the set still reads as an offer with
          no frame around it. The title is a real headline rather than a
          restatement of the eyebrow: the backend's own guidance is to omit it
          („omit to let the questions stand alone"), so the fixture that earns
          its place is the one where the model had something to add. */}
      <Section id="follow_ups">
        <FollowUpsCard
          title="Was Sie als Nächstes klären sollten"
          items={[
            { question: 'Wie wird das Fluchtniveau genau gemessen?', hint: 'Messpunkt und Bezugsebene' },
            { question: 'Welche Anforderungen gelten für mein Projekt konkret?' },
            { question: 'Was wäre bei Gebäudeklasse 5 anders?', hint: 'Vergleich der beiden Klassen' },
            {
              question:
                'Wie weise ich die Feuerwiderstandsklasse REI 60 der tragenden Bauteile im Einreichplan nach?',
            },
          ]}
        />
      </Section>

      {/* The card IS the figure, so the thing to review is the figure: a short
          verdict at the 20px Figure step, a long compound at the 15px Value
          step it drops to above 24 characters, and the gauge at all three of
          its levels —
          including the answer with no confidence at all, where the gauge is
          absent rather than empty. */}
      <Section id="verdict_header">
        <VerdictHeaderCard
          verdict="1,10 m"
          subject="Erforderliche Geländerhöhe"
          reference={OIB4}
          confidence="high"
          confidence_reason={null}
        />
      </Section>

      <Section id="verdict_header_long">
        <VerdictHeaderCard
          verdict="Hauptgeschoßfußbodenoberkante über 22 m"
          subject="Einstufung als Hochhaus"
          reference={OIB2}
          confidence="medium"
          confidence_reason="Die Wiener Bauordnung misst den Bezugspunkt abweichend; für ein Grundstück in Wien ist der Wert gesondert zu prüfen."
        />
      </Section>

      <Section id="verdict_header_bare">
        <VerdictHeaderCard
          verdict="Nicht geregelt"
          subject="Mindestbreite einer Wartungsleiter"
          reference={null}
          confidence="low"
          confidence_reason={null}
        />
      </Section>

      {/* At rest: the case that applies is open, the others are one line each.
          The switched state — a different case previewed against it — is its
          own target, /dev/condition-tree. */}
      <Section id="condition_tree">
        <ConditionTreeCard
          title="Erforderliche Feuerwiderstandsklasse tragender Bauteile"
          question="Gebäudeklasse"
          branches={[
            { condition: 'GK 1–3', outcome: 'REI 30 (bzw. R 30)' },
            {
              condition: 'GK 4',
              outcome: 'REI 60',
              active: true,
              reference: {
                document: 'OIB-Richtlinie 2',
                section: 'Tabelle 1b',
                excerpt:
                  'Tragende Bauteile in Gebäuden der Gebäudeklasse 4 sind in REI 60 auszuführen; in Kellergeschossen gilt REI 90.',
              },
            },
            {
              condition: 'GK 5',
              outcome: 'REI 90',
              reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
            },
          ]}
          reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' }}
        />
      </Section>

      {/* Both tiers of Baurecht, because the difference between them is the
          card's whole subject and it is invisible in a single sample: the OIB
          citation takes the indigo accent, the OIB badge and its Ausgabe; the
          statute keeps the law blue, the RIS badge and has no Ausgabe to name.
          Neither is derived from the law string — both come off `lane`. */}
      <Section id="legal_basis">
        <LegalBasisCard
          type="legal_basis"
          law="OIB-Richtlinie 2"
          lane="baurecht_oib"
          edition="Ausgabe Mai 2023"
          article="3.1.1"
          section="Tabelle 1a"
          summary="Die maximale Brandabschnittsfläche für oberirdische Geschosse in GK 4 beträgt 1.200 m²."
          original_text="Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² und eine Längenausdehnung von höchstens 60 m aufweisen."
        />
        <LegalBasisCard
          type="legal_basis"
          law="Wiener Bauordnung"
          lane="baurecht_ris"
          edition={null}
          article="87"
          section="Abs. 4"
          summary="Bauliche Anlagen sind so zu errichten, dass die Standsicherheit und der Brandschutz während der gesamten Nutzungsdauer gewährleistet sind."
          original_text="Bauwerke müssen so geplant und ausgeführt werden, dass sie den zu erwartenden Einwirkungen standhalten."
        />
      </Section>

      <Section id="requirement_checklist">
        <RequirementChecklistCard
          title="Anforderungen GK 4 – Brandschutz"
          items={[
            {
              label: 'Tragende Bauteile REI 60',
              status: 'pass',
              detail: 'Stahlbetondecken und -wände erfüllen REI 90.',
              reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
            },
            {
              label: 'Treppenhaus als gesicherter Fluchtbereich',
              status: 'fail',
              detail: 'Derzeit keine rauchdichte Abtrennung im EG vorgesehen.',
              reference: { document: 'OIB-Richtlinie 2.3', section: 'Pkt. 2.1' },
            },
            {
              label: 'Zweiter Fluchtweg oder Anleiterbarkeit',
              status: 'needs_input',
              detail: 'Anleiterbarkeit der Nordfassade noch nicht geklärt.',
            },
            { label: 'Brandmeldeanlage Kategorie 1', status: 'warning' },
          ]}
          reference={{ document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' }}
          note="Bewertung auf Basis des Vorentwurfs vom 12.06."
        />
      </Section>

      <Section id="comparison_table">
        <ComparisonTableCard
          title="GK 4 vs. GK 5 – wesentliche Anforderungen"
          options={['GK 4', 'GK 5']}
          rows={[
            { label: 'Fluchtniveau', values: ['≤ 11 m', '≤ 22 m'], highlight_index: 0 },
            { label: 'Tragende Bauteile', values: ['REI 60', 'REI 90'], highlight_index: 0 },
            { label: 'max. Brandabschnittsfläche', values: ['1.200 m²', '1.200 m²'] },
            { label: 'Aufzug erforderlich', values: ['ab 3 Geschossen', 'ja'], highlight_index: 0 },
          ]}
          recommendation="Mit Fluchtniveau 9,8 m bleibt das Projekt in GK 4 — deutlich geringere Anforderungen an tragende Bauteile."
          reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' }}
        />
      </Section>

      <Section id="building_section">
        <BuildingSectionCard
          title="Gebäudeschnitt – Höhenprüfung GK4"
          storeys={[
            { label: 'KG', height_m: 2.5, below_grade: true },
            { label: 'EG', height_m: 3.2 },
            { label: '1.OG', height_m: 3.0 },
            { label: '2.OG', height_m: 3.0 },
            { label: '3.OG', height_m: 3.0 },
          ]}
          markers={[
            { label: 'Fluchtniveau', height_m: 9.2, kind: 'fluchtniveau' },
            { label: 'GK4-Grenze', height_m: 11, kind: 'threshold' },
          ]}
          reference={OIB2}
          note="Das Fluchtniveau liegt unter der GK4-Grenze von 11 m."
        />
      </Section>

      <Section id="stair_diagram">
        <StairDiagramCard
          title="Treppenlauf – Steigungsverhältnis"
          riser_count={17}
          riser_height={{ label: 'Steigung', value: 17.6, required: 18, unit: 'cm', comparator: '<=', status: 'pass' }}
          tread_depth={{ label: 'Auftritt', value: 28, required: 28, unit: 'cm', comparator: '>=', status: 'pass' }}
          width={{ label: 'Nutzbare Laufbreite', value: 110, required: 120, unit: 'cm', comparator: '>=', status: 'fail' }}
          comfort_note="Schrittmaß 2×17,6 + 28 = 63,2 cm — innerhalb der Komfortregel (59–65 cm)."
          reference={OIB4}
        />
      </Section>

      <Section id="dimension_diagram_door">
        <DimensionDiagramCard
          title="Türe – lichte Durchgangsbreite"
          shape="door"
          dimensions={[
            { label: 'lichte Durchgangsbreite', value: 85, required: 80, unit: 'cm', comparator: '>=', status: 'pass' },
            { label: 'Durchgangshöhe', value: 210, required: 200, unit: 'cm', comparator: '>=', status: 'pass' },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 5.1.1' }}
        />
      </Section>

      {/* The legend at its most crowded, which is the state worth having on
          film: a measured value with its ± band, the „gemessen" provenance chip
          and the limit all in one `text-xs` row, plus the unanswerable check
          that prints the CAD remedy and offers the „Dazu fragen" chip. */}
      <Section id="dimension_diagram_ramp">
        <DimensionDiagramCard
          title="Rampe – Neigung & Breite"
          shape="ramp"
          dimensions={[
            {
              label: 'Neigung',
              value: 7.2,
              required: 6,
              unit: '%',
              comparator: '<=',
              status: 'fail',
              provenance: 'computed',
              tolerance: 0.1,
            },
            {
              label: 'nutzbare Breite',
              value: 120,
              required: 120,
              unit: 'cm',
              comparator: '>=',
              status: 'pass',
              provenance: 'declared',
            },
            {
              label: 'Handlauf beidseitig',
              value: null,
              unit: 'cm',
              status: 'needs_input',
              missing: 'Dieser Export enthält kein IfcRailing — Handläufe im CAD als IfcRailing modellieren.',
            },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 5.2' }}
        />
      </Section>

      <Section id="dimension_diagram_turning_circle">
        <DimensionDiagramCard
          title="Wendekreis Rollstuhl"
          shape="turning_circle"
          dimensions={[
            { label: 'Durchmesser', value: 150, required: 150, unit: 'cm', comparator: '>=', status: 'pass' },
          ]}
          reference={{ document: 'ÖNORM B 1600' }}
        />
      </Section>

      {/* The three remaining shapes, so the gallery photographs every template
          the renderer can produce rather than half of them: a corridor plan, a
          threshold detail at centimetre scale, and a parking bay in plan. */}
      <Section id="dimension_diagram_corridor">
        <DimensionDiagramCard
          title="Gang – nutzbare Breite"
          shape="corridor"
          dimensions={[
            { label: 'nutzbare Breite', value: 110, required: 120, unit: 'cm', comparator: '>=', status: 'fail' },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 4.2' }}
        />
      </Section>

      <Section id="dimension_diagram_threshold">
        <DimensionDiagramCard
          title="Türschwelle – Anschlaghöhe"
          shape="threshold"
          dimensions={[
            { label: 'Schwellenhöhe', value: 2, required: 2, unit: 'cm', comparator: '<=', status: 'pass' },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 5.1.3' }}
        />
      </Section>

      <Section id="dimension_diagram_parking_space">
        <DimensionDiagramCard
          title="Stellplatz barrierefrei"
          shape="parking_space"
          dimensions={[
            { label: 'Breite', value: 350, required: 350, unit: 'cm', comparator: '>=', status: 'pass' },
            { label: 'Länge', value: 500, required: 500, unit: 'cm', comparator: '>=', status: 'pass' },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 3.3' }}
        />
      </Section>

      <Section id="setback_plan">
        <SetbackPlanCard
          title="Abstandsflächen – Lageplan"
          parcel_width_m={22}
          parcel_depth_m={30}
          building_width_m={12}
          building_depth_m={14}
          sides={[
            { side: 'left', required_m: 3, actual_m: 2.4, status: 'fail' },
            { side: 'right', required_m: 3, actual_m: 4.2, status: 'pass' },
            { side: 'front', required_m: 5, actual_m: 6.0, status: 'pass' },
            { side: 'back', required_m: 3, actual_m: null, status: 'needs_input' },
          ]}
          reference={{ document: 'NÖ Bauordnung 2014', section: '§ 54' }}
        />
      </Section>

      <Section id="egress_diagram">
        <EgressDiagramCard
          title="Fluchtweg – Gehweglänge"
          segments={[
            { label: 'Raum → Gang', length_m: 12, turn: 'right' },
            { label: 'Gang', length_m: 18, turn: 'left' },
            { label: 'Gang → Treppenhaus', length_m: 8, turn: 'straight' },
          ]}
          total_length={{ label: 'Gehweglänge gesamt', value: 38, required: 40, unit: 'm', comparator: '<=', status: 'pass' }}
          reference={OIB2}
        />
      </Section>

      <Section id="daylight_incidence">
        <DaylightIncidenceCard
          title="Belichtung – freier Lichteinfall"
          room_floor_area_m2={22}
          glass_area={{ label: 'Lichteintrittsfläche', value: 2.6, required: 2.2, unit: 'm²', comparator: '>=', status: 'pass' }}
          window_sill_height_m={1.0}
          window_head_height_m={2.4}
          obstruction={{ distance_m: 6, height_m: 7.5, label: 'Gegenüberliegendes Gebäude' }}
          reference={OIB3}
        />
      </Section>

      <Section id="guardrail_check">
        <GuardrailCheckCard
          title="Absturzsicherung Dachterrasse"
          context="dachterrasse"
          fall_height={{ label: 'Absturzhöhe', value: 13.5, required: 12, unit: 'm', comparator: '<=', status: 'warning' }}
          rail_height={{ label: 'Geländerhöhe', value: 100, required: 110, unit: 'cm', comparator: '>=', status: 'fail' }}
          max_opening={{ label: 'max. Öffnungsweite', value: 11, required: 12, unit: 'cm', comparator: '<=', status: 'pass' }}
          bottom_gap={{ label: 'Bodenspalt', value: 3, required: 12, unit: 'cm', comparator: '<=', status: 'pass' }}
          has_horizontal_elements_in_climb_zone={false}
          reference={OIB4}
        />
      </Section>

      <Section id="density_check">
        <DensityCheckCard
          title="Bebauungsdichte – Grundstück"
          parcel_area_m2={800}
          footprint_area_m2={210}
          gross_floor_area_m2={620}
          coverage={{ label: 'Bebauungsgrad', value: null, required: 30, unit: '%', comparator: '<=', status: 'needs_input' }}
          density={{ label: 'GFZ', value: null, required: 0.8, unit: '', comparator: '<=', status: 'needs_input' }}
          reference={{ document: 'Bebauungsplan Mustergemeinde' }}
        />
      </Section>

      <Section id="fire_access_plan">
        <FireAccessPlanCard
          title="Feuerwehrzufahrt & Aufstellfläche"
          parcel_width_m={28}
          parcel_depth_m={36}
          building_width_m={16}
          building_depth_m={14}
          route_width={{ label: 'Zufahrt Breite', value: 3.5, required: 3, unit: 'm', comparator: '>=', status: 'pass' }}
          gate_clearance_height={{ label: 'Durchfahrt lichte Höhe', value: 4.0, required: 4.0, unit: 'm', comparator: '>=', status: 'pass' }}
          aufstellflaeche={{
            width: { label: 'Breite', value: 5, required: 5, unit: 'm', comparator: '>=', status: 'pass' },
            length: { label: 'Länge', value: 11, required: 10, unit: 'm', comparator: '>=', status: 'pass' },
            distance_to_facade: { label: 'Abstand zur Fassade', value: 3, required: 10, unit: 'm', comparator: '<=', status: 'pass' },
          }}
          walk_distance_to_entrance={{ label: 'Weg zum Eingang', value: 34, required: 80, unit: 'm', comparator: '<=', status: 'pass' }}
          gebaeudeklasse="GK 4"
          reference={{ document: 'TRVB F 134', section: 'Pkt. 4' }}
        />
      </Section>

      <Section id="acoustic_check">
        <AcousticCheckCard
          title="Schallschutz – Wohnungstrennung"
          checks={[
            {
              path_label: 'Wohnungstrennwand Top 3 / Top 4',
              metric: 'DnTw',
              check: { label: 'DnT,w', value: 56, required: 55, unit: 'dB', comparator: '>=', status: 'pass' },
              reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1' },
            },
            {
              path_label: 'Wohnungstrenndecke Top 3 / Top 7',
              metric: 'LnTw',
              check: { label: 'LnT,w', value: 46, required: 48, unit: 'dB', comparator: '<=', status: 'pass' },
              reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1' },
            },
            {
              path_label: 'Außenwand Straßenseite',
              metric: 'Rw_res',
              check: { label: 'Rw,res', value: 40, required: 43, unit: 'dB', comparator: '>=', status: 'fail' },
              reference: { document: 'ÖNORM B 8115-2', section: 'Tabelle 2' },
            },
          ]}
          sound_class="B"
        />
      </Section>

      <Section id="fire_compartment">
        <FireCompartmentCard
          title="Brandabschnitte – Regelgeschoss"
          storey_label="2.OG"
          compartments={[
            { label: 'BA 1', use: 'Wohnen', area: { label: 'BA 1', value: 980, required: 1200, unit: 'm²', comparator: '<=', status: 'pass' } },
            { label: 'BA 2', use: 'Büro', area: { label: 'BA 2', value: 1350, required: 1200, unit: 'm²', comparator: '<=', status: 'fail' } },
            { label: 'BA 3', use: 'Tiefgarage', area: { label: 'BA 3', value: null, required: 1200, unit: 'm²', comparator: '<=', status: 'needs_input' } },
          ]}
          gebaeudeklasse="GK 4"
          reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1a', edition: 'Ausgabe Mai 2023' }}
        />
      </Section>

      <Section id="thermal_envelope">
        <ThermalEnvelopeCard
          title="Wärmeschutz – U-Werte der Gebäudehülle"
          components={[
            { label: 'Außenwand', kind: 'wall', u_value: { label: 'Außenwand', value: 0.28, required: 0.35, unit: 'W/(m²K)', comparator: '<=', status: 'pass' } },
            { label: 'Dach', kind: 'roof', u_value: { label: 'Dach', value: 0.22, required: 0.2, unit: 'W/(m²K)', comparator: '<=', status: 'fail' } },
            { label: 'Fenster', kind: 'window', u_value: { label: 'Fenster', value: 1.1, required: 1.4, unit: 'W/(m²K)', comparator: '<=', status: 'pass' } },
            { label: 'Kellerdecke', kind: 'floor', u_value: { label: 'Kellerdecke', value: null, required: 0.4, unit: 'W/(m²K)', comparator: '<=', status: 'needs_input' } },
          ]}
          reference={OIB6}
        />
      </Section>

      <Section id="energy_performance">
        <EnergyPerformanceCard
          title="Energieausweis – Heizwärmebedarf"
          hwb={{ label: 'Heizwärmebedarf (HWB)', value: 42, required: 54.4, unit: 'kWh/m²a', comparator: '<=', status: 'pass' }}
          energy_class="B"
          fgee={{ label: 'fGEE', value: 0.82, required: 0.9, unit: '', comparator: '<=', status: 'pass' }}
          reference={OIB6}
        />
      </Section>

      <Section id="elevator_requirement">
        <ElevatorRequirementCard
          title="Barrierefreier Aufzug – Erschließung"
          storeys_served={5}
          entrance_level_index={0}
          is_required={true}
          requirement_note="Mehr als 2 oberirdische Geschosse: ein barrierefreier Aufzug ist erforderlich."
          cabin_width={{ label: 'Kabinenbreite', value: 110, required: 110, unit: 'cm', comparator: '>=', status: 'pass' }}
          cabin_depth={{ label: 'Kabinentiefe', value: 140, required: 140, unit: 'cm', comparator: '>=', status: 'pass' }}
          door_width={{ label: 'lichte Türbreite', value: 80, required: 90, unit: 'cm', comparator: '>=', status: 'fail' }}
          reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.5' }}
        />
      </Section>

      <Section id="parking_requirement">
        <ParkingRequirementCard
          title="Stellplatznachweis – Wohnbau"
          car_spaces={{ label: 'Kfz-Stellplätze', value: 12, required: 14, unit: 'Stpl.', comparator: '>=', status: 'fail' }}
          bicycle_spaces={{ label: 'Fahrradabstellplätze', value: 28, required: 24, unit: 'Stpl.', comparator: '>=', status: 'pass' }}
          basis="1 Stellplatz je Wohneinheit (14 WE)"
          reference={{ document: 'Wiener Garagengesetz 2008', section: '§ 48' }}
        />
      </Section>

      {/* The one drawing the renderer did not compute — the model wrote the
          mermaid. The fixture is `CARD_EXAMPLES['diagram']` from the backend
          catalog, so the gallery photographs the card the agent was actually
          taught to emit. Its failure state has its own target, /dev/diagram-card. */}
      <Section id="diagram">
        <DiagramCard
          title="Baubewilligungsverfahren – wer wem was übergibt"
          source={[
            'sequenceDiagram',
            '  participant BW as Bauwerber',
            '  participant BB as Baubehörde',
            '  participant ASV as Amtssachverständige',
            '  BW->>BB: Einreichunterlagen',
            '  BB->>ASV: Befassung zur Begutachtung',
            '  ASV-->>BB: Gutachten',
            '  BB-->>BW: Verbesserungsauftrag',
            '  BW->>BB: ergänzte Unterlagen',
            '  BB-->>BW: Baubewilligungsbescheid',
          ].join('\n')}
          caption="Die Fristen zeigt die Grafik nicht — sie steht für die Reihenfolge der Übergaben."
          reference={{ document: 'Wiener Bauordnung', section: '§§ 60 ff.' }}
        />
      </Section>

      {/* The two INTERACTIVE cards (ADR-0030) go through the GridCards
          dispatcher rather than being rendered directly, so the gallery
          exercises the same `cardKey` wiring the chat uses. With no owning
          message they fall back to local state — clickable here, deliberately
          not durable. */}
      <Section id="project_profile_patch">
        <GridCards
          cards={[
            {
              type: 'project_profile_patch',
              title: 'Projektkontext aktualisieren: Fluchtniveau',
              rationale:
                'Sie haben angegeben, dass das oberste Fluchtniveau bei 25 m liegt — damit ist das Gebäude ein Hochhaus (> 22 m) und OIB-Richtlinie 2.3 wird anwendbar.',
              patch: [{ op: 'add', path: '/facts/fluchtniveau', value: '>22m' }],
            },
          ] as GridCard[]}
          projectId={null}
        />
      </Section>

      <Section id="memory_proposal">
        <GridCards
          cards={[
            {
              type: 'memory_proposal',
              title: 'Diese Erkenntnis merken?',
              content: 'Das Büro setzt bei GK 4 durchgängig REI 90 an, auch wo REI 60 genügen würde.',
              kind: 'preference',
              confidence: 'high',
            },
          ] as GridCard[]}
          projectId={null}
        />
      </Section>
    </main>
  )
}
