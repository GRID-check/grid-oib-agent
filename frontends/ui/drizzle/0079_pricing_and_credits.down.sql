-- Down for 0079. Returns the ledger to cost-only and budget limits to EUR at
-- the boot floor and the old default rate. Prices frozen by a real pricing version are lost with the
-- table — they can be re-derived from cost_usd and the audit trail, but not
-- exactly, which is the whole reason the up-migration stores them.
ALTER TABLE "budget_policies" DROP CONSTRAINT IF EXISTS "budget_policies_currency_check";
ALTER TABLE "budget_policies" ALTER COLUMN "currency" SET DEFAULT 'EUR';
UPDATE "budget_policies"
  SET "daily_limit" = round("daily_limit" * 0.86 / 100, 4),
      "monthly_limit" = round("monthly_limit" * 0.86 / 100, 4),
      "currency" = 'EUR'
  WHERE "currency" = 'credit';
ALTER TABLE "llm_usage_rollups" DROP COLUMN IF EXISTS "price_usd", DROP COLUMN IF EXISTS "credits";
ALTER TABLE "llm_usage_events"
  DROP COLUMN IF EXISTS "price_usd",
  DROP COLUMN IF EXISTS "credits",
  DROP COLUMN IF EXISTS "pricing_version_id";
DROP TABLE IF EXISTS "platform_pricing_versions";
