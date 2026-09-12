#!/usr/bin/env python3
"""Build docs/imports/2026-09-11/product-categories.csv from the STORIS
products export (docs/imports/2026-09-03/products.csv).

Every SKU gets a two-level retail category (CATEGORY, SUBCATEGORY) plus a
SOURCE note saying where the call came from:

  storefront   — the retailer's own site (mattressstoreslosangeles.com)
                 labels this line's product type
  maker        — the manufacturer's site / spec sheet
  description  — the STORIS description states it (HYBRID, LATEX, HB, …)
  code         — the STORIS CATG / GROUP code decides it
  inferred     — no direct source; judged from the line, price and name
                 (listed in product-categories.md for review)

Re-run after the export changes:
    python3 docs/imports/2026-09-11/build-product-categories.py
Stdlib only; deterministic.
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'docs/imports/2026-09-03/products.csv'
OUT = Path(__file__).resolve().parent / 'product-categories.csv'

# STORIS CATG code → top-level category name (the ops script renames the
# legacy code category in place so product references survive).
TOP = {
    'MATT': 'Mattresses',
    'ADJUST': 'Adjustable Bases',
    'FOUND': 'Foundations & Box Springs',
    'BED': 'Bed Frames',
    'FURN': 'Bedroom Furniture',
    'PROT': 'Mattress Protection',
    'TOPBED': 'Bedding',
    'PILLOW': 'Pillows',
    'SUPPLY': 'Store Supplies & Equipment',
    'NONINV': 'Services & Fees',
    'RF': 'Services & Fees',
}

MF, HY, IS, LX = 'Memory Foam', 'Hybrid', 'Innerspring', 'Latex'


def has(d: str, *words: str) -> bool:
    return any(w in d for w in words)


# ---------------------------------------------------------------- mattresses
def mattress(d: str, brand: str, sku: str) -> tuple[str | None, str]:
    """Return (subcategory or None for the bare parent, source)."""
    # Placeholders, prototypes and display-only rows stay on the parent.
    if sku in ('KEYA', 'ENGIA-1070', 'SOUTHPROTOTYPE') or brand == 'SUPPLIES':
        return None, 'inferred: placeholder / prototype / unknown maker'
    if brand == 'TEMPURPEDIC':
        return (HY, 'description: HYB') if has(d, 'HYB') else (MF, 'maker: TEMPUR material, no coils')
    if brand == 'STEARNS&FOSTER':
        return IS, 'storefront: Stearns & Foster Estate/Lux Estate/Reserve/Studio = Innerspring Mattress'
    if brand == 'DIAMO':
        if 'LATEX' in d or has(d, 'NATASHA', 'JEREMIAH', 'DIANA', 'LUCILLE'):
            return LX, 'storefront: Diamond natural latex line (Diana/Lucille/Jeremiah; Natasha shares the LO- latex SKU family)'
        if has(d, 'HYBRID', 'HYBR'):
            return HY, 'description: HYBRID'
        if has(d, 'INDEPENDENCE', 'ARISE', 'ROCKWELL'):
            return HY, 'storefront: Independence / Arise Luxe / Black Diamond Rockwell = Hybrid'
        if has(d, 'GEL MEMORY', 'ALL-FOAM', 'FOAM', 'RESTORE+COPPER', 'BIB CHEER', 'SURFSIDE', 'ENVOY', 'TECHNOGEL'):
            return MF, 'storefront/maker: all-foam (ProGel, Glory, Rally Foam, Float, Aura, Cheer, Surfside, Envoy, Technogel Armonia/Estasi/Favola)'
        if has(d, 'TRANQUILITY', 'GRACE', 'LILY', 'DREAM', 'GRAND', 'JUSTICE', 'MARBLE', 'ROCK', 'SLATE', 'TOPAZ', 'DUCHESS', 'HERITAGE'):
            return IS, 'storefront/maker: coil-and-foam quilted lines (Tranquility Quilted, Grace Quilted, Lily, Dream, Topaz, Rock/Marble/Slate, Generations) = Innerspring'
        return IS, 'inferred: Diamond default (coil)'
    if brand == 'EASTMAN':
        if has(d, 'LATEX', 'AVALON'):
            return LX, 'storefront: Seville Latex / Avalon Latex Hybrid listed under Latex'
        return IS, 'storefront: Micah / Royal Sands / Spruce = Innerspring; Lifetime Permatuft & Greenwood two-sided innerspring (maker)'
    if brand == 'ECLIPSE':
        if 'CARES' in d:
            return HY, 'storefront: Eclipse Cares Joyfulness/Peacefulness/Kindness = Hybrid bed-in-a-box'
        return IS, 'storefront: Ice/Glacier Tufted, Spruce = Innerspring'
    if brand == 'ENGLANDER':
        return IS, 'maker: Grenadier / Essex / Allendale / Amesbury wrapped-coil innerspring'
    if brand == 'EREST':
        return (HY, 'description: pocketed coil bed-in-a-box') if 'COIL' in d else (MF, 'maker: Easy Rest Gel Lux gel memory foam')
    if brand == 'HARVEST':
        return LX, 'storefront/maker: Harvest Green organic Dunlop latex over coils, sold as Latex'
    if brand == 'HELIX':
        return (LX, 'storefront: Birch Natural = Latex Hybrid Mattress') if 'BIRCH' in d else (HY, 'storefront/maker: Helix Midnight/Twilight/Dusk/Sunset/Luxe/Elite hybrids')
    if brand == 'BROOKLYN':
        return HY, 'storefront: Aurora Luxe / Signature Hybrid = Hybrid Mattress'
    if brand == 'SAVVY':
        return LX, 'maker: Savvy Rest organic Dunlop/Talalay latex (layers and Serenity builds)'
    if brand == 'SOP':
        return LX, 'storefront: Christelle II Natural Latex (Stress-O-Pedic/Restonic) listed under Latex'
    if brand == 'SOUTH':
        if has(d, 'ANNIVERSARY', 'SANDMAHN', 'STOCKHOLM'):
            return LX, 'storefront: Scandinavian Collection natural latex line = Latex'
        if 'COOL COMFORT' in d:
            return MF, 'maker: Scandinavian Cool Comfort foam-core (Omni HD foam + copper latex + gel memory foam)'
        if 'HYBRID' in d:
            return HY, 'description: HYBRID (Tobert)'
        return IS, 'storefront/maker: Cobalt, Prelude II, Ovation innerspring'
    if brand == 'SPINE':
        if 'LATEX' in d:
            return LX, 'description: LATEX'
        if 'GEL' in d and 'PILLOW TOP' not in d:
            return MF, 'inferred: gel foam build'
        return IS, 'inferred: pillow-top coil build'
    if brand == 'SPRING-AIR':
        return (HY, 'description/maker: Back Supporter Francesca hybrid') if 'HYBRID' in d else (IS, 'storefront/maker: Spring Air value & tradition collections = Innerspring')
    if brand == 'CANN':
        if 'SUNRISE LUX' in d:
            return LX, 'maker: Spring Air Sunrise Lux latex'
        return IS, 'inferred: Spring Air/Cannon private-label coil builds (SM-/SAM- SKUs)'
    if brand == 'CHATTAM':
        if has(d, 'KINGSTON', 'BUCKINGHAM', 'GENEVA'):
            return LX, 'storefront: Kingston / Buckingham / Geneva listed under Latex'
        if 'ADELAIDE' in d:
            return HY, 'storefront: Adelaide Luxury Plush Hybrid'
        return IS, 'storefront: Chattam & Wells hand-tufted innerspring (Lismore, Ashford, Kensington, Windsor, Chantilly, Miramare, Caserta, Carlton, Weston)'
    return IS, 'inferred: default'


# ------------------------------------------------------- everything else
def classify(r: dict) -> tuple[str, str | None, str]:
    catg, d, brand, group, sku = r['CATG'], r['DESCRIPTION'].upper(), r['BRAND'], r['GROUP'], r['SKU']
    top = TOP[catg]

    if catg == 'MATT':
        if 'BED RUG' in d:
            return 'Bedding', 'Toppers & Mattress Pads', 'maker: Savvy Rest wool mattress rug is a topper'
        sub, src = mattress(d, brand, sku)
        return top, sub, src

    if catg == 'ADJUST':
        if 'KIOSK' in d:
            return 'Store Supplies & Equipment', 'Showroom & Signage', 'description: retail kiosk display'
        if has(d, 'ELEVATE KIT', 'RIZER KIT'):
            return top, 'Adjustable Bed Bases', 'maker: head-up adjustable base kit'
        if group == 'ADJBAS':
            return top, 'Base Accessories & Parts', 'code: GROUP ADJBAS (remotes, legs, brackets, covers, cables)'
        return top, 'Adjustable Bed Bases', 'code: sized ADJ group'

    if catg == 'FOUND':
        if re.search(r'\bBB\b|\b2"', d):
            return top, 'Bunkie Board (2")', 'description: BB / 2"'
        if re.search(r'\bLP\b|\b[45]"|BOX 4\b|FND 4\b', d):
            return top, 'Low Profile (4–5")', 'description: LP / 4" / 5"'
        return top, 'Standard Profile (8–9")', 'description: 8"–9" foundation'

    if catg == 'BED':
        if re.search(r'WHEEL|BEDBEAM|LAZARBEAM|PRODUCT #70|BOLT-IN|HB BRKT', d) and 'BED FRAME' not in d:
            return top, 'Frame Parts & Hardware', 'description: wheels / slat supports / brackets / rails'
        if group == 'BEDFRA' or 'BED BASE' in d:
            return top, 'Platform & Folding Frames', 'code: GROUP BEDFRA / platform bed base'
        return top, 'Metal Bed Frames', 'code: GROUP FRAMES'

    if catg == 'FURN':
        if 'ROYAL PALM' in d:
            return 'Mattresses', IS, 'inferred: mis-coded pillow-top mattress (Cannon SM- SKU)'
        if sku == 'SHEETS':
            return 'Bedding', 'Sheet Sets', 'description: sheets placeholder'
        if group == 'HBOARD' or re.search(r'HEADBOARD|\bHB\b', d):
            return top, 'Headboards', 'description: HB / headboard'
        if re.search(r'NIGHTSTAND|NIGHT STAND|\bNS\b', d):
            return top, 'Nightstands', 'description: nightstand'
        if re.search(r'DRESSER|CHEST|CHIFFAROBE|MIRROR', d):
            return top, 'Dressers, Chests & Mirrors', 'description: dresser / chest / mirror'
        if group == 'DAYBED' or 'DAYBED' in d or 'SOFA' in d:
            return top, 'Daybeds & Sofa Beds', 'description: daybed / sofa bed'
        if group in ('LIVING', 'RUGS', 'DINE') or re.search(r'LAMP|CONSOLE|COCKTAIL|TV BACKER|CHAIR|RUG', d):
            return top, 'Living Room & Decor', 'code: GROUP LIVING / RUGS / DINE'
        return top, 'Beds & Bed Pieces', 'description: bed, footboard, rails, decking, panel'

    if catg == 'PROT':
        if 'POP' in d.split():
            return 'Store Supplies & Equipment', 'Showroom & Signage', 'description: point-of-purchase display'
        if group == 'PILPRO' or re.search(r'PILLOW|PILL\.|\bPILL\b', d):
            return top, 'Pillow Protectors', 'code: GROUP PILPRO'
        if re.search(r'ENCASE|ZIP|FOUNDATION COVER|COVER REPLACEMENT|INVISACASE', d):
            return top, 'Encasements & Covers', 'description: zippered encasement / cover'
        if 'MATTRESS PAD' in d:
            return 'Bedding', 'Toppers & Mattress Pads', 'description: mattress pad'
        return top, 'Mattress Protectors', 'code: GROUP *PRO'

    if catg == 'TOPBED':
        if re.search(r'DUVET|COMFORTER', d):
            return top, 'Comforters & Duvets', 'description: duvet / comforter'
        if re.search(r'TOPPER|MATTRESS PAD|WOOLSY|BED RUG', d):
            return top, 'Toppers & Mattress Pads', 'description: topper / pad'
        if group.endswith('PCAS') or re.search(r'PILLOW C|PILL CASE|PILLOW CASE|PILLOW CAS|PILLOW CS|PILLOW DRIFTWOOD', d):
            return top, 'Pillowcases', 'code: GROUP *PCAS'
        return top, 'Sheet Sets', 'code: GROUP *SHE / description sheets'

    if catg == 'PILLOW':
        if re.search(r'DISPLAY|FOOT PROTECTOR', d):
            return 'Store Supplies & Equipment', 'Showroom & Signage', 'description: display item'
        if re.search(r'LATEX|TALALAY|LUX-ESTATE', d) or brand == 'SAVVY':
            return top, 'Latex Pillows', 'description/maker: latex (Savvy Rest, Sleep & Beyond myLatex, S&F Studio latex, S&F Lux Estate down-blend/latex)'
        if re.search(r'DOWN|MICROFIBER', d):
            return top, 'Down & Down-Alternative Pillows', 'description: down / down-alternative / microfiber'
        if re.search(r'BODY PILLOW|CUB|FIFI', d):
            return top, 'Specialty & Kids Pillows', 'description: body pillow / pillow cub / decorative'
        return top, 'Memory Foam Pillows', 'maker: memory-foam pillows (TEMPUR, Rize, Malouf Z, Ameri, bamboo shredded foam)'

    if catg == 'SUPPLY':
        if re.search(r'MATTRESS BAG|PACKAGING TAPE|TAPE MEASURE', d):
            return top, 'Delivery Supplies', 'description: delivery consumables'
        if re.search(r'SIGN|BALLOON|HELIUM|BANNER|GRIDWALL|PILLOW GUARD|DISPLAY|BED ON FLOOR|FOOTBOARD', d):
            return top, 'Showroom & Signage', 'description: showroom / signage'
        if re.search(r'TONER|STAPLER', d):
            return top, 'Office & Cleaning Supplies', 'description: office consumables'
        if re.search(r'CABINET|PHONE|PRINTER|BROTHER|CHAIR|COMPUTER|EXTENSION CORD|MICROWAVE|FRIDGE|DESK|SHREDDER|WATER DISPENSER|MOP|IPHONE', d):
            return top, 'Equipment & Fixtures', 'description: equipment / fixtures'
        return top, 'Office & Cleaning Supplies', 'description: office / cleaning consumables'

    if catg == 'NONINV':
        return top, 'Delivery & Installation', 'code: CATG NONINV service'
    if catg == 'RF':
        return top, 'Fees', 'code: CATG RF'
    raise ValueError(catg)


def main() -> int:
    rows = list(csv.DictReader(SRC.open(newline='')))
    out = []
    for r in rows:
        top, sub, src = classify(r)
        out.append({'SKU': r['SKU'], 'CATEGORY': top, 'SUBCATEGORY': sub or '', 'SOURCE': src,
                    'STORIS_CATG': r['CATG'], 'BRAND': r['BRAND'], 'DESCRIPTION': r['DESCRIPTION']})
    with OUT.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['SKU', 'CATEGORY', 'SUBCATEGORY', 'SOURCE', 'STORIS_CATG', 'BRAND', 'DESCRIPTION'])
        w.writeheader()
        w.writerows(out)
    print(f'{len(out)} rows → {OUT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
