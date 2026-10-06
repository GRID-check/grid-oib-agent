-- Reverse 0112. ORDER: roll the frontend back first; the newer build writes
-- `document_access_log` in every download request and reads it on the admin page.
--
-- Lossy by nature: the download log is dropped with its rows. There is nothing
-- to map them back to; an older build never knew them. If the records matter,
-- export them before rolling back (the admin page lists them, newest first).
DROP TRIGGER IF EXISTS "document_access_log_guard" ON "document_access_log";
DROP FUNCTION IF EXISTS grid_document_access_log_guard();
DROP TABLE IF EXISTS "document_access_log";
