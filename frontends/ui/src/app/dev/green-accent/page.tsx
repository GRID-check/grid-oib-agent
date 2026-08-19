'use client'

/**
 * The Piloti green, in one place.
 *
 * The accent is deliberately spread thin — a ring here, a tick there — which is
 * what makes it tasteful and also what makes it impossible to review by walking
 * the app: nobody sees a focus ring, a checked switch, a running progress bar
 * and the active rail icon on the same screen. This page puts every appearance
 * of `--brand` side by side, in both themes, so a retune of the token can be
 * judged against all of them at once instead of against whichever screen the
 * reviewer happened to open.
 *
 * One column, not a light/dark pair: the screenshot harness captures every
 * `/dev` target in BOTH themes off a single load (`visual/registry.mjs`), so a
 * hand-built `.dark` half would only duplicate what the dark PNG already shows —
 * and the ramp flips between the two (olive on paper, lime on charcoal, see
 * tokens.css), which is exactly what the pair of shots is for.
 *
 * Not linked from anywhere; `/dev/*` 404s outside development (see ../layout.tsx).
 */

import { Check } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'

/** One labelled specimen. The label is what a reviewer compares, not the box. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-muted-foreground text-[10.5px] font-medium tracking-wider uppercase">
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}

function Specimens(): JSX.Element {
  return (
    <div className="bg-background text-foreground flex flex-col gap-6 rounded-xl border p-6">
      {/* The ramp itself, so a token change is visible as colour before it is
          visible as a control. */}
      <div className="flex gap-2">
        {[
          ['bg-brand-tint', 'tint'],
          ['bg-brand-tint-strong', 'tint+'],
          ['bg-brand', 'brand'],
          ['bg-brand-hover', 'hover'],
          ['bg-brand-pop', 'pop'],
        ].map(([cls, name]) => (
          <div key={name} className="flex flex-1 flex-col gap-1">
            <div className={`${cls} h-10 rounded-md border`} />
            <span className="text-muted-foreground font-mono text-[10px]">{name}</span>
          </div>
        ))}
      </div>

      <div className="divide-y">
        <Row label="Focus (Tab me)">
          <Input className="w-44" defaultValue="a field" aria-label="Field" />
          <Button variant="outline" size="sm">
            a button
          </Button>
        </Row>
        <Row label="Checked">
          <div className="flex items-center gap-2">
            <Checkbox id="ga-check" defaultChecked />
            <Label htmlFor="ga-check">gesetzt</Label>
          </div>
          <RadioGroup defaultValue="a" className="flex gap-3">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="a" id="ga-radio-a" />
              <Label htmlFor="ga-radio-a">A</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="b" id="ga-radio-b" />
              <Label htmlFor="ga-radio-b">B</Label>
            </div>
          </RadioGroup>
          <Switch defaultChecked aria-label="An" />
        </Row>
        <Row label="Chosen">
          <span className="text-brand inline-flex items-center gap-1 text-sm">
            <Check className="size-4" aria-hidden /> gewählt
          </span>
        </Row>
        <Row label="In flight">
          <Progress value={62} className="w-44" />
        </Row>
        <Row label="Labels">
          <Badge variant="brand">Live</Badge>
          <Chip variant="brand">Neu</Chip>
          <Button variant="link" size="sm">
            ein Link
          </Button>
        </Row>
        <Row label="Selection">
          <p className="text-sm select-all">Markiere diesen Satz.</p>
        </Row>
      </div>
    </div>
  )
}

export default function GreenAccentDevPage(): JSX.Element {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-10" data-testid="green-accent-preview">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Piloti green — every appearance</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Der Akzent markiert, was <em>live oder gewählt</em> ist. Tinte bleibt die Handlungsfarbe,
          die Provenienz-Signale bleiben die Herkunftsfarben.
        </p>
      </header>
      <Specimens />
    </main>
  )
}
