# Remove deadline and output_format from setup wizard

## Goal

Remove the two setup-wizard questions that ask users for a deadline and a preferred output format, because they are unnecessary in the onboarding flow.

## Questions being removed

| id | label | previously wrote to |
|---|---|---|
| `deadline` | "When do you need answers?" | `/goals/deadline` |
| `output_format` | "How should Grid package its findings?" | `/facts/output_format/value` |

## Approach

**Complete removal (Option A).** The fields are not referenced by any backend, source, or config code, so the only place they live is the frontend intake definition and its tests.

## Changes

- `frontends/ui/src/lib/project-profile/intake-definition.ts`
  - Remove the `deadline` question from the `goal` stage.
  - Remove the `output_format` question from the `goal` stage.
- `frontends/ui/src/lib/project-profile/intake-definition.test.ts`
  - Remove `deadline` from test answer fixtures.
  - Remove assertions that reference `profile.goals.deadline` and `restored.deadline`.

## Out of scope

- No schema migration. Existing profiles that already contain these values are left untouched.
- No replacement UI. The remaining `goal` stage questions (`focus_areas`, `goal_details`) are unchanged.

## Verification

- `npm run lint` passes in `frontends/ui`.
- `npm run test:ci` passes for the modified test file.

## Risks / notes

- A research note in `docs/superpowers/research/2026-07-03-feature-opportunities.md` mentions `output_format` as a future deep-research hook. That is documentation only; removing the intake question does not break any implemented feature.
