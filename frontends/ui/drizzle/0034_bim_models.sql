-- BIM models: what an uploaded `.ifc` document turned out to contain.
--
-- ## Two tables, because they are read at two different rates
--
-- `bim_models` is read on every model page load and on every agent turn that
-- touches the model — it carries the summary (spatial tree, storeys, type
-- counts, totals), which is a few kilobytes and answers most questions without
-- touching an element at all.
--
-- `bim_elements` is read only when a question is about specific elements
-- ("which walls on the ground floor are load-bearing"). Splitting them keeps
-- the common path off a table that can hold hundreds of thousands of rows per
-- model.
--
-- ## Why the open-ended parts are jsonb and not columns
--
-- An IFC property set's keys are chosen by whichever application exported the
-- model. `Pset_WallCommon.FireRating` is standardised; `AllplanAttributes.Bauteil-ID`
-- is not, and both must be queryable. Columns cannot represent that, so
-- properties/quantities are jsonb with a GIN index — the same trade the
-- `documents.metadata` column already makes, but here the jsonb is the point
-- rather than an escape hatch.
--
-- ## Tenancy
--
-- `bim_models` carries `organization_id` and follows `documents`' predicate
-- exactly (org column plus the project cross-check, because `project_id` is
-- nullable for org-wide Archiv models).
--
-- `bim_elements` deliberately carries NO organization column: the parent
-- model's is the truth, and the policy joins it. A denormalised copy would be a
-- second source of the tenant that can disagree with the first — the same
-- reasoning 0031 applies to `project_folders`.

CREATE TABLE IF NOT EXISTS bim_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  schema_version text,
  index_storage_key text,
  index_storage_bucket text,
  summary jsonb,
  element_count integer NOT NULL DEFAULT 0,
  error_message text,
  extracted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- One model per document: the model is not a separate upload, it is what the
-- document IS. Enforced as a unique index so a retried extraction updates the
-- existing row instead of quietly creating a second, divergent one.
CREATE UNIQUE INDEX IF NOT EXISTS bim_models_document_idx ON bim_models (document_id);
CREATE INDEX IF NOT EXISTS bim_models_project_idx ON bim_models (project_id);
CREATE INDEX IF NOT EXISTS bim_models_org_status_idx ON bim_models (organization_id, status);

COMMENT ON TABLE bim_models IS
  'One parsed IFC model per uploaded .ifc document. summary holds the spatial tree and aggregates; index_storage_key points at the full JSON index in object storage.';

CREATE TABLE IF NOT EXISTS bim_elements (
  id bigserial PRIMARY KEY,
  model_id uuid NOT NULL REFERENCES bim_models(id) ON DELETE CASCADE,
  global_id text NOT NULL,
  express_id integer NOT NULL,
  ifc_type text NOT NULL,
  name text,
  predefined_type text,
  object_type text,
  tag text,
  type_name text,
  storey_global_id text,
  storey_name text,
  container_kind text,
  container_name text,
  materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  classifications jsonb NOT NULL DEFAULT '[]'::jsonb,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  quantities jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- express_id is unique within a file, so (model, express_id) is the natural key
-- and the one an upsert can conflict on when a model is re-extracted.
CREATE UNIQUE INDEX IF NOT EXISTS bim_elements_model_express_idx ON bim_elements (model_id, express_id);
CREATE INDEX IF NOT EXISTS bim_elements_model_type_idx ON bim_elements (model_id, ifc_type);
CREATE INDEX IF NOT EXISTS bim_elements_model_storey_idx ON bim_elements (model_id, storey_name);
CREATE INDEX IF NOT EXISTS bim_elements_global_id_idx ON bim_elements (model_id, global_id);

-- jsonb_path_ops rather than the default operator class: it indexes only the
-- containment operator `@>`, which is the only one the query layer uses, and is
-- roughly a third the size of the default GIN index on the same data.
CREATE INDEX IF NOT EXISTS bim_elements_properties_idx
  ON bim_elements USING gin (properties jsonb_path_ops);

COMMENT ON TABLE bim_elements IS
  'One element (wall, door, room, …) of one BIM model. Identifying attributes are columns; property sets and quantities are jsonb because their keys are chosen by the exporting application.';

-- ---------------------------------------------------------------------------
-- Inside the tenant boundary (see 0031_row_level_security.sql)
-- ---------------------------------------------------------------------------
SELECT grid_secure_table('bim_models',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
SELECT grid_secure_table('bim_elements',
  'EXISTS (SELECT 1 FROM bim_models m WHERE m.id = model_id AND m.organization_id = grid_current_org())');
