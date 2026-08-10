DROP INDEX IF EXISTS bim_elements_search_keys_idx;
ALTER TABLE bim_elements DROP COLUMN IF EXISTS search_keys;
ALTER TABLE bim_models DROP COLUMN IF EXISTS search_keys_indexed;
