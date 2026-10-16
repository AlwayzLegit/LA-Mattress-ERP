-- Owner 2026-10-16: register customer searches took 5-15 s on the
-- production database. A phone search compares digits to digits
-- (customers.controller list: regexp_replace(...) LIKE '%<digits>%'),
-- which scanned every customer row on every keystroke. Trigram indexes on
-- the same expressions let that LIKE use an index. The expressions must
-- stay identical to the query's for the planner to pick them up.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_phone_digits_trgm_idx" ON "customers"
  USING gin ((regexp_replace(COALESCE("phone", ''), '\D', '', 'g')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_phone2_digits_trgm_idx" ON "customers"
  USING gin ((regexp_replace(COALESCE("phone2", ''), '\D', '', 'g')) gin_trgm_ops);
