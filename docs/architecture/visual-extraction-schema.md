# Visual extraction: kernel, domains, and where they should live

> Design spec for the schema that turns an image into indexed knowledge. It
> covers what is built today, the reasoning behind each decision, and the
> staged answer to "who owns the vocabulary" — which ends in the database, but
> deliberately does not start there.
>
> How the ingestion *pipeline* is decomposed is a separate document:
> [`visual-ingestion.md`](visual-ingestion.md). This one is about the *schema*.

## The problem

Piloti reads images that arrive three ways — a rendered PDF page, a raster
embedded in a PDF, an uploaded image file — and has to turn each into something
retrievable and citable. Two failures shaped this design:

1. **The three sources diverged.** Rendered pages got a structured analysis
   while embedded rasters got a generic caption prompt, so a scanned plan
   *inside* a PDF was indexed as one paragraph while the identical sheet as a
   vector page was indexed per drawing. Same content, different answer,
   depending on how it happened to be embedded.
2. **The schema was the domain.** `rooms`, `circulation`, `envelope`,
   `building_physics` were top-level fields. That reads beautifully for a
   Grundriss and has nowhere to put a site plan's planting, a schematic's
   components, or a product photo's parts. Every non-architectural upload
   degraded to prose, and adding a domain meant editing the schema, the parser
   and the UI together.

## The shape

Three things, kept apart, each replaceable without the others.

| Layer | Owns | Lives in | Changes when |
|---|---|---|---|
| **Kernel schema** | The shape: segments, entities, compositions, states, quantities, relations, annotations, provenance | `visual_analysis.py` | Rarely. A bump is a migration. |
| **Domain vocabulary** | The words: what a segment can be, what can be named in one, what states it can hold | `visual_domains.py` | Whenever a domain is added or refined |
| **Orchestration** | Which bytes get analysed, what metadata rides along, where chunks land | `adapter.py`, `processing.py` | Independently of both |

The rule that keeps them apart: **adding a domain must not require a change to
the kernel, the parser, or the UI.** If it does, the thing it needs belongs in
the kernel instead. That rule is tested, not just stated — the frontend renders
a category it has never heard of by humanizing its key, and a test pins it.

### The kernel

A visual is **segments**. A segment is one depiction — a plan, a section, a
chart, a photo. Each carries:

- `domain` + `segment_type` — the vocabulary it was read with, and what it is
- `scale`, `title`, `summary` — free text, per segment, in the document's language
- `entities` — every named thing, each with a `category` from its domain
- `compositions` — layered build-ups, layers in order
- `states` — lifecycle per element, where the domain has such a notion
- `quantities` — object + property + value + unit, never a bare number
- `relations` — subject → relation → object triples
- `annotations` — verbatim dimension and label strings
- `bbox`, `source`, `confidence`

Nothing there names a room or a floor plan. A room is an entity whose category
is `space` in the `architecture` domain.

### One image, several domains

**The domain is chosen per segment, not per image.** Real sheets mix: a plan
sheet carries a floor plan, a construction detail, a legend, a site photo and
an energy chart. Making the domain a property of the image would force one of
those to be mislabelled, and the mislabelling is not cosmetic — it decides
which vocabulary the entities are validated against and how the chunk is typed
for citation.

This matches how the field handles mixed content. [DocLayNet][doclaynet] keeps
11 *region* labels and 6 *document-domain* labels on separate axes rather than
taking their cross-product; [M6Doc][m6doc] shows what flattening costs — 74
classes and brittle. Per-region labelling is the settled answer.

Chunk typing follows from the segment's **role**, not its name. Every domain
declares each of its segment types as `primary`, `chart` or `pictorial`, and
precedence picks one for the image: a plan sheet carrying a chart is still a
plan sheet, because the reader came for the plan.

### The JSON Schema, and what it deliberately cannot say

`visual_analysis.json_schema(registry)` emits a standalone JSON Schema
document. One artifact, three uses: handed to providers that support
schema-constrained decoding, rendered into a compact shape for those that do
not, and the contract for anything downstream.

It is written to the **intersection** of what structured-output implementations
accept, not to what JSON Schema can express:

- objects only at the root, `additionalProperties: false` everywhere
- every property in `required`; optionality carried by `["string", "null"]`
- no `pattern`, no length or numeric bounds, no `$ref`, no recursion
- **no `if`/`then`/`allOf`/`oneOf`**

That last one is the interesting constraint. "A category must belong to the
segment's domain" is conditional validation, and the strict subsets reject it:
OpenAI's supported-keyword list omits it, Anthropic's SDKs silently strip it
into a field description, and xgrammar fails to compile with an error that does
not name the offending keyword. So the schema carries the **flat union** of
every enabled domain's terms, and the domain-conditional check lives in
`parse_visual_analysis`, where the segment's domain is known. A test asserts
the schema contains none of those keywords, so a well-meaning future edit that
adds one fails loudly rather than silently ceasing to be accepted.

Nullable enums are avoided for the same reason: `source` and `confidence` offer
an explicit `unknown` member instead of allowing `null`, which says the same
thing in a plain string enum that every implementation accepts.

Enum sizes stay far inside the safe range — 15 segment types, 14 categories, 5
states, against published caps in the hundreds and practical guidance of
30–50 per enum before accuracy degrades.

### Identity: what a cache key has to name

`cache_prompt_type()` keys on `visual:v{schema}:{domains}@{content_hash}`.

The domain list names *which* vocabularies are on. The hash names *what they
say* — a digest over every enabled domain's terms, labels, hints and guidance.
The difference is invisible while the vocabulary is code, because a deploy
changes both together, and total the moment it is editable: renaming a category
changes what the model is asked to look for, and a key naming only the domain
set would serve the old reading for the cache's whole 30-day TTL.

