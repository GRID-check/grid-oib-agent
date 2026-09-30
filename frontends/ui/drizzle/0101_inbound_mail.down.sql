-- Reverse 0101: drop the project mail inbox tables.
--
-- Lossy only in bookkeeping: the rows hold no content, and the files the inbox
-- filed are ordinary documents that stay where they are. What goes is every
-- project's address (members must be given a new one after re-applying) and the
-- idempotency record, so a mail redelivered after the rollback is filed again.
--
-- The inbox rows that announced filed mail (`inbound_mail.filed`) go too: they
-- quote the mail's subject, and an older BFF has no presentation for the type.

DELETE FROM "inbox_items" WHERE "type" = 'inbound_mail.filed';
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_messages";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_addresses";
