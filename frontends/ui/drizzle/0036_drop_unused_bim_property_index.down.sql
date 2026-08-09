CREATE INDEX IF NOT EXISTS bim_elements_properties_idx
  ON bim_elements USING gin (properties jsonb_path_ops);
