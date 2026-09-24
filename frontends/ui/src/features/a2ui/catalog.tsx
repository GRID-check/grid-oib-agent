'use client'

/**
 * The Piloti A2UI catalog: every card type as an A2UI component, the three
 * layout components an answer may compose them with, and `Text`, a run of the
 * answer's own Markdown (ADR-0065).
 *
 * Custom-only. A2UI's basic catalog is not registered: its styles are empty in
 * 0.11.1 and its Lit build registers custom elements on import. `Row`,
 * `Column`, `Tabs` and `Text` take the basic catalog's NAMES and shapes (so a
 * surface is plain A2UI v0.9) and are drawn with this product's atoms. `Text`
 * is narrowed to a `text` of Markdown: it is what lets a tab hold a table,
 * which the Markdown-first answer never puts on a card.
 *
 * A card component's props are that card's own fields, validated by the card's
 * generated Zod schema (`shared/cards/generated.ts`) — the same schema a card
 * outside A2UI is validated by, so there is one contract, not two. How a card
 * is DRAWN is not this module's business: the host hands a renderer down
 * (`CardRenderer`), which keeps `features/a2ui` free of every card component
 * and of the import cycle that would bring.
 */

import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react'
import { z } from 'zod'
import { Catalog, childList, componentId, type ComponentApi } from '@a2ui/web_core/v0_9'
import { createComponentImplementation, type ReactComponentImplementation } from '@a2ui/react/v0_9'

import { gridCardSchema, type GridCard } from '@/shared/cards/schemas'
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer/MarkdownRenderer'
import { useNestedMarkdownPlugins } from '@/shared/components/MarkdownRenderer/nested-plugins-context'

/** The catalog's identity on the wire; `createSurface.catalogId` must equal it. */
export const PILOTI_CATALOG_ID = 'https://piloti.at/a2ui/catalogs/cards/v1'

/** The layout components, named as in A2UI's basic catalog. */
export const LAYOUT_COMPONENTS = ['Row', 'Column', 'Tabs'] as const

/** The one leaf that is not a card: Markdown, named as in A2UI's basic catalog. */
export const TEXT_COMPONENT = 'Text'

/**
 * Draws one card. `leafId` is the component's id inside its surface: `root`
 * for a lone card, the model's own id for a card inside a composition.
 */
export type CardRenderer = (card: GridCard, leafId: string) => ReactNode

const CardRendererContext = createContext<CardRenderer | null>(null)
export const CardRendererProvider = CardRendererContext.Provider

/**
 * Called once A2UI has drawn a real component. A layout effect, so it runs in
 * the commit that mounted the component, before the browser paints: the host
 * swaps its direct copy for A2UI's without a frame of either the placeholder
 * or both copies.
 */
const DrawnContext = createContext<(() => void) | null>(null)
export const DrawnProvider = DrawnContext.Provider

function useReportDrawn() {
  const report = useContext(DrawnContext)
  useLayoutEffect(() => report?.(), [report])
}

type CardSchema = (typeof gridCardSchema.options)[number]

/** A card schema's `type` literal; one card defaults it, which wraps the literal. */
function cardTypeOf(schema: CardSchema): string {
  const field: z.ZodTypeAny = schema.shape.type
  const literal = field instanceof z.ZodDefault ? field._def.innerType : field
  return (literal as z.ZodLiteral<string>).value
}

/** A card component's props: the card's fields without its `type`, which is the component name. */
function cardComponentApi(schema: CardSchema): ComponentApi {
  return { name: cardTypeOf(schema), schema: (schema as z.AnyZodObject).omit({ type: true }) }
}

function cardComponent(schema: CardSchema): ReactComponentImplementation {
  const api = cardComponentApi(schema)
  const type = api.name
  return createComponentImplementation(api, function A2uiCardComponent({ props, context }) {
    const render = useContext(CardRendererContext)
    useReportDrawn()
    if (!render) return null
    // `display: contents`: no box of its own. The attribute is how the host
    // knows A2UI has drawn a real component rather than its placeholder.
    return (
      <div className="contents" data-a2ui-node={type}>
        {render({ ...(props as object), type } as GridCard, context.componentModel.id)}
      </div>
    )
  })
}

const RowApi = {
  name: 'Row',
  schema: z
    .object({
      children: childList(),
      justify: z.enum(['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch']).optional(),
      align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
    })
    .strict(),
}
const ColumnApi = { ...RowApi, name: 'Column' }
const TabsApi = {
  name: 'Tabs',
  schema: z
    .object({
      tabs: z.array(z.object({ title: z.string(), child: componentId() }).strict()).min(1),
    })
    .strict(),
}

