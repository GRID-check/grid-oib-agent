'use client'

/**
 * Dev preview for the viewport's controls.
 *
 * The canvas needs WebGPU and headless Chromium has none, so the 3D picture
 * itself cannot be captured here — `/dev/bim-model` pins the no-WebGPU
 * fallback for that reason. What CAN be captured, now that the controls are a
 * component that owns no canvas, is every control an architect actually
 * presses. That is most of the surface area and all of the copy.
 *
 * Three states, because the toolbar has three shapes and only one of them is
 * the one people picture:
 *
 * - **Free view** — what you land on. Perspective, no cut, nothing pressed.
 * - **Grundriss** — plan, parallel projection, a cut at +1,00 m with the
 *   slider open. This is the state the whole feature exists for: a plan you
 *   can measure off, cut where an Austrian plan is cut.
 * - **Loading** — every control disabled. A toolbar that looks live while the
 *   model is still parsing invites clicks that do nothing.
 *
 * Rendered over the muted panel the viewport uses, so contrast is judged
 * against the real backdrop rather than against white.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import { IfcViewerToolbar } from '@/features/bim/components/ifc-viewer-toolbar'
import type { BimCameraView, BimSection } from '@/features/bim/lib/viewer-camera'

/** The model's vertical extent, as the loaded fixture reports it. */
const CUT_RANGE = { minMetres: -0.25, maxMetres: 6.25 }

function Stage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="relative h-56 overflow-hidden rounded-xl border bg-muted/30">
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
          <div className="flex items-center gap-2 rounded-lg bg-background/85 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
            <span>19 parts</span>
          </div>
          {children}
        </div>
      </div>
    </section>
  )
}

export default function BimViewportDevPage(): JSX.Element {
  const [view, setView] = useState<BimCameraView>('top')
  const [orthographic, setOrthographic] = useState(true)
  const [section, setSection] = useState<BimSection | null>({ atMetres: 1, flipped: false })

  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8" data-testid="bim-viewport-preview">
      <div>
        <h1 className="text-lg font-semibold">Model — viewport controls</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Orbit was never the hard part. These are the controls that turn a model into drawings:
          stand it square, draw it parallel so it measures, cut it where a plan is cut. All three
          live in the URL, so a section at +2,60 m looking north is a link.
        </p>
      </div>

      <Stage
        title="Free view"
        description="What you land on: perspective, no cut, nothing pressed."
      >
        <IfcViewerToolbar
          view="iso"
          onViewChange={() => {}}
          orthographic={false}
          onOrthographicChange={() => {}}
          section={null}
          onSectionChange={() => {}}
          cutRange={CUT_RANGE}
          defaultCutMetres={1}
          xray={false}
          onXrayChange={() => {}}
          onFit={() => {}}
        />
      </Stage>

      <Stage
        title="Grundriss — plan, parallel, cut at +1,00 m"
        description="Interactive: the slider moves the cut and the button flips which way it looks."
      >
        <IfcViewerToolbar
          view={view}
          onViewChange={setView}
          orthographic={orthographic}
          onOrthographicChange={setOrthographic}
          section={section}
          onSectionChange={setSection}
          cutRange={CUT_RANGE}
          defaultCutMetres={1}
          xray
          onXrayChange={() => {}}
          onFit={() => {}}
        />
      </Stage>

      <Stage
        title="Still loading"
        description="Every control disabled — a live-looking toolbar invites clicks that do nothing."
      >
        <IfcViewerToolbar
          view="iso"
          onViewChange={() => {}}
          orthographic={false}
          onOrthographicChange={() => {}}
          section={{ atMetres: 2.6, flipped: false }}
          onSectionChange={() => {}}
          cutRange={CUT_RANGE}
          defaultCutMetres={1}
          xray={false}
          onXrayChange={() => {}}
          onFit={() => {}}
          disabled
        />
      </Stage>
    </main>
  )
}
