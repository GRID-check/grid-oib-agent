-- Give `messages` and `conversation_reads` their own tenant column, so their
-- policies stop resolving tenancy through a subquery (ADR-0041).
--
-- ## Why
--
-- 0030 secured these two through their parent conversation, because the parent
-- holds the truth and a denormalised copy can silently disagree with it. The
-- reasoning was sound; the cost was not measured, and it is severe.
--
-- A policy's `EXISTS` is expanded AFTER sublink pull-up, so it can never become
-- a semi-join — the shape 0030's comment claimed. It becomes a hashed SubPlan
-- for a small tenant and a PER-ROW correlated SubPlan for a large one. Measured
-- on 395k messages: loading 1000 rows for a tenant with 100k conversations ran
-- 6.7x slower than the same query as the RLS-exempt owner and touched 104x the
-- buffers (7 075 vs 68). The cost scales with the TENANT's conversation count
-- rather than with the page requested, which makes it an unbounded hazard on
-- the hottest read in the product rather than a fixed tax.
--
-- With the column: 4.01 ms -> 0.70 ms, buffers 7 075 -> 55. Within 0.2 ms of
-- the owner baseline.
--
-- ## Why the copy cannot drift
--
-- The objection to denormalising was a second source of truth. That objection
-- is answered here by the database rather than by discipline: the composite
-- foreign key below makes `(conversation_id, organization_id)` reference
-- `conversations (id, organization_id)`, so Postgres REFUSES a message whose
-- organization disagrees with its conversation's. The copy cannot diverge, and
-- re-parenting a message across tenants is rejected for the same reason.
--
-- The column also defaults from the tenant context, so no application code has
-- to remember to set it, and `WITH CHECK` still verifies whatever is set.
--
-- ## Locks — read before deploying this online
--
-- Everything below runs in ONE transaction, and on `messages` that is not free:
-- `SET NOT NULL` scans the table under ACCESS EXCLUSIVE, and the composite
-- `ADD CONSTRAINT ... FOREIGN KEY` takes SHARE ROW EXCLUSIVE on both `messages`
-- and `conversations` while it validates every row. Writes to both tables block
-- for the duration. At the measured 395k messages that is a maintenance-window
-- change, which is how it is intended to ship.
--
-- If it ever has to run against a live system, split it: add the foreign keys
-- `NOT VALID`, then `VALIDATE CONSTRAINT` in a separate transaction (that takes
-- only SHARE UPDATE EXCLUSIVE and does not block writes). The backfill `UPDATE`
-- would want batching at that point too. Not done here because the window
-- exists and a one-transaction migration is the one that cannot half-apply.

-- ---------------------------------------------------------------------------
-- conversations: the target the composite key references
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  ADD CONSTRAINT conversations_id_organization_id_key UNIQUE (id, organization_id);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN organization_id text;

UPDATE messages m
   SET organization_id = c.organization_id
  FROM conversations c
 WHERE c.id = m.conversation_id
   AND m.organization_id IS NULL;

-- Any row whose conversation vanished cannot be attributed and cannot be
-- reached by anyone; the FK below would reject it anyway.
DELETE FROM messages m
 WHERE m.organization_id IS NULL;

ALTER TABLE messages ALTER COLUMN organization_id SET NOT NULL;

-- Populated from the caller's tenant context, so inserts need no application
-- change and cannot forget it. A platform-scoped insert has no context and will
-- fail the NOT NULL loudly, which is the correct outcome: a message belongs to
-- exactly one tenant.
ALTER TABLE messages
  ALTER COLUMN organization_id SET DEFAULT nullif(current_setting('grid.organization_id', true), '');

-- Replace the single-column FK with the composite one. It still cascades, and
-- it additionally makes the tenant column unable to disagree with the parent.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conversation_id_conversations_id_fk;
ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_id_organization_id_fkey
  FOREIGN KEY (conversation_id, organization_id)
  REFERENCES conversations (id, organization_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- conversation_reads — same shape, same reasoning
-- ---------------------------------------------------------------------------
ALTER TABLE conversation_reads ADD COLUMN organization_id text;

UPDATE conversation_reads r
   SET organization_id = c.organization_id
  FROM conversations c
 WHERE c.id = r.conversation_id
   AND r.organization_id IS NULL;

DELETE FROM conversation_reads r
 WHERE r.organization_id IS NULL;

ALTER TABLE conversation_reads ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE conversation_reads
  ALTER COLUMN organization_id SET DEFAULT nullif(current_setting('grid.organization_id', true), '');

ALTER TABLE conversation_reads DROP CONSTRAINT IF EXISTS conversation_reads_conversation_id_conversations_id_fk;
ALTER TABLE conversation_reads
  ADD CONSTRAINT conversation_reads_conversation_id_organization_id_fkey
  FOREIGN KEY (conversation_id, organization_id)
  REFERENCES conversations (id, organization_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- The policies become the same one-line rule as every other tenant table
-- ---------------------------------------------------------------------------
SELECT grid_secure_table('messages', 'organization_id = grid_current_org()');
SELECT grid_secure_table('conversation_reads', 'organization_id = grid_current_org()');
