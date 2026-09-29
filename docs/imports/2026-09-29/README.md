# 2026-09-29 — King Koil wholesale price sheet for Jewel City Mattress Store

`king-koil-jewel-city.csv` (48 data rows) transcribes the owner's three photos of the
King Koil wholesale sheet (HC Blue Intimate Wave Firm / Plush, HC Blue Azure Euro Top
Firm / Medium incl. split sizes, HC Blue Indigo Plush, Grove Firm / Medium Euro Top).

- `REPLACE_COST` = the sheet's wholesale PRICE column; `RETAIL` = POSSIBLE RETAIL.
- One product per SKU with one variant, matching the 2026-09-03 STORIS layout.
  `GROUP` carries the STORIS size code, `SIZE` / `FIRMNESS` are explicit so the
  importer does not have to guess from the description.
- `CATG` is `MATT`, which the importer aliases onto the business's "Mattresses" root.
- `VENDOR` = `KING KOIL` (created on the fly by the importer).

Load with `.github/workflows/ops-catalog-import.yml`: business `jewelcitymattress`
(Jewel City Mattress Store), entity `product`, this file, `expect_rows` 48, `replace_catalog` **off**
(validate first, then commit).

Transcription caveats: the second photo's model line reads "INDIGO … PLUSH" with the
middle word unreadable, recorded as "HC BLUE INDIGO PLUSH"; the split-size rows use
SKU prefixes 8349KK (Azure Euro Top Firm) and 8350KK (Azure Euro Top Medium) as printed.
