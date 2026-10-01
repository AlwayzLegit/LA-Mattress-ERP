# 2026-10-01 — Helix Twin XL mattresses (LA Mattress)

`helix-twinxl.csv` (6 data rows) transcribes the owner's STORIS product screen photo of
the Helix Twin XL line: Twilight-Luxe Firm, Twilight Firm, Midnight Medium, Midnight-Luxe
Medium, Twilight-Elite Firm and Midnight-Elite Medium.

- `RETAIL` = the screen's Price; `REPLACE_COST` = its Sales Margin Cost.
- One product per SKU with one variant, matching the 2026-09-03 STORIS layout and the
  other Helix sizes (`VENDOR` `SOUTH`, `BRAND` `HELIX`, `GROUP` `TWINXL`).
- `CATG` is `Hybrid`, the A22.1 subcategory the other Helix sizes sit under
  (Mattresses › Hybrid); the importer matches a category by name.
- STORIS spells "MEDUIM"; the catalog's other Helix sizes read "MEDIUM", kept here.
- `HEXSTW_FP-3980` (Twin XL Twilight Firm) was already in the 2026-09-03 file. The import
  adopts that row by SKU and sets its price, rather than adding a duplicate.
- Nothing is on hand (all six read 0), so there is no inventory file.

Load with `.github/workflows/ops-catalog-import.yml`: business `la-mattress`, entity
`product`, this file, `expect_rows` 6, `replace_catalog` **off** (validate first, then
commit).
