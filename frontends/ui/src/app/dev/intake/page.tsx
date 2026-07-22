'use client'

/**
 * Dev gallery for the project intake wizard: renders the whole wizard offline
 * (no auth / DB / API) via `definitionOverride`, so its atomic field components
 * — number_tri with answer modes, yes_no_open, chip multi-select, upload slot,
 * derivation placeholder, Bauwerk cards, review — can be reviewed and
 * screenshotted in one place. Not linked from anywhere; 404 outside development.
 */

import { notFound } from 'next/navigation'

import { ProjectIntakeWizard } from '@/features/projects/components/project-intake-wizard'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'

export default function IntakeGalleryPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="min-h-screen bg-background">
      <ProjectIntakeWizard
        projectId="dev"
        projectName="Demo · WHA Quellenstraße"
        definitionOverride={projectIntakeDefinitionV1}
      />
    </main>
  )
}
