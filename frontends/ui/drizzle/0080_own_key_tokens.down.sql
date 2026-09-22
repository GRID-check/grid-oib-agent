-- Down for 0080. Token-unit policies cannot be expressed before 0080, so they
-- are superseded rather than converted; the ledger un-pricing of BYOK rows is
-- not reversed (0079's boot-floor backfill can be re-run by hand if wanted).
UPDATE "budget_policies" SET "status" = 'superseded' WHERE "currency" = 'token' AND "status" = 'active';
ALTER TABLE "budget_policies" DROP CONSTRAINT IF EXISTS "budget_policies_currency_check";
ALTER TABLE "budget_policies"
  ADD CONSTRAINT "budget_policies_currency_check" CHECK ("currency" = 'credit');
ALTER TABLE "llm_usage_rollups"
  DROP COLUMN IF EXISTS "tokens",
  DROP COLUMN IF EXISTS "own_key_cost_usd";
