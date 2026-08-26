'use client'

/**
 * Dev gallery for the project intake wizard: renders the whole wizard offline
 * (no auth / DB / API) via `definitionOverride`, so its atomic field components
 * — number_tri with answer modes, yes_no_open, chip multi-select, document-role
 * slot, derivation placeholder, Bauwerk cards, review — can be reviewed and
 * screenshotted in one place. Not linked from anywhere; 404 outside development.
 *
 * `?variant=bestand` seeds a Bestandsgebäude and opens Modul C, which is where
 * the v1.2 catalog put its largest new block (CB1–CB7_*) and where a screenshot
 * is the only way to see the conditional block actually unfold.
 */

import { notFound } from 'next/navigation'
import { use } from 'react'

import { ProjectIntakeWizard } from '@/features/projects/components/project-intake-wizard'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectProfile } from '@/lib/project-profile/types'

const fact = (value: unknown) => ({
  value: value as never,
  confidence: 'confirmed' as const,
  source: 'onboarding' as const,
  updatedAt: '2026-08-01T00:00:00.000Z',
})

/** A Bestandsgebäude mid-Sanierung: enough to unfold Modul C's whole block. */
const BESTAND_PROFILE: ProjectProfile = {
  facts: {
    project_name: fact('Demo · Hoftrakt Lacknergasse'),
    standort_adresse: fact('Lacknergasse 12, 1170 Wien'),
    country: fact('at'),
    bundesland: fact('wien'),
    vorhabensart: fact(['sanierung', 'umbau']),
    projektphase: fact('vorentwurf'),
    'bauwerk_name@bw1': fact('Hoftrakt'),
    'bauwerkstyp@bw1': fact('gebaeude'),
    'errichtungsstatus@bw1': fact('bestand'),
    'baujahr_bestand@bw1': fact(1962),
    'bestand_nutzung@bw1': fact('Werkstatt und Lager'),
    'denkmalschutz@bw1': fact(false),
    'bestand_massnahmen@bw1': fact(['huelle_sanierung', 'umbau_innen']),
    'bestand_geschosse_oberirdisch@bw1': fact(3),
    'geschosse_oberirdisch@bw1': fact(4),
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

export default function IntakeGalleryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const params = use(searchParams)
  const bestand = params.variant === 'bestand'

  return (
    <main className="bg-background min-h-screen">
      <ProjectIntakeWizard
        key={bestand ? 'bestand' : 'default'}
        projectId={bestand ? 'dev-bestand' : 'dev'}
        projectName={bestand ? 'Demo · Hoftrakt Lacknergasse' : 'Demo · WHA Quellenstraße'}
        mode={bestand ? 'edit' : 'create'}
        initialStep={bestand ? 2 : 0}
        initialProfile={bestand ? BESTAND_PROFILE : null}
        definitionOverride={projectIntakeDefinitionV1}
      />
    </main>
  )
}
