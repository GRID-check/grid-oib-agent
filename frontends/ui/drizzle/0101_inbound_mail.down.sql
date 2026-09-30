-- Reverse 0101: drop the project mail inbox tables.
--
-- Lossy only in bookkeeping and in mail not yet filed: the files the inbox
-- filed are ordinary documents and stay where they are. What goes is every
-- project's address (members must be given a new one after re-applying), the
-- idempotency record (a mail redelivered after the rollback is filed again),
-- and every delivery still `queued`. Their staged attachments stay in object
-- storage under `org/<org>/project/<project>/inbound-mail/`, named by no row;
-- the project purge's prefix sweep takes them with the project.
--
-- The inbox rows that announced filed or failed mail go too: they quote the
-- mail's subject, and an older BFF has no presentation for the types.

DELETE FROM "inbox_items" WHERE "type" IN ('inbound_mail.filed', 'inbound_mail.failed');
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_messages";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_addresses";
