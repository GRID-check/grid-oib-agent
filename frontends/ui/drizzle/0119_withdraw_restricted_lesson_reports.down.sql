-- Reverse 0118: nothing to undo.
--
-- 0118 changed rows, not the schema. The summaries it cleared and the lesson
-- texts it replaced were not kept anywhere, so they cannot come back, and an
-- older build reads the retired lessons and the reports without their summary
-- as it reads any other. A platform owner can reactivate a retired lesson in
-- Platform -> Lessons; its text stays the withdrawal note.
SELECT 1;
