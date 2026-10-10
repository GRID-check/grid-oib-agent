-- Reverse 0118. ORDER: roll the frontend back first; the newer build writes
-- `document_quarantine_decisions` with every quarantine and its sweep reads it.
--
-- Lossy: a decision not yet audited is dropped with its row, and the older
-- build emits `document.quarantined` at most once again. Every audited one is
-- in the audit trail already.
DROP TRIGGER IF EXISTS "document_quarantine_decisions_guard" ON "document_quarantine_decisions";
DROP FUNCTION IF EXISTS grid_document_quarantine_decisions_guard();
DROP TABLE IF EXISTS "document_quarantine_decisions";
