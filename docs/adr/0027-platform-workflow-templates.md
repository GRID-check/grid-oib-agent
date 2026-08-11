# ADR-0027: Platform-managed workflow templates

- **Status:** Superseded by [ADR-0046](0046-agent-skills.md)
- **Date:** 2026-07-23
- **Deciders:** Grid engineering (platform owner request)
- **Related:** ADR-0016 (platform tier), ADR-0023 (workflows — also superseded), ADR-0017 (BFF repository/service), ADR-0007 (no cross-tenant FKs), ADR-0046 (Agent Skills — supersedes this ADR)

> **Superseded by ADR-0046 (Agent Skills).** This ADR's subject — the
> Workflows gallery — was removed together with Workflows itself, and the
> `platform_workflow_templates` table, its platform CRUD routes and its
> manager UI went with it. Agent Skills carries the same idea differently:
> platform-authored skills ship as SKILL.md **files** under
> `src/aiq_agent/skills/builtin/`, appear in every organization's toolbox, and
> an org adopts one by cloning it into an org row (`origin =
> 'platform-clone'`). The decision kept here is the shape of the answer —
> publish a catalog, let orgs opt in, never auto-provision running work into a
> tenant — not the table it was built on.

## Context

The Workflows tab (ADR-0023) shows a template gallery that pre-fills the
workflow builder. Those templates were **hardcoded** in
`frontends/ui/src/features/workflows/lib/templates.ts` plus the en/de i18n
dictionaries — shipping a new template meant a code change and a deploy, and
the gallery even carried a static "More coming" placeholder. The platform
owner asked for a **platform view to upload new workflows that become
available to every organization**, exactly analogous to the shared
base-knowledge corpus the owner already manages on `/app/platform`
(ADR-0016).

Two interpretations were possible: publish a template into every org's
gallery (opt-in adoption), or auto-provision a live, scheduled workflow into
every org. The latter is semantically awkward — workflows are project-scoped
(ADR-0023) and need a project + owner + budget context — so we chose the
gallery model, which extends the existing template mechanism rather than
inventing cross-tenant execution.

## Decision

1. **A global catalog table, `platform_workflow_templates`** (migration
   `0024`). Deliberately **not tenant-scoped** — no `organization_id` /
   `project_id`, no run state. A published row is visible to every org's
   gallery, the same way the base corpus is shared. Not a cross-tenant FK
   violation (ADR-0007) because there is no tenant reference at all: it is
   platform-owned content.

2. **Per-locale (de + en) author content.** Built-in templates are localized
   via dictionaries; a platform-authored template instead stores author text
   for both supported locales in a `content` JSONB
   (`{ de, en }`, each = name/description/category + the version-1 block
   definition). The gallery renders the viewer's active locale, falling back
   to the other. `data_sources` mirrors the `workflows` contract (null = all;
   otherwise the ADDITIONAL sources beyond the always-on knowledge layer).

3. **Platform-owner CRUD, mirroring the base-knowledge manager.** Routes
   under `/api/platform/workflow-templates` (`requirePlatformOwner`, ADR-0016)
   — list (drafts included), create, patch (the publish toggle is a
   `published` PATCH), delete. A `published` flag gates gallery visibility, so
   the owner drafts privately and publishes deliberately. These routes are
   **not** behind the per-org workflows feature flag: authoring the shared
   catalog is a platform capability independent of any tenant's rollout.

4. **Authoring by form *and* JSON file.** The `/app/platform` manager card
   offers a DE/EN builder form (with a live compiled-brief preview per locale)
   and a drag-and-drop JSON **import** that pre-fills that form, plus a
   per-template JSON **export**. The create schema is the interchange schema
   (unknown envelope keys are stripped), so an export re-imports losslessly.
   Import always lands as a draft.

5. **Gallery merge, opt-in.** A session-authenticated, feature-gated org read
   (`GET /api/workflow-templates`) returns the published, PII-free, both-locale
   projection. The gallery merges it after the built-in templates; selecting a
   platform template pre-fills the builder identically (it never auto-creates
   or runs). The read is global content, identical across tenants. A fetch
   failure leaves the built-in gallery intact — the shared catalog is additive
   and must never block the always-available defaults.

## Consequences

### Positive

- New templates ship as **content, not code** — the owner publishes from the
  platform UI, no deploy.
- Export/import moves templates between environments and backs them up.
- Reuses the platform-owner tier, the builder's compiler/preview, and the
  data-source + schedule primitives — minimal new surface, consistent UX.

### Negative / Risks

- Platform templates are **not** dictionary-localized: the owner must author
  both locales (enforced — both are required). A third locale would need a
  schema change.
- Gallery content is global and cached per deployment; there is no per-org
  curation of *which* published templates an org sees (all-or-nothing per
  template). Per-org targeting is a future extension.
- The catalog has no soft-delete: a delete removes the template from every
  gallery immediately (workflows already adopted from it are unaffected —
  adoption copies the definition).

## Alternatives considered

- **Auto-provision live workflows into every org**: rejected — workflows are
  project-scoped and need an owner/budget; cross-tenant scheduled execution
  raises admission, cost, and ownership questions the gallery model avoids.
- **Keep templates in code/dictionaries**: rejected — the whole point is to
  let a non-engineer owner publish without a deploy.
- **A tenant-scoped copy per org**: rejected — mass duplication, no single
  source of truth, and contradicts the shared-catalog intent.
