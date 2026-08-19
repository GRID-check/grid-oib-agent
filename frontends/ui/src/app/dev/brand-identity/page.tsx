'use client'

/**
 * Piloti — the corporate identity, as a specimen.
 *
 * The strategy lives in `docs/design/brand-identity.md`; this is its visual
 * half, and the two are meant to be read side by side. Everything the brand
 * actually consists of — wordmark lockup, the four faces, the three colour
 * systems, the accent's rules, the drafting sheet, the voice — is on this one
 * page, because none of it can be judged on the screen where it appears: the
 * wordmark lives in the rail, the display face in page titles, the accent in a
 * focus ring nobody screenshots, the sheet only under an empty state.
 *
 * It is also the review surface: a retune of any token is checked here against
 * everything else it touches before it ships, and the screenshot harness
 * captures it in both themes on every run (`visual/registry.mjs`).
 *
 * Sections are numbered `01…07` after the marketing site's own convention
 * (`frontends/web` — "01 Start", "02 Problem und Lösung"). Not linked from
 * anywhere; `/dev/*` 404s outside development (see ../layout.tsx).
 */

import {
  Archive,
  Check,
  FileText,
  Globe,
  Ruler,
  Scale,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Logo } from '@/components/brand/logo'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** A numbered section. The number is the site's convention, in the site's face. */
function Section({
  n,
  title,
  rule,
  children,
}: {
  n: string
  title: string
  /** The one sentence that governs this part of the identity. */
  rule: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t pt-8">
      <header className="mb-5">
        <p className="text-muted-foreground font-mono text-xs">{n}</p>
        <h2 className="font-display mt-1 text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">{rule}</p>
      </header>
      {children}
    </section>
  )
}

/** A labelled specimen row inside a section. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-2.5">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex shrink-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

/** Do / don't pair — the format the brand doc uses, so the two cannot drift. */
function Rule({ good, bad }: { good: string; bad: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <p className="text-brand-text bg-brand-tint flex gap-2 rounded-md px-3 py-2 text-sm">
        <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{good}</span>
      </p>
      <p className="text-muted-foreground bg-muted flex gap-2 rounded-md px-3 py-2 text-sm">
        <X className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{bad}</span>
      </p>
    </div>
  )
}

function Swatch({ cls, name, note }: { cls: string; name: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className={cn('h-12 rounded-md border', cls)} />
      <span className="text-muted-foreground truncate font-mono text-[10px]">{name}</span>
      {note ? (
        <span className="text-muted-foreground truncate font-mono text-[10px] opacity-70">
          {note}
        </span>
      ) : null}
    </div>
  )
}

/** The provenance families — colour + icon + label, which is the whole rule. */
const SIGNALS = [
  { icon: Scale, label: 'Rechtsquellen', tint: 'bg-source-law-tint text-source-law-text' },
  { icon: Scale, label: 'OIB-Richtlinien', tint: 'bg-source-oib-tint text-source-oib-text' },
  { icon: FileText, label: 'Projektwissen', tint: 'bg-source-project-tint text-source-project-text' },
  { icon: Archive, label: 'Büroarchiv', tint: 'bg-source-office-tint text-source-office-text' },
  { icon: Ruler, label: 'Am Modell gemessen', tint: 'bg-source-model-tint text-source-model-text' },
  { icon: Globe, label: 'Lücke', tint: 'bg-source-auto-tint text-source-auto-text' },
] as const