/**
 * Side by side where there is room, stacked where there is not. A container
 * query, not a breakpoint: the same surface sits in the answer column, a side
 * panel and a phone, and only its own width says whether two cards fit. 44rem
 * because a card under ~340px crowds its own margin (legal_basis's Fundstelle,
 * a calculation's operands): in the 680px answer column a Row stacks, and it
 * goes side by side only on a surface wider than that.
 */
function RowView({ ids, buildChild }: { ids: string[]; buildChild: (id: string) => ReactNode }) {
  useReportDrawn()
  return (
    <div className="@container" data-a2ui-node="Row">
      <div className="grid items-start gap-3 @[44rem]:grid-flow-col @[44rem]:auto-cols-fr">
        {ids.map((id) => (
          <div key={id} className="min-w-0">
            {buildChild(id)}
          </div>
        ))}
      </div>
    </div>
  )
}

const Row = createComponentImplementation(RowApi, ({ props, buildChild }) => (
  <RowView ids={props.children as string[]} buildChild={buildChild} />
))

function ColumnView({ ids, buildChild }: { ids: string[]; buildChild: (id: string) => ReactNode }) {
  useReportDrawn()
  return (
    <div className="flex flex-col gap-3" data-a2ui-node="Column">
      {ids.map((id) => (
        <div key={id} className="min-w-0">
          {buildChild(id)}
        </div>
      ))}
    </div>
  )
}

const Column = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <ColumnView ids={props.children as string[]} buildChild={buildChild} />
))

/**
 * Variants, one at a time: the product's own tabs atom (`components/ui/tabs`),
 * so a composed answer switches the way every other tab strip in the app does
 * — the gliding pill, the focus ring, the 44px touch floor.
 */
function TabsView({ tabs, buildChild }: { tabs: { title: string; child: string }[]; buildChild: (id: string) => ReactNode }) {
  useReportDrawn()
  return (
    <UiTabs defaultValue={tabs[0]?.child} className="gap-3" data-a2ui-node="Tabs">
      <TabsList className="max-w-full justify-start overflow-x-auto">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.child} value={tab.child} className="flex-none">
            {tab.title}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.child} value={tab.child} className="mt-0 min-w-0">
          {buildChild(tab.child)}
        </TabsContent>
      ))}
    </UiTabs>
  )
}

const Tabs = createComponentImplementation(TabsApi, ({ props, buildChild }) => (
  <TabsView tabs={props.tabs as { title: string; child: string }[]} buildChild={buildChild} />
))

const TextApi = { name: TEXT_COMPONENT, schema: z.object({ text: z.string().trim().min(1) }).strict() }

/**
 * A run of the answer's Markdown, drawn by the renderer the prose is drawn by,
 * with the answer's citation plugin (`NestedMarkdownPluginsProvider`), so a
 * table in a tab looks and cites exactly like one in the prose.
 */
export function TextBlock({ text }: { text: string }) {
  const plugins = useNestedMarkdownPlugins()
  return (
    <div className="min-w-0" data-a2ui-node={TEXT_COMPONENT}>
      <MarkdownRenderer content={text} remarkPlugins={plugins} />
    </div>
  )
}

function TextView({ text }: { text: string }) {
  useReportDrawn()
  return <TextBlock text={text} />
}

const Text = createComponentImplementation(TextApi, ({ props }) => <TextView text={String(props.text)} />)

let catalog: Catalog<ReactComponentImplementation> | null = null

/** The catalog, built once on first use. */
export function pilotiCatalog(): Catalog<ReactComponentImplementation> {
  // `surface` is not a component: it is the envelope a composition travels in,
  // unpacked into its own components by `cardToSurfaceMessages`.
  const cards = gridCardSchema.options.filter((schema) => cardTypeOf(schema) !== 'surface')
  catalog ??= new Catalog(PILOTI_CATALOG_ID, [...cards.map(cardComponent), Row, Column, Tabs, Text])
  return catalog
}

/**
 * Why the catalog would not draw these components, or null when it would.
 *
 * A2UI draws an unknown component as red "Unknown component type" text inside
 * the answer and an invalid one as its validation message. Neither may reach a
 * reader, so a surface is checked here first and, on any failure, drawn
 * without A2UI (`A2uiCard`'s fallback).
 */
export function preflight(components: Record<string, unknown>[]): string | null {
  const registry = pilotiCatalog().components
  for (const { id, component, ...props } of components) {
    const api = registry.get(String(component))
    if (!api) return `'${String(id)}': no component '${String(component)}' in the catalog`
    const result = api.schema.safeParse(props)
    if (!result.success) return `'${String(id)}' (${String(component)}): ${result.error.issues[0]?.message ?? 'invalid'}`
  }
  return null
}
