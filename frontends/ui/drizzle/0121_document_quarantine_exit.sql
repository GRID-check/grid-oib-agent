-- 0121: a quarantined document leaves quarantine through a release, and through
-- no other write (ADR-0085, amended 2026-10-08).
--
-- Three repair rounds found writers that moved a `quarantined` row on as if it
-- were an ordinary upload: a re-dispatch set it `pending` (`setDocumentIngestJob`),
-- and the next reader took the pending row for a file in flight. The
-- repository's status writers now carry `status <> 'quarantined'`; this trigger
-- is the layer that holds for the writer nobody has written yet.
--
-- The one way out is a reviewer's release of the exact bytes they saw
-- (`markScreeningReleased`): status `uploaded`, verdict `released`, and a
-- released hash equal to the row's content hash. A delete is not an UPDATE and
-- is not touched. A re-screen produces a new verdict through a release and the
-- dispatch after it, never a reset.
CREATE OR REPLACE FUNCTION grid_documents_hold_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'uploaded'
     AND NEW.screening_outcome = 'released'
     AND NEW.screening_released_hash IS NOT NULL
     AND NEW.screening_released_hash = NEW.content_hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document % is quarantined: only a release takes it out of quarantine (ADR-0085)', OLD.id
    USING ERRCODE = 'GQH01';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_hold_quarantine" ON "documents";
--> statement-breakpoint
CREATE TRIGGER "documents_hold_quarantine"
  BEFORE UPDATE ON "documents"
  FOR EACH ROW
  WHEN (OLD.status = 'quarantined' AND NEW.status IS DISTINCT FROM 'quarantined')
  EXECUTE FUNCTION grid_documents_hold_quarantine();
