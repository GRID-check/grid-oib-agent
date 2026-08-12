'use client'

/**
 * Dev preview for the viewer's chrome.
 *
 * The canvas needs WebGPU and headless Chromium has none, so the 3D picture
 * itself cannot be captured here — `/dev/bim-model` pins the no-WebGPU
 * fallback for that reason. What CAN be captured, now that every control is an
 * atom that owns no canvas, is the whole of the chrome: the dock, the rail,
 * the selection card, the loading veil. That is all of the copy and all of the
 * layout decisions.
 *
 * Rendered over the muted panel the stage uses, so contrast is judged against
 * the real backdrop rather than against white.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import {
  Eye,
  Home,
  Layers,
  PanelLeft,
  Scissors,
  SlidersHorizontal,
  Undo2,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ViewerDock,
  ViewerDockSeparator,
  ViewerField,
  ViewerFieldGroup,
  ViewerIconButton,
  ViewerPanel,
  ViewerProgress,
  ViewerRail,
  ViewerRailItem,
  ViewerRailSection,
  ViewerSlider,
} from '@/features/bim/components/viewer'

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
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="bg-muted/30 relative h-[34rem] overflow-hidden rounded-2xl border">{children}</div>
    </section>
  )
}

export default function BimViewportDevPage(): JSX.Element {
  const [cut, setCut] = useState<number | null>(1)
  const [xray, setXray] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [storey, setStorey] = useState<string | null>('Erdgeschoss')

  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8" data-testid="bim-viewport-preview">
      <div>
        <h1 className="text-lg font-semibold">Model — viewer chrome</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A handful of controls and two lists, floating over the building. Everything analytical
          is one button away rather than in front of the model, and the selection card does not
          exist until something is selected. The leading pill holds the two ways back — Undo, one
          act at a time, and the camera — and the trailing one the reset that drops every hide and
          isolation at once.
        </p>
      </div>

      <Stage
        title="The stage"
        description="Rail on the left, dock at the bottom, nothing in the middle. Interactive."
      >
        {railOpen && (
          <div className="absolute top-4 left-4 z-20 flex max-h-[calc(100%-2rem)]">
            <ViewerRail>
              <ViewerRailSection label="Modelle">
                <ViewerRailItem label="Haus-A_v3" selected />
                <ViewerRailItem label="Haus-A_v2" />
                <ViewerRailItem label="Nebengebäude" meta="wird gelesen" disabled />
              </ViewerRailSection>
              <ViewerRailSection label="Geschoße">
                <ViewerRailItem
                  label="Alle Geschoße"
                  selected={storey === null}
                  onClick={() => setStorey(null)}
                />
                <ViewerRailItem
                  label="Dachgeschoss"
                  meta="+6.25 m"
                  ariaLabel="Dachgeschoss"
                  selected={storey === 'Dachgeschoss'}
                  onClick={() => setStorey('Dachgeschoss')}
                />
                <ViewerRailItem
                  label="Erdgeschoss"
                  meta="±0.00 m"
                  ariaLabel="Erdgeschoss"
                  selected={storey === 'Erdgeschoss'}
                  onClick={() => setStorey('Erdgeschoss')}
                />
                <ViewerRailItem
                  label="Keller"
                  meta="−2.80 m"
                  ariaLabel="Keller"
                  selected={storey === 'Keller'}
                  onClick={() => setStorey('Keller')}
                />
              </ViewerRailSection>
            </ViewerRail>
          </div>
        )}

        <ViewerDock
          /*
            The pair that answers "get me back", and the preview was missing
            half of it — with the other half under a name the product had
            already dropped. "Alles anzeigen" is what the camera button used
            to be called, until it collided with the restore button beside it
            and a screen reader read out two near-identical names for two
            unrelated acts.
          */
          lead={
            <>
              <ViewerIconButton label="Letzte Änderung rückgängig machen" icon={Undo2} />
              <ViewerIconButton label="Ganzes Modell einpassen" icon={Home} />
            </>
          }
          above={
            cut !== null && (
              <ViewerSlider
                label="Schnitthöhe"
                min={CUT_RANGE.minMetres}
                max={CUT_RANGE.maxMetres}
                value={cut}
                display={`${cut.toFixed(2)} m`}
                onChange={setCut}
                action={
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs">
                    Blick nach unten
                  </Button>
                }
              />
            )
          }
          trail={
            <>
              {/*
                The reset. In the stage it appears only once something is out
                of the way; here it is always drawn, because the point of this
                route is to pin the chrome and its copy — and this is the one
                control whose name has to stay clearly apart from both Undo
                and the camera's "Ganzes Modell einpassen".
              */}
              <ViewerIconButton label="Alle Bauteile wieder einblenden" icon={Layers} />
              <ViewerIconButton
                label="Leiste ausblenden"
                icon={PanelLeft}
                active={railOpen}
                onClick={() => setRailOpen((open) => !open)}
              />
              <ViewerIconButton label="Details & Prüfung" icon={SlidersHorizontal} />
            </>
          }
        >
          <ViewerIconButton label="Ansicht" icon={Video} />
          <ViewerDockSeparator />
          <ViewerIconButton
            label="Schnitt"
            icon={Scissors}
            active={cut !== null}
            onClick={() => setCut((current) => (current === null ? 1 : null))}
          />
          <ViewerIconButton
            label="Durchsichtig"
            icon={Eye}
            active={xray}
            onClick={() => setXray((on) => !on)}
          />
        </ViewerDock>
      </Stage>

      <Stage
        title="Something is selected"
        description="The only time metadata is on screen at all — and it leads with the noun, not the schema."
      >
        <div className="absolute top-4 right-4 z-20 flex max-h-[calc(100%-2rem)]">
          <ViewerPanel
            title="AW 38"
            subtitle="Wall · Erdgeschoss"
            closeLabel="Schließen"
            onClose={() => {}}
            footer={
              <Button variant="ghost" size="sm" className="w-full justify-start">
                Piloti dazu fragen
              </Button>
            }
          >
            <ViewerFieldGroup label="Bauteil">
              <ViewerField label="Typ">Wall</ViewerField>
              <ViewerField label="Geschoss">Erdgeschoss</ViewerField>
              <ViewerField label="Materialien">Stahlbeton, Mineralwolle</ViewerField>
            </ViewerFieldGroup>
            <ViewerFieldGroup label="Qto_WallBaseQuantities">
              <ViewerField label="NetSideArea">18,44</ViewerField>
              <ViewerField label="Width">0,38</ViewerField>
            </ViewerFieldGroup>
          </ViewerPanel>
        </div>
      </Stage>

      <Stage
        title="Loading"
        description="A real percentage while the file downloads; no claimed position while it is parsed."
      >
        <ViewerProgress label="Modell wird geladen…" percent={62} />
      </Stage>

      <Stage title="Building geometry" description="No number, because there is no honest one.">
        <ViewerProgress label="Gebäude wird aufgebaut…" percent={null} />
      </Stage>
    </main>
  )
}
