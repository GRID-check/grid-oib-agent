-- Reverse 0128: `everyone_reads` goes, and with it what this build stored only
-- there.
--
-- Lossy, and deliberately so. A folder 0128 turned back to `inherit` because
-- everyone wrote it stays `inherit`, which grants the same. The 1–20 grant
-- trigger is not restored: folders made custom since 0128 have no grant rows,
-- and the trigger would refuse the next write to them. An older build reads
-- such a folder as a list that matches nobody, so only organization admins
-- read it: the narrow direction. The folder roles in WorkOS are left alone.
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "everyone_reads";
