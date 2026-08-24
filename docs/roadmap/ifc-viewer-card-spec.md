# Spec (phase 3): IFC/BIM Viewer Card — **SUPERSEDED, BUILT DIFFERENTLY**

> **Status (2026-08-08): superseded by
> [ADR-0045](../adr/0045-ifc-models-as-a-queryable-building-not-a-document.md),
> which is the record of what was actually built. This file is kept as the
> design that was considered and where it turned out to be wrong.**
>
> Two things changed. The viewer library is **ifc-lite** (Rust/WASM +
> WebGPU), not `web-ifc` + ThatOpen, and there is **no Fragments conversion
> pipeline** — ifc-lite streams first triangles during the parse, so the
> conversion step, its storage artefact and its cache-invalidation story all
> disappeared. More importantly, the spec below treats the problem as "render
> the model", and the larger half turned out to be "answer questions about it":
> a structured index the agent queries deterministically, a validation pass that
> qualifies those answers, and a revision comparison. The `ifc_viewer` card is
> one surface of that, not the feature.
>
> ---
>
> Original text follows.
>
> Build-ready design for a card that renders an architect's **actual IFC/BIM
> model** in the browser, with GRID's compliance findings overlaid. This is the
> domain-native "3D model" no generic tool has. Scoped separately because it is a
> mini-project (WASM, a conversion/caching pipeline), not a phase-1 schematic.
> Forward-looking — not yet built.

## Why it's worth it

Architects already produce **IFC** models (the open BIM exchange format). A card
that loads the project's IFC and lets the agent **point at real geometry** —
"this stairwell exceeds the 40 m Fluchtweg", highlighted on the actual model — is
unmatched by any generic file tool and turns GRID from "reads your PDFs" into
"understands your building."

## The hard truth (from the library research)

- **`web-ifc`** (MPL-2.0, ~0.4 MB gz WASM) parses IFC in-browser at native speed;
  **`@thatopen/components`** (MIT) is the viewer platform on top of three.js.
- **Do NOT parse IFC at runtime in production.** ThatOpen's own guidance: convert
  once to **Fragments** (`.frag`, a compact binary) and cache it; runtime IFC
  parsing of large models is too slow. So this needs a **conversion + storage
  pipeline**, not just a viewer component.
- Strict CSP (if ever enabled) must allow **`wasm-unsafe-eval`** in `script-src`,
  and the `.wasm` must be self-hosted (offline — configurable path). Fits the
  self-contained constraint but must be deliberate.

## Architecture (fits the existing system)

```
Upload .ifc  → SeaweedFS (org/<org>/project/<pid>/ifc/<docId>/model.ifc)
             → conversion job (web-ifc → Fragments .frag)  [worker]
             → cache .frag in SeaweedFS + a `bim_models` row (grid_app)
Chat/agent   → emits an `ifc_viewer` card { modelId, highlights[], camera? }
Frontend     → lazy-loads @thatopen viewer (next/dynamic ssr:false)
             → streams the .frag from a presigned URL
             → applies highlights (elementIds → color) + camera
```

- **Conversion runs off the request** (like the deletion purger / ingest jobs) —
  either a new lightweight worker or an extension of the Python backend, writing
  `.frag` back to SeaweedFS. Reuses the existing SeaweedFS + presign + job patterns.
- **`bim_models`** table (grid_app, single-writer BFF): `id`, `project_id`,
  `document_id`, `frag_key`, `status` (converting/ready/failed), `element_index`
  (optional: IFC GUID → human label map for the agent to reference).
- The card is **client-only** and **lazy** — the ~200 KB+ viewer never touches the
  chat bundle until an `ifc_viewer` card actually renders.

## The card contract (LLM emits parameters only)

```
IfcViewerCard {
  type: "ifc_viewer"
  title: str
  model_id: str                     # references a ready bim_models row
  highlights: list[{
    element_ids: list[str]          # IFC GUIDs (from the element_index / prior tool)
    label: str                      # e.g. "Fluchtweg > 40 m"
    status: "pass" | "fail" | "warning" | "info"
  }] | None
  camera: { target?: [x,y,z], position?: [x,y,z] } | None
  note: str | None
}
```

The LLM never invents geometry — it references **element GUIDs** surfaced by a
retrieval/analysis tool over the model's `element_index`, and a status. The viewer
does the rendering.

## Dependencies (phase 3 only)

`web-ifc` (MPL-2.0), **`@thatopen/components` + `@thatopen/components-front`**
(MIT — the maintained successor to IFC.js; supersedes the deprecated
`web-ifc-viewer` / `web-ifc-three`), `@thatopen/fragments`, and `three` (+
`@react-three/fiber` if the massing card already added it). Self-host the `.wasm`.
Lazy-load everything.

### React integration (there's no drop-in component — write a thin wrapper)

ThatOpen is three.js-based and framework-agnostic; the standard React pattern is a
small client wrapper (not a hand-roll, not a magic one-liner):

```tsx
'use client'
// <IfcViewerCard> — lazy-loaded via next/dynamic(ssr:false)
export function IfcViewer({ fragUrl, highlights }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let world: any, components: any, disposed = false
    ;(async () => {
      const OBC = await import('@thatopen/components')
      components = new OBC.Components()
      // init world (scene/camera/renderer) into ref.current, load the .frag,
      // apply `highlights` (elementId -> color) via the Highlighter, set camera
    })()
    return () => { disposed = true; components?.dispose() }   // critical: dispose on unmount
  }, [fragUrl])
  return <div ref={ref} className="h-[420px] w-full overflow-hidden rounded-xl" />
}
```

Key React concerns: mount into a ref, **dispose the ThatOpen `Components`/world on
unmount** (WebGL leaks otherwise), lazy-load so the ~MB viewer never enters the
chat bundle, and guard against the async init resolving after unmount
(`disposed` flag). `@thatopen/ui` (web components) is an alternative for toolbars
but the viewport itself is the wrapper above.

## Phasing within this feature

1. **Ingest + convert:** upload `.ifc` → job converts to `.frag` → `bim_models`
   ready. (No UI yet — prove the pipeline.)
2. **Viewer card:** render a ready model, orbit/zoom, isolate storeys.
3. **Findings overlay:** agent highlights element GUIDs with status + camera.
4. **Compliance link:** connect to the compliance-workspace board (a finding on
   OIB 2 highlights the offending elements) — the payoff.

## Why it's not phase 1

It needs a conversion pipeline, a storage table, a WASM/CSP decision, and a viewer
platform — each small, but together a real project. The phase-1 SVG schematics
deliver "value above text" now with zero of that risk; this is the ambitious
follow-on once they've proven the card surface.

## Prerequisite

An `element_index` (IFC GUID → label) the agent can query, so highlights reference
real elements. Produced during conversion (web-ifc exposes the IFC element tree).