export default function BrandIdentityDevPage(): JSX.Element {
  return (
    <main
      className="bg-background mx-auto flex max-w-3xl flex-col gap-8 p-10"
      data-testid="brand-identity-preview"
    >
      <header className="flex flex-col gap-3">
        <Logo size="medium" />
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Corporate Identity
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          Warmes Zeichenpapier, tiefschwarze Tinte, ein olivgrüner Stift, farbcodierte Quellen —
          die Arbeitsfläche eines sorgfältigen Büros, kein Dashboard. Jedes Element stammt von
          piloti.at; keines ist für die App erfunden. Strategie und Begründung:{' '}
          <span className="font-mono text-xs">docs/design/brand-identity.md</span>.
        </p>
      </header>

      <Section
        n="01"
        title="Wortmarke"
        rule="Poppins Medium, Versalien, 0.2em Laufweite — identisch auf piloti.at und in der App. Schutzraum: die Höhe eines Quadrats der Marke auf allen vier Seiten."
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-10">
            <Logo size="small" />
            <Logo size="medium" />
            <Logo size="large" />
          </div>
          {/* Clearspace: the ring IS one mark-square of padding, drawn. */}
          <div className="flex items-center gap-6">
            <div className="border-brand/40 inline-flex rounded-sm border border-dashed p-[10px]">
              <Logo size="medium" />
            </div>
            <p className="text-muted-foreground text-xs">
              Schutzraum = 1 Quadrat der Marke. Mindestgröße: Wortmarke 12px Versalhöhe, Marke
              allein 16px.
            </p>
          </div>
          <Rule
            good="Tinte auf Papier, Papier auf Tinte. Immer das gleiche Lockup."
            bad="Grün, Verlauf, Kontur, gemischte Schreibung, gedreht, auf einem Foto."
          />
        </div>
      </Section>

      <Section
        n="02"
        title="Schrift"
        rule="Zwei Stimmen. Die Grotesk ist die Arbeitsstimme — Titel, Überschriften, Labels, Kennzahlen. Die Serife ist die Aussage: ein Moment pro Oberfläche, nie unter 24px."
      >
        <div className="flex flex-col gap-5">
          <div>
            <p className="font-serif text-[40px] leading-[1.05] font-normal">
              Planen. Statt suchen.
            </p>
            <p className="text-muted-foreground font-mono text-[10px]">
              font-serif · Instrument Serif 400 · die Aussage — Hero, Begrüßung · ≥24px, sonst nie
            </p>
          </div>
          <div>
            <p className="font-display text-xl font-semibold tracking-tight">
              Brandschutz — Fluchtwege
            </p>
            <p className="font-display mt-1 text-lg font-semibold tracking-tight tabular-nums">
              1.482 Fundstellen · 40,0 m
            </p>
            <p className="text-muted-foreground font-mono text-[10px]">
              font-display · Helvetica Neue → Archivo · die Arbeitsstimme: Seitentitel,
              Überschriften, Eyebrows, Kennzahlen
            </p>
          </div>
          <div>
            <p className="text-sm leading-relaxed">
              Für ein Bürogebäude der Gebäudeklasse 4 sind in der Regel zwei voneinander
              unabhängige Fluchtwege erforderlich.
            </p>
            <p className="text-muted-foreground font-mono text-[10px]">
              font-sans · Inter · Fließtext, Bedienelemente, alles Unmarkierte
            </p>
          </div>
          <div>
            <p className="font-mono text-sm">OIB-RL 2 · § 108 BO Wien · job_7f3a91 · 40,0 m</p>
            <p className="text-muted-foreground font-mono text-[10px]">
              font-mono · IBM Plex Mono · Kennungen, Paragrafen, Sammlungen, gemessene Werte
            </p>
          </div>
          <div>
            <SectionLabel>Eyebrow · Archivo · 10.5px · Versalien</SectionLabel>
            <p className="text-muted-foreground font-mono text-[10px]">
              font-logo · Poppins · ausschließlich die Wortmarke
            </p>
          </div>
          <Rule
            good="Eine Aussage pro Oberfläche in der Serife — Hero oder Begrüßung, dann Schluss."
            bad="Serife im 20px-Seitentitel oder im Control: ein Display-Schnitt wird dünn und fransig."
          />
        </div>
      </Section>

      <Section
        n="03"
        title="Farbe — drei Systeme, drei Aufgaben"
        rule="Papier und Tinte tragen die Fläche. Der Akzent markiert, was live oder gewählt ist. Die Provenienz-Signale sagen, woher etwas stammt — immer mit Icon und Label. Ein Token, das in keines der drei passt, bekommt keine Farbe."
      >
        <div className="flex flex-col gap-6">
          <div>
            <SectionLabel>Papier &amp; Tinte — Handlungsfarbe</SectionLabel>
            <div className="mt-2 flex gap-2">
              <Swatch cls="bg-background" name="background" />
              <Swatch cls="bg-card" name="card" />
              <Swatch cls="bg-muted" name="muted" />
              <Swatch cls="bg-accent" name="accent" />
              <Swatch cls="bg-primary" name="primary" note="Aktion" />
            </div>
          </div>

          <div>
            <SectionLabel>Akzent — was live oder gewählt ist</SectionLabel>
            <div className="mt-2 flex gap-2">
              <Swatch cls="bg-brand-tint" name="tint" />
              <Swatch cls="bg-brand-tint-strong" name="tint+" />
              <Swatch cls="bg-brand" name="brand" note="#57703a / #a4b47a" />
              <Swatch cls="bg-brand-hover" name="hover" />
              <Swatch cls="bg-brand-pop" name="pop" note="ungenutzt" />
            </div>
          </div>

          <div>
            <SectionLabel>Provenienz — Farbe reist nie allein</SectionLabel>
            <div className="mt-2 flex flex-wrap gap-2">
              {SIGNALS.map(({ icon: Icon, label, tint }) => (
                <span
                  key={label}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                    tint,
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  {label}
                </span>
              ))}
            </div>
          </div>

          <Rule
            good="Tinte handelt, Grün markiert den Zustand, Provenienz sagt die Herkunft."
            bad="Grüner Primärbutton — der Akzent bedeutet dann „Aktion“ und „Zustand“ zugleich."
          />
        </div>
      </Section>

      <Section
        n="04"
        title="Der Akzent im Einsatz"
        rule="Höchstens ein grünes Element pro Komponente, und zwar am kleinsten Element, das die Bedeutung tragen kann — ein grünes Rail-Icon, keine grüne Rail-Zeile."
      >
        <div className="divide-y">
          <Row label="Fokus (Tab)">
            <Input className="w-44" defaultValue="ein Feld" aria-label="Feld" />
            <Button variant="outline" size="sm">
              eine Schaltfläche
            </Button>
          </Row>
          <Row label="Gesetzt">
            <div className="flex items-center gap-2">
              <Checkbox id="bi-check" defaultChecked />
              <Label htmlFor="bi-check">gesetzt</Label>
            </div>
            <RadioGroup defaultValue="a" className="flex gap-3">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="a" id="bi-radio-a" />
                <Label htmlFor="bi-radio-a">A</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="b" id="bi-radio-b" />
                <Label htmlFor="bi-radio-b">B</Label>
              </div>
            </RadioGroup>
            <Switch defaultChecked aria-label="An" />
          </Row>
          <Row label="Gewählt">
            <span className="text-brand inline-flex items-center gap-1 text-sm">
              <Check className="size-4" aria-hidden /> gewählt
            </span>
          </Row>
          <Row label="Läuft gerade">
            <Progress value={62} className="w-44" />
          </Row>
          <Row label="Labels">
            <Badge variant="brand">Live</Badge>
            <Chip variant="brand">Neu</Chip>
            <Button variant="link" size="sm">
              ein Link
            </Button>
          </Row>
          <Row label="Auswahl">
            <p className="text-sm select-all">Markiere diesen Satz.</p>
          </Row>
        </div>
      </Section>

      <Section
        n="05"
        title="Zeichenblatt"
        rule="28px-Raster bei ~4 % Tinte, nur unter leeren Flächen — eine leere Fläche soll wie ein unbenutztes Blatt wirken, nicht wie ein fehlender Bildschirm. Auf der Website läuft dasselbe Raster ganzseitig; das hier ist die leise Fassung."
      >
        <div className="drafting-sheet flex h-40 items-center justify-center rounded-lg border border-dashed">
          <p className="text-muted-foreground text-sm">Nichts gezeichnet — noch nicht.</p>
        </div>
      </Section>

      <Section
        n="06"
        title="Stimme"
        rule="Formell (Sie), ernst ohne feierlich, fachlich ohne Polster, sicher bei den Quellen und zurückhaltend beim Urteil. Behauptung, dann Quelle, dann Grenze."
      >
        <div className="flex flex-col gap-3">
          <Rule
            good="Für GK 4 sind zwei voneinander unabhängige Fluchtwege erforderlich (OIB-RL 2, Pkt. 2.5)."
            bad="Kein Problem! Für so ein Gebäude brauchst du normalerweise zwei Fluchtwege 🙂"
          />
          <Rule
            good="Dazu findet sich in den geladenen Quellen nichts. Mögliche nächste Schritte: …"
            bad="Vermutlich reicht ein Fluchtweg — das ist aber ohne Gewähr."
          />
          <Rule
            good="Upload fehlgeschlagen — Datei größer als 50 MB. Kleinere Datei wählen oder aufteilen."
            bad="Ups! Da ist leider etwas schiefgelaufen. Bitte versuchen Sie es später erneut."
          />
        </div>
      </Section>

      <Section
        n="07"
        title="Der Fünf-Sekunden-Test"
        rule="Vor jedem Release einer sichtbaren Oberfläche, in dieser Reihenfolge."
      >
        <ol className="text-sm leading-relaxed">
          {[
            'Lässt sich jede Aussage auf diesem Bildschirm überprüfen?',
            'Ist die Hauptaktion Tinte — und gibt es höchstens ein grünes Element?',
            'Sagt der Text „Sie“, im Präsens, ohne Füllwörter und ohne Ausrufezeichen?',
            'Sähe das in drei Jahren ausgedruckt und abgelegt noch richtig aus?',
            'Impliziert irgendetwas, dass die Maschine entschieden hat? Dann umschreiben.',
          ].map((q, i) => (
            <li key={q} className="flex gap-3 border-b py-2 last:border-b-0">
              <span className="text-muted-foreground font-mono text-xs">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span>{q}</span>
            </li>
          ))}
        </ol>
      </Section>
    </main>
  )
}
