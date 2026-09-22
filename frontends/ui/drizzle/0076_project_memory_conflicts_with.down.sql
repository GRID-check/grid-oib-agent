-- Reverse 0076. Drops the record of which human note an agent finding was not
-- allowed to replace; both notes stay, as they did before the column existed.
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "conflicts_with_id";
