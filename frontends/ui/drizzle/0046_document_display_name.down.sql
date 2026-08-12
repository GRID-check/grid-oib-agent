-- Drops every rename anyone has made: the documents go back to being shown
-- under their file names. Nothing else depends on the column — `filename` was
-- always the identity, so no join, no key and no stored object moves.
--
-- The backend's own `display_title` values are NOT cleared here. They live in
-- the Python metadata store, which this migration cannot reach, and clearing
-- them would need a second, cross-service step; leaving them means a rolled-back
-- deployment shows the file name in the file list and the renamed title on the
-- citation chip until somebody renames again.

ALTER TABLE "documents" DROP COLUMN IF EXISTS "display_name";
