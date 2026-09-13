ALTER TABLE "product_variants" ADD COLUMN "size" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "firmness" text;--> statement-breakpoint
CREATE INDEX "product_variants_size_idx" ON "product_variants" USING btree ("business_id","size");
--> statement-breakpoint
-- A22.2 (hand-appended): fill size / firmness for every variant from what
-- the catalog already knows — the variant's own attributes first, then
-- the STORIS group code (QUEEN, QUFND, CKPRO, TXLSHE…), then the product +
-- variant name. Mirrors normalizeSize / sizeFromGroupCode / sizeFromText /
-- firmnessFromText in @jetnine/shared (catalog.ts); the categorize spec
-- checks the two agree over the whole STORIS catalog. A name naming
-- several sizes ("T/F/Q/K/CK", "QUEEN/FULL") gets none.
-- backfill:start
WITH aliases(key, size) AS (
  VALUES
    ('TWIN', 'Twin'),
    ('TW', 'Twin'),
    ('TN', 'Twin'),
    ('TWINXL', 'Twin XL'),
    ('TXL', 'Twin XL'),
    ('TWXL', 'Twin XL'),
    ('TWLXL', 'Twin XL'),
    ('XL', 'Twin XL'),
    ('TWINEXTRALONG', 'Twin XL'),
    ('FULL', 'Full'),
    ('FL', 'Full'),
    ('FU', 'Full'),
    ('DBL', 'Full'),
    ('DOUBLE', 'Full'),
    ('FULLXL', 'Full XL'),
    ('FXL', 'Full XL'),
    ('FULLEXTRALONG', 'Full XL'),
    ('QUEEN', 'Queen'),
    ('QU', 'Queen'),
    ('QN', 'Queen'),
    ('OLYMPICQUEEN', 'Olympic Queen'),
    ('OLYMPICQU', 'Olympic Queen'),
    ('OQ', 'Olympic Queen'),
    ('KING', 'King'),
    ('EK', 'King'),
    ('EKING', 'King'),
    ('EASTERNKING', 'King'),
    ('STANDARDKING', 'King'),
    ('CAKING', 'Cal King'),
    ('CALKING', 'Cal King'),
    ('CALIFORNIAKING', 'Cal King'),
    ('CKING', 'Cal King'),
    ('CK', 'Cal King'),
    ('CALK', 'Cal King'),
    ('CAK', 'Cal King'),
    ('WESTERNKING', 'Cal King'),
    ('SPLITQUEEN', 'Split Queen'),
    ('SPLQUE', 'Split Queen'),
    ('SPLITQU', 'Split Queen'),
    ('SPQ', 'Split Queen'),
    ('SQ', 'Split Queen'),
    ('SPLITKING', 'Split King'),
    ('SPKING', 'Split King'),
    ('SPK', 'Split King'),
    ('SK', 'Split King'),
    ('SPLITEKING', 'Split King'),
    ('SPLITEASTERNKING', 'Split King'),
    ('SPLITCALKING', 'Split Cal King'),
    ('SPLITCAKING', 'Split Cal King'),
    ('SPLITCALIFORNIAKING', 'Split Cal King'),
    ('SPLITCK', 'Split Cal King'),
    ('SPLCAK', 'Split Cal King'),
    ('SCAK', 'Split Cal King'),
    ('SCK', 'Split Cal King'),
    ('SPCK', 'Split Cal King'),
    ('SPCAKING', 'Split Cal King'),
    ('CUSTOM', 'Custom')
),
src AS (
  SELECT v.id,
    coalesce(p.name, '') || ' ' || coalesce(v.name, '') AS hay,
    upper(regexp_replace(coalesce(v.attributes_json->>'size', ''), '[^A-Za-z0-9]', '', 'g')) AS attr_size_key,
    upper(regexp_replace(coalesce(v.attributes_json->>'group', ''), '[^A-Za-z0-9]', '', 'g')) AS group_key,
    coalesce(v.attributes_json->>'firmness', '') AS attr_firmness
  FROM product_variants v
  JOIN products p ON p.id = v.product_id
  WHERE v.size IS NULL OR v.firmness IS NULL
),
derived AS (
  SELECT s.id,
    coalesce(
      (SELECT a.size FROM aliases a WHERE a.key = s.attr_size_key),
      (SELECT a.size FROM aliases a WHERE a.key = s.group_key),
      (SELECT a.size FROM aliases a
        WHERE s.group_key ~ '(PCAS|SHEE|SHE|FND|ADJ|PRO|MATT)$'
          AND a.key = regexp_replace(s.group_key, '(PCAS|SHEE|SHE|FND|ADJ|PRO|MATT)$', '')),
      CASE
        WHEN (hay ~* '\m(TWIN|TW|TN|TWINXL|TXL|TWXL|TWLXL|XL|TWINEXTRALONG|FULL|FL|FU|DBL|DOUBLE|FULLXL|FXL|FULLEXTRALONG|QUEEN|QU|QN|OLYMPICQUEEN|OLYMPICQU|OQ|KING|EK|EKING|EASTERNKING|STANDARDKING|CAKING|CALKING|CALIFORNIAKING|CKING|CK|CALK|CAK|WESTERNKING|SPLITQUEEN|SPLQUE|SPLITQU|SPQ|SQ|SPLITKING|SPKING|SPK|SK|SPLITEKING|SPLITEASTERNKING|SPLITCALKING|SPLITCAKING|SPLITCALIFORNIAKING|SPLITCK|SPLCAK|SCAK|SCK|SPCK|SPCAKING|CUSTOM|T|F|Q|K|C|E)([/-](TWIN|TW|TN|TWINXL|TXL|TWXL|TWLXL|XL|TWINEXTRALONG|FULL|FL|FU|DBL|DOUBLE|FULLXL|FXL|FULLEXTRALONG|QUEEN|QU|QN|OLYMPICQUEEN|OLYMPICQU|OQ|KING|EK|EKING|EASTERNKING|STANDARDKING|CAKING|CALKING|CALIFORNIAKING|CKING|CK|CALK|CAK|WESTERNKING|SPLITQUEEN|SPLQUE|SPLITQU|SPQ|SQ|SPLITKING|SPKING|SPK|SK|SPLITEKING|SPLITEASTERNKING|SPLITCALKING|SPLITCAKING|SPLITCALIFORNIAKING|SPLITCK|SPLCAK|SCAK|SCK|SPCK|SPCAKING|CUSTOM|T|F|Q|K|C|E)){2,}\M'
              OR hay ~* '\m((TWIN|TW|TN|TWINXL|TXL|TWXL|TWLXL|XL|TWINEXTRALONG|FULL|FL|FU|DBL|DOUBLE|FULLXL|FXL|FULLEXTRALONG|QUEEN|QU|QN|OLYMPICQUEEN|OLYMPICQU|OQ|KING|EK|EKING|EASTERNKING|STANDARDKING|CAKING|CALKING|CALIFORNIAKING|CKING|CK|CALK|CAK|WESTERNKING|SPLITQUEEN|SPLQUE|SPLITQU|SPQ|SQ|SPLITKING|SPKING|SPK|SK|SPLITEKING|SPLITEASTERNKING|SPLITCALKING|SPLITCAKING|SPLITCALIFORNIAKING|SPLITCK|SPLCAK|SCAK|SCK|SPCK|SPCAKING|CUSTOM)[/-](TWIN|TW|TN|TWINXL|TXL|TWXL|TWLXL|XL|TWINEXTRALONG|FULL|FL|FU|DBL|DOUBLE|FULLXL|FXL|FULLEXTRALONG|QUEEN|QU|QN|OLYMPICQUEEN|OLYMPICQU|OQ|KING|EK|EKING|EASTERNKING|STANDARDKING|CAKING|CALKING|CALIFORNIAKING|CKING|CK|CALK|CAK|WESTERNKING|SPLITQUEEN|SPLQUE|SPLITQU|SPQ|SQ|SPLITKING|SPKING|SPK|SK|SPLITEKING|SPLITEASTERNKING|SPLITCALKING|SPLITCAKING|SPLITCALIFORNIAKING|SPLITCK|SPLCAK|SCAK|SCK|SPCK|SPCAKING|CUSTOM|T|F|Q|K|C|E)|(TWIN|TW|TN|TWINXL|TXL|TWXL|TWLXL|XL|TWINEXTRALONG|FULL|FL|FU|DBL|DOUBLE|FULLXL|FXL|FULLEXTRALONG|QUEEN|QU|QN|OLYMPICQUEEN|OLYMPICQU|OQ|KING|EK|EKING|EASTERNKING|STANDARDKING|CAKING|CALKING|CALIFORNIAKING|CKING|CK|CALK|CAK|WESTERNKING|SPLITQUEEN|SPLQUE|SPLITQU|SPQ|SQ|SPLITKING|SPKING|SPK|SK|SPLITEKING|SPLITEASTERNKING|SPLITCALKING|SPLITCAKING|SPLITCALIFORNIAKING|SPLITCK|SPLCAK|SCAK|SCK|SPCK|SPCAKING|CUSTOM|T|F|Q|K|C|E)[/-](TWIN|TW|TN|TWINXL|TXL|TWXL|TWLXL|XL|TWINEXTRALONG|FULL|FL|FU|DBL|DOUBLE|FULLXL|FXL|FULLEXTRALONG|QUEEN|QU|QN|OLYMPICQUEEN|OLYMPICQU|OQ|KING|EK|EKING|EASTERNKING|STANDARDKING|CAKING|CALKING|CALIFORNIAKING|CKING|CK|CALK|CAK|WESTERNKING|SPLITQUEEN|SPLQUE|SPLITQU|SPQ|SQ|SPLITKING|SPKING|SPK|SK|SPLITEKING|SPLITEASTERNKING|SPLITCALKING|SPLITCAKING|SPLITCALIFORNIAKING|SPLITCK|SPLCAK|SCAK|SCK|SPCK|SPCAKING|CUSTOM))\M')
             AND NOT hay ~* '\m((f|t|tw|twin|full)-x-?l|e-king|ca-king|cal-king)\M' THEN NULL
        WHEN ((hay ~* '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M')::int + (regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi') ~* '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M')::int + (regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi') ~* '\m(split[\s-]*qu(een)?\.?|splque|spq)\M')::int + (regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi') ~* '\m(olympic[\s-]*qu(een)?\.?)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi') ~* '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi') ~* '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi') ~* '\m(queen|qn|qu)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi') ~* '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi'), '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M', ' ', 'gi') ~* '\m(full[\s-]*x-?l|f-?xl|full[\s-]*extra[\s-]*long)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi'), '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M', ' ', 'gi'), '\m(full[\s-]*x-?l|f-?xl|full[\s-]*extra[\s-]*long)\M', ' ', 'gi') ~* '\m(twin)\M')::int + (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi'), '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M', ' ', 'gi'), '\m(full[\s-]*x-?l|f-?xl|full[\s-]*extra[\s-]*long)\M', ' ', 'gi'), '\m(twin)\M', ' ', 'gi') ~* '\m(full|double)\M')::int) = 1 THEN
          CASE
        WHEN (hay ~* '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M') THEN 'Split Cal King'
        WHEN (regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi') ~* '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M') THEN 'Split King'
        WHEN (regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi') ~* '\m(split[\s-]*qu(een)?\.?|splque|spq)\M') THEN 'Split Queen'
        WHEN (regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi') ~* '\m(olympic[\s-]*qu(een)?\.?)\M') THEN 'Olympic Queen'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi') ~* '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M') THEN 'Cal King'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi') ~* '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M') THEN 'King'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi') ~* '\m(queen|qn|qu)\M') THEN 'Queen'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi') ~* '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M') THEN 'Twin XL'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi'), '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M', ' ', 'gi') ~* '\m(full[\s-]*x-?l|f-?xl|full[\s-]*extra[\s-]*long)\M') THEN 'Full XL'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi'), '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M', ' ', 'gi'), '\m(full[\s-]*x-?l|f-?xl|full[\s-]*extra[\s-]*long)\M', ' ', 'gi') ~* '\m(twin)\M') THEN 'Twin'
        WHEN (regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(hay, '\m(split[\s-]*cal(ifornia)?\.?[\s-]*king|split[\s-]*ca[\s-]*king|splitck|spl[\s-]*cak|scak|sck)\M', ' ', 'gi'), '\m(split[\s-]*(e[\s-]*|eastern[\s-]*)?king|sp[\s-]*king|spk)\M', ' ', 'gi'), '\m(split[\s-]*qu(een)?\.?|splque|spq)\M', ' ', 'gi'), '\m(olympic[\s-]*qu(een)?\.?)\M', ' ', 'gi'), '\m(cal(ifornia)?\.?[\s-]*king|ca[\s-]*king|caking|cking|ck)\M', ' ', 'gi'), '\m((e|eastern|east)[\s-]*king|eking|ek|king)\M', ' ', 'gi'), '\m(queen|qn|qu)\M', ' ', 'gi'), '\m(twin[\s-]*x-?l|txl|twin[\s-]*extra[\s-]*long)\M', ' ', 'gi'), '\m(full[\s-]*x-?l|f-?xl|full[\s-]*extra[\s-]*long)\M', ' ', 'gi'), '\m(twin)\M', ' ', 'gi') ~* '\m(full|double)\M') THEN 'Full'
        ELSE NULL END
        ELSE NULL END
    ) AS size_val,
    coalesce(
      CASE lower(regexp_replace(btrim(s.attr_firmness), '[\s_-]+', ' ', 'g'))
        WHEN 'plush' THEN 'Plush' WHEN 'medium' THEN 'Medium' WHEN 'medium firm' THEN 'Medium Firm'
        WHEN 'firm' THEN 'Firm' WHEN 'extra firm' THEN 'Extra Firm' ELSE NULL END,
      (SELECT CASE
      WHEN s.attr_firmness ~* '\m((extra|ultra|x)[\s-]*firm|xfirm|xf|(ultra|ultr)[\s-]*fm|x-?firm)\M' THEN 'Extra Firm'
      WHEN s.attr_firmness ~* '\m((medium|med\.?|luxury|lux|cushion|plush)[\s-]*firm|lux[\s-]*fm|med[\s-]*fm)\M' THEN 'Medium Firm'
      WHEN s.attr_firmness ~* '\m(firm|fm)\M' THEN 'Firm'
      WHEN s.attr_firmness ~* '\m((medium|med\.?)[\s-]*(soft|plush)|ultra[\s-]*plush|plush|soft)\M' THEN 'Plush'
      WHEN s.attr_firmness ~* '\m(medium|med\.?)\M' THEN 'Medium'
      ELSE NULL END WHERE s.attr_firmness <> ''),
      CASE
      WHEN hay ~* '\m((extra|ultra|x)[\s-]*firm|xfirm|xf|(ultra|ultr)[\s-]*fm|x-?firm)\M' THEN 'Extra Firm'
      WHEN hay ~* '\m((medium|med\.?|luxury|lux|cushion|plush)[\s-]*firm|lux[\s-]*fm|med[\s-]*fm)\M' THEN 'Medium Firm'
      WHEN hay ~* '\m(firm|fm)\M' THEN 'Firm'
      WHEN hay ~* '\m((medium|med\.?)[\s-]*(soft|plush)|ultra[\s-]*plush|plush|soft)\M' THEN 'Plush'
      WHEN hay ~* '\m(medium|med\.?)\M' THEN 'Medium'
      ELSE NULL END
    ) AS firm_val
  FROM src s
)
UPDATE product_variants v
SET size = coalesce(v.size, d.size_val),
    firmness = coalesce(v.firmness, d.firm_val)
FROM derived d
WHERE d.id = v.id;
-- backfill:end
--> statement-breakpoint
-- Regenerate the variant search vector so free text finds a size the name
-- omits ("queen bamboo sheets" for a CKSHEE/QUSHEE sheet set).
ALTER TABLE "product_variants" DROP COLUMN "search_tsv";
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(name, '') || ' ' || coalesce(sku, '') || ' ' || coalesce(barcode, '') || ' ' || coalesce(size, '') || ' ' || coalesce(firmness, '')
    )
  ) STORED;
--> statement-breakpoint
CREATE INDEX "product_variants_search_tsv_idx" ON "product_variants" USING gin ("search_tsv");
