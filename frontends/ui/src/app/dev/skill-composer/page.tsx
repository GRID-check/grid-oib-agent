'use client'

/**
 * Dev preview for the composer half of Agent Skills — the REAL
 * `SlashCommandPicker` above the REAL `InvokedSkillChip`, in the 680px column
 * the composer occupies, so the two are reviewed as the one gesture they are:
 * type `/`, pick a skill, and see what got attached to the message.
 *
 * Fetch-free by construction. The picker takes its skills as props (the
 * composer is what talks to `useInvocableSkills`), so unlike `/dev/skills-panel`
 * this route needs no shim at all.
 *
 * The query is deliberately non-empty (`/oib`): with an empty fragment nothing
 * is filtered and nothing is emphasised, so the `<mark>` that tells the reader
 * WHY a row is in the list could not appear in any screenshot. The fixture is
 * chosen so the same fragment is matched two ways — in the NAME of the two
 * `oib-…` skills (rank 0, and the only rows carrying an emphasised fragment)
 * and only in the DESCRIPTION of the other three (rank 2) — which is the
 * ranking the menu actually applies.
 *
 * Variants via `?variant=`:
 *   - default — the typed state plus the chip for the skill that was picked.
 *   - empty   — `skills={[]}`, the state an organisation sees before anyone has
 *               authored a skill. Worth its own target because that panel is the
 *               only place in the product that explains what a skill IS.
 *
 * Pinned to German: it is the product's primary language, so the evidence
 * carries that copy regardless of the capture machine's locale cookie. No
 * `notFound()` of its own — the `/dev` layout is a Server Component and gates
 * every preview route out of production on a server boundary.
 */

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { InvokedSkillChip } from '@/features/skills/components/InvokedSkillChip'
import {
  SlashCommandPicker,
  type SlashCommandSkill,
} from '@/features/skills/components/SlashCommandPicker'

const SKILLS: SlashCommandSkill[] = [
  {
    name: 'oib-brandschutznachweis',
    description:
      'Prüft das Projekt gegen OIB-Richtlinie 2 und listet jede Abweichung mit Klausel und Korrekturvorschlag. Einsetzen, wenn ein Brandschutznachweis erstellt oder vor der Einreichung gegengeprüft werden soll.',
    origin: 'platform',
  },
  {
    name: 'oib-fluchtweg-check',
    description:
      'Prüft Fluchtweglängen, Gangbreiten und Stiegenhäuser gegen OIB-Richtlinie 2.3. Einsetzen bei Fragen zu Fluchtwegen, Notausgängen und zur Entfluchtung einzelner Geschoße.',
    origin: 'platform',
  },
  {
    name: 'energieausweis-vorpruefung',
    description:
      'Vergleicht die Bauteilaufbauten mit den Höchstwerten der OIB-Richtlinie 6 und nennt die Bauteile, die den Nachweis kippen. Einsetzen vor der Beauftragung des Energieausweises.',
    origin: 'org',
  },
  {
    name: 'schallschutz-bericht',
    description:
      'Entwirft den Schallschutznachweis nach OIB-Richtlinie 5 aus den Projektunterlagen. Einsetzen, wenn Trennbauteile zwischen Wohnungen oder gegen Stiegenhäuser zu beurteilen sind.',
    origin: 'org',
  },
  {
    name: 'einreichplan-checkliste',
    description:
      'Geht den Einreichplan gegen die Wiener Bauordnung und die zugehörigen OIB-Richtlinien durch. Einsetzen kurz vor Abgabe, um fehlende Angaben und Pläne zu finden.',
    origin: 'platform-clone',
  },
]

export default function SkillComposerPreviewPage(): JSX.Element {
  const params = useSearchParams()
  const variant = params?.get('variant') ?? 'default'
  const isEmpty = variant === 'empty'

  // Operable rather than a still: picking a row moves the chip, which is the
  // whole point of the pair being on one page.
  const [invoked, setInvoked] = useState<SlashCommandSkill>(SKILLS[0])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="skill-composer-preview"
        // The column the composer gets, on the page background rather than on a
        // card: the picker ships as a floating panel, so a surface behind it
        // would flatten the shadow that separates it from the thread.
        className="text-foreground mx-auto flex w-full max-w-[680px] flex-col gap-8 p-6"
      >
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
            {isEmpty
              ? 'Slash-Menü — Organisation ohne Skills'
              : 'Slash-Menü — getippt: /oib'}
          </h2>

          <SlashCommandPicker
            query={isEmpty ? '' : 'oib'}
            skills={isEmpty ? [] : SKILLS}
            onSelect={(skill) => setInvoked(skill)}
          />

          {!isEmpty && (
            <>
              <h2 className="text-muted-foreground mt-4 text-[10.5px] font-medium uppercase tracking-wider">
                Nach der Auswahl — unter dem Eingabefeld
              </h2>
              {/* `onRemove` supplied: the removable form is the one every author
                  meets, and an unremovable chip only exists on a read-only
                  composer. */}
              <InvokedSkillChip
                name={invoked.name}
                description={invoked.description}
                onRemove={() => undefined}
              />
            </>
          )}
        </section>
      </main>
    </I18nProvider>
  )
}
