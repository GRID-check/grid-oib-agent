-- Reverse 0095: chat erasures stop being retried by the purger.
--
-- ORDER: roll the purger and the frontend back to the previous image BEFORE
-- running this. A previous purger has no handler for 'conversation' and marks
-- any such row it claims `failed` for good.
--
-- Only the rows still waiting go: the chats they name stay marked deleting, as
-- they were before 0095. `purged` and `failed` rows are the record of what was
-- erased, or what could not be, and stay.

DELETE FROM "deletion_queue"
WHERE "entity_type" = 'conversation'
  AND "status" IN ('pending', 'purging');
