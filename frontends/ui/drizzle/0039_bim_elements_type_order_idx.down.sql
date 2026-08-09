DROP INDEX IF EXISTS bim_elements_model_type_idx;

CREATE INDEX IF NOT EXISTS bim_elements_model_type_idx
  ON bim_elements (model_id, ifc_type);
