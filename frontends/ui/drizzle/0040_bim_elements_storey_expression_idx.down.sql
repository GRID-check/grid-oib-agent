DROP INDEX IF EXISTS bim_elements_model_storey_idx;

CREATE INDEX IF NOT EXISTS bim_elements_model_storey_idx
  ON bim_elements (model_id, storey_name);
