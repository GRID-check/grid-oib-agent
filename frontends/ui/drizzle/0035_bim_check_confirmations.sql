-- Manual confirmations for the OIB rule catalogue (`lib/bim/rules.ts`).
--
-- The catalogue decides what the model's published values can decide. The rest
-- an architect decides — by reading a plan, by asking a Brandschutzplaner, by
-- knowing that `F 90` is load-bearing 90 minutes even though the checker
-- refused to score it. Without somewhere to put that judgement the Prüfbuch is
-- a list of open questions forever, and the one artefact it exists to produce —
-- a statement somebody signs — cannot be assembled.
--
-- A confirmation is recorded AGAINST A MODEL REVISION, not against a project.
-- That is the whole point of storing `model_id`: when a newer revision arrives
-- the confirmation is still there but is visibly stale, because "I checked
-- this" was true of the building the person looked at and says nothing about
-- the one that replaced it. Silently carrying it forward would let a signature
-- outlive the drawing it was made about.
--
-- One row per (organization, project, rule): a rule has exactly one current
-- human verdict, and re-confirming against a newer revision updates it in place
-- rather than growing a history nobody reads.

CREATE TABLE bim_check_confirmations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   text        NOT NULL,
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Rule id from the catalogue, e.g. `oib2-feuerwiderstand-tragend`. Not a
  -- foreign key: the catalogue is code, and a rule that is renamed or retired
  -- must not take a signed confirmation down with it — the row survives and
  -- stops matching, which is visible, rather than vanishing, which is not.
  rule_id           text        NOT NULL,
  -- The revision the person actually looked at.
  model_id          uuid        NOT NULL REFERENCES bim_models(id) ON DELETE CASCADE,
  confirmed_by      text        NOT NULL,
  -- Why they are confident. Free text, shown verbatim beside the verdict.
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bim_check_confirmations_unique UNIQUE (organization_id, project_id, rule_id)
);

CREATE INDEX bim_check_confirmations_project_idx
  ON bim_check_confirmations (organization_id, project_id);

-- ---------------------------------------------------------------------------
-- Inside the tenant boundary (see 0031_row_level_security.sql)
-- ---------------------------------------------------------------------------
SELECT grid_secure_table('bim_check_confirmations',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
