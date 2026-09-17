-- Reverse 0074: a collection may hold two live documents under one name again.
--
-- Dropping a unique index deletes no data and changes no row, so there is no
-- guard. What it means is that the replace-on-re-upload path is protected only
-- by its probe again, and two concurrent first uploads of one filename can once
-- more produce the ghost the index exists to stop. The probe stays in the
-- application either way, so re-applying 0074 needs no code change.

DROP INDEX IF EXISTS "uniq_documents_live_name_per_collection";
