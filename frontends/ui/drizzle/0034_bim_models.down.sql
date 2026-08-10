-- Reverse 0034.
--
-- DESTRUCTIVE, but recoverable: every row here is derived from an uploaded IFC
-- file that still exists in object storage, so dropping the tables loses the
-- extraction, not the source. Re-uploading (or re-running extraction) rebuilds
-- it. Nothing else in the schema references these tables, so the drop is a leaf
-- operation — `documents` keeps its rows and its bytes.
--
-- `bim_elements` first: it holds the foreign key, and dropping the parent while
-- the child exists would need CASCADE, which is a blunter instrument than this
-- needs.

DROP TABLE IF EXISTS bim_elements;
DROP TABLE IF EXISTS bim_models;
