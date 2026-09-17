-- Reverse 0075. Drops the table and every task ever recorded: the lifecycle,
-- the review decisions and the filing ledger. The documents a task filed stay
-- (they are `documents` rows authored by the run), so nothing a person can
-- open disappears — only the record of who asked, who judged, and why.
DROP TABLE IF EXISTS "tasks";
