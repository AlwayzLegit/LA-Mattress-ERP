#!/usr/bin/env python3
"""
Convert the STORIS "ACTIVE INVENTORY Products" export (owner 2026-09-03)
into the two CSVs the ERP import wizard takes (Settings → Import):

  products.csv   one row per SKU   → entity "product"   (tick "Replace catalog")
  inventory.csv  one row per SKU@store → entity "inventory"

Columns in the export: Location, Brand, Type, Stock, Quantity As-Is,
Min Stock, Description, ?, SKU, Group, Vendor, Cost, Catg, …

Mapping decisions (PLAN-POS-OPERATIONS §12.12):
  - Store codes → ERP locations (the names the ERP uses; owner 2026-09-10:
    STORIS "201 Western" is Koreatown, "Hancock Park" is La Brea):
    01 Koreatown · 02 West LA · 03 La Brea · 04 Studio City · 88 Warehouse.
    Other codes carry no stock rows (the SKUs still become products).
  - ON_HAND = Stock + Quantity As-Is (Jetnine counts as-is pieces in on
    hand); AS_IS = Quantity As-Is; MIN_STOCK = Min Stock.
  - Vendor codes are the vendor names; Group is the variant attribute.
  - No selling price: existing SKUs keep theirs, new SKUs land at $0.

Usage:
  pip install openpyxl
  python3 docs/scripts/convert-active-inventory.py ACTIVE_INVENTORY_Products.xlsx out/
"""
import csv
import sys
from collections import OrderedDict
from pathlib import Path

import openpyxl

STORE_NAMES = {
    "01": "Koreatown",
    "02": "West LA",
    "03": "La Brea",
    "04": "Studio City",
    "88": "Warehouse",
}


def code(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v)).zfill(2)
    s = str(v).strip()
    return s.zfill(2) if s.isdigit() else s


def text(v):
    return "" if v is None else str(v).strip()


def num(v):
    if v in (None, ""):
        return 0
    return int(float(v))


def money(v):
    if v in (None, ""):
        return ""
    return f"{float(v):.2f}"


def main(src: str, out_dir: str) -> None:
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))[1:]
    products: "OrderedDict[str, dict]" = OrderedDict()
    inventory = []
    skipped_stores = {}
    for r in rows:
        if len(r) < 13 or not r[8]:
            continue
        sku = text(r[8])
        p = products.setdefault(
            sku,
            {
                "SKU": sku,
                "DESCRIPTION": text(r[6]) or sku,
                "BRAND": text(r[1]),
                "CATG": text(r[12]),
                "GROUP": text(r[9]),
                "VENDOR": text(r[10]),
                "REPLACE_COST": money(r[11]),
            },
        )
        if not p["REPLACE_COST"] and r[11] not in (None, ""):
            p["REPLACE_COST"] = money(r[11])
        store = code(r[0])
        name = STORE_NAMES.get(store)
        if not name:
            skipped_stores[store] = skipped_stores.get(store, 0) + 1
            continue
        stock, as_is, min_stock = num(r[3]), num(r[4]), num(r[5])
        inventory.append(
            {
                "SKU": sku,
                "LOCATION": name,
                "ON_HAND": stock + as_is,
                "AS_IS": as_is,
                "MIN_STOCK": min_stock,
                "UNIT_COST": money(r[11]),
            }
        )
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "products.csv").open("w", newline="") as f:
        w = csv.DictWriter(
            f, fieldnames=["SKU", "DESCRIPTION", "BRAND", "CATG", "GROUP", "VENDOR", "REPLACE_COST"]
        )
        w.writeheader()
        w.writerows(products.values())
    with (out / "inventory.csv").open("w", newline="") as f:
        w = csv.DictWriter(
            f, fieldnames=["SKU", "LOCATION", "ON_HAND", "AS_IS", "MIN_STOCK", "UNIT_COST"]
        )
        w.writeheader()
        w.writerows(inventory)
    print(f"products: {len(products)} SKUs → {out / 'products.csv'}")
    print(f"inventory: {len(inventory)} SKU@store rows → {out / 'inventory.csv'}")
    if skipped_stores:
        print("skipped store codes (no ERP location):", dict(sorted(skipped_stores.items())))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
