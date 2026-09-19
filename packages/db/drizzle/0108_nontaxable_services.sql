-- Custom SQL migration file, put your code below! --

-- Installation and the other STORIS "NONINV" service items are sold as
-- catalog products, so the register taxed them like merchandise. Owner
-- 2026-09-19: installation is never taxed. Per tenant that carries such
-- products: ensure a 0% tax class "Non-taxable services" and put every
-- product under the "Delivery & Installation" / "Services & Fees"
-- categories (the 2026-09-11 categorisation of CATG NONINV) plus any
-- product whose name says install/installation on it. Idempotent: an
-- existing class of that name is reused; a product already on a 0% class
-- is left alone. Same shape as 0104 (a per-tenant backfill).
-- backfill:start
INSERT INTO tax_classes (business_id, name, description, rate_bps, is_default)
SELECT DISTINCT p.business_id,
       'Non-taxable services',
       'Installation, removal, cleaning and other services (never taxed).',
       0,
       false
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
WHERE (
    c.name IN ('Delivery & Installation', 'Services & Fees')
    OR pc.name IN ('Delivery & Installation', 'Services & Fees')
    OR p.name ~* '\minstall'
  )
  AND NOT EXISTS (
    SELECT 1 FROM tax_classes t
    WHERE t.business_id = p.business_id AND t.name = 'Non-taxable services'
  );
--> statement-breakpoint
UPDATE products p
SET tax_class_id = t.id,
    updated_at = now()
FROM tax_classes t
WHERE t.business_id = p.business_id
  AND t.name = 'Non-taxable services'
  AND (
    p.tax_class_id IS NULL
    OR p.tax_class_id IN (SELECT x.id FROM tax_classes x WHERE x.rate_bps <> 0)
  )
  AND (
    p.name ~* '\minstall'
    OR p.category_id IN (
      SELECT c.id FROM categories c
      LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE c.business_id = p.business_id
        AND (c.name IN ('Delivery & Installation', 'Services & Fees')
             OR pc.name IN ('Delivery & Installation', 'Services & Fees'))
    )
  );
-- backfill:end