The same fingerprint is stamped onto every extracted payload. That is the
enabling move for everything in the roadmap below: "which records were produced
under the old vocabulary" becomes a query rather than a guess, and a backfill
can touch only what actually changed.

### Terms have a lifecycle

Keys are immutable and travel into stored payloads; labels and hints are free
to change. A term is **deprecated, never deleted**: it stops being offered to
the model, so nothing new is written under it, while records that already
reference it keep resolving and rendering. This is the SKOS discipline
(a concept whose meaning changed is a different concept) and the Salesforce
picklist discipline (deactivate, don't delete) — both cost days now and a
migration later.

## Where the vocabulary should live

The vocabulary is currently code. It should end up in the database, editable by
platform owners. It should not go there yet, and the sequencing matters.

The repo already runs this exact pattern for models
([`org-model-configuration.md`](org-model-configuration.md), ADR-0014):

| Layer | Who writes it | Scope |
|---|---|---|
| Org selection | org admin | one tenant |
| Platform catalog | platform owner, in the admin UI | every tenant that has not chosen |
| Code default | a commit | boot floor, and the fallback when the DB is unreachable |

Applied here that becomes: platform owners curate the domain catalog; orgs
*select* which domains are enabled for them; `visual_domains.py` remains the
seed and the fallback, never a competing truth.

**Staged, cheapest first:**

1. **Done.** Content-hash identity in the cache key and stamped on every
   payload; term lifecycle (`status`, `replaced_by`) in code; one vocabulary,
   in English, with a tested extensibility rule.
2. **Next, and cheap.** Org *selection* of platform-curated domains — the
   `curated_skill_activations` pattern, storing the decision and never a copy
   of the body, so a tenant's choice cannot drift from the catalog. This covers
   most of the demand at a fraction of the cost of authoring.
3. **Then, platform-owner authoring.** `vocab_domain` + append-only
   `vocab_domain_version` with a published JSONB snapshot, rollback by
   repointing — the ADR-0014 two-table shape. Normalize for editing, snapshot
   for serving; never build a prompt by joining term tables at request time.
4. **Only if asked: tenant-authored terms.** Namespaced (`org:<slug>/<key>`) so
   a tenant can never collide with or redefine a platform key, and label
   shadowing only. One tenant renaming a shared term would otherwise silently
   change what another tenant's stored records appear to say.

**Guardrails that belong in the database, not the form:** unique
`(domain, kind, key)`; a key regex; reserved keys (`other`, and the `general`
domain, which cannot be disabled because segments fall back to it); a cap on
active terms sized to the structured-output enum ceiling, validated at publish
— a vocabulary that cannot be decoded is worse than one that is too small.

**Publishing needs a diff classification**, because only one class costs money:
*additive* (new terms — no reprocessing), *cosmetic* (label and hint edits —
re-render only), *semantic* (deprecation, splits, a hint rewrite that changes
what the model looks for — reprocess the affected records). The admin should
see the affected document count before confirming.

### Why not now

The demand does not exist yet: no second domain has been asked for by a
customer. ADR-0025 is this repo's own warning about building the general
mechanism first — the norm registry's typed relation graph computed nothing
that reached the LLM and was deleted after review. The identity and lifecycle
work above is the part that is expensive to retrofit; the tables are not.

## Domains that plausibly come next

Each is a `Domain` in `visual_domains.py` and nothing else. Roughly in order of
likelihood for this product:

| Domain | Entity categories it would need |
|---|---|
| Structural engineering | framing, reinforcement, connections, loads, supports |
| MEP / building services | ducts, pipes, risers, equipment schedules, valves |
| Fire protection | escape routes, compartments, ratings, sprinklers, hydrants |
| Electrical schematics | single-line diagrams, panels, circuits, cable routes |
| Surveying / cadastral | parcels, boundaries, easements, benchmarks, contours |
| Landscape / external works | planting, species, paving, drainage, tree protection |
| Site progress photography | trades, defects, plant, safety observations |
| Energy performance | certificates, U-values, thermal bridges, thermography |
| Geotechnical | borehole logs, soil profiles, groundwater |
| Legal / regulatory figures | normative diagrams, clause tables, stamps, approvals |
| Facility management | asset tags, maintenance schedules, room data sheets |
| Mechanical part drawings | orthographic views, GD&T frames, BOM tables |

The last one is the useful stress test: none of the built-environment
assumptions (sheets, title blocks, scale bars) hold for a medical image or a
micrograph, and the kernel should survive that. It does — `measure_label` is
per-domain precisely because a plan has a scale and a micrograph has a
magnification.

## Known next steps, in the pipeline rather than the schema

- **Route, then extract.** Today one call is given every enabled domain's
  vocabulary. The better shape for accuracy is a cheap first pass that assigns
  a domain per region, then a second pass given only that domain's schema —
  smaller grammar, smaller label space, and the evidence favours coarse-to-fine.
  The kernel does not change; `analyze_visual` gains a stage.
- **Detector before the model.** A layout detector cropping each view, so every
  extraction inherits a real bounding box instead of an approximate one.
- **Resolve to external codes after the fact.** Emit a small kernel category
  plus free text, then map to IFC / Uniclass / bSDD in a deterministic
  post-step where full lookup tables are free. Never put a thousand-term
  standard into a decoding grammar.

[doclaynet]: https://arxiv.org/abs/2206.01062
[m6doc]: https://openaccess.thecvf.com/content/CVPR2023/papers/Cheng_M6Doc_A_Large-Scale_Multi-Format_Multi-Type_Multi-Layout_Multi-Language_Multi-Annotation_Category_Dataset_CVPR_2023_paper.pdf
