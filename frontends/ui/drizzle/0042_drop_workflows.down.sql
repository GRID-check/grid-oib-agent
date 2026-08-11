-- Deliberately empty of table definitions.
--
-- The forward migration removes a feature, not a column: recreating these three
-- tables would produce empty shells with no code to read or write them, which
-- is a worse state than not having them. Rolling 0042 back therefore restores
-- nothing — recovering Workflows means reverting the application code that was
-- deleted alongside it, and 0017/0024 are still in the journal to recreate the
-- schema if that ever happens.
SELECT 1;
