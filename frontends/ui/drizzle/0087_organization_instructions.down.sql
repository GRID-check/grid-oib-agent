-- Reverse 0087: drop the per-organization instruction block.
--
-- Lossy, and the loss is the whole table: every tenant's standing instructions
-- go with it, because nothing else in the schema records them. There is no
-- older place to put them back into — the jsonb bag never held this value (see
-- the forward migration for why it was rejected) — so a deployment that intends
-- to roll back and keep the text has to export it first:
--
--   COPY (SELECT organization_id, instructions FROM organization_instructions)
--     TO '/tmp/org_instructions.csv' CSV HEADER;
--
-- A BFF still on the newer release keeps working after this runs: the read
-- fails, the service treats a failed read as "no instructions", and the turn
-- goes out without the header.

DROP TABLE IF EXISTS "organization_instructions";
