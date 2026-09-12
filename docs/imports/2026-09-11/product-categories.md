# Product categories — 2026-09-11

**What this is.** A retail category tree for every SKU in the STORIS products
export (`docs/imports/2026-09-03/products.csv`, 1948 rows) and the file
that files each SKU into it: `product-categories.csv` (`SKU, CATEGORY,
SUBCATEGORY, SOURCE, STORIS_CATG, BRAND, DESCRIPTION`). The catalog import had
created eleven categories named after the STORIS `CATG` codes (MATT, ADJUST,
FOUND, FURN, PROT, TOPBED, BED, SUPPLY, PILLOW, NONINV, RF); the advanced
search could only narrow to those codes. This mapping replaces them with named
categories and a second level that answers the questions the floor actually
asks — memory foam or hybrid, base or remote, low profile or bunkie, headboard
or nightstand.

**How it is applied.** `apps/api/src/ops/categorize-products.ts`, run through
the _Ops — categorize products_ GitHub workflow (`ops-categorize-products.yml`)
as a Render one-off job, exactly like the catalog import:

1. `validate` — prints the full plan (renames, categories to create, products
   to move, SKUs not carried) and rolls back.
2. `commit` — renames the code categories **in place** (same ids, so reports,
   templates and replenishment rules that point at them keep working), creates
   the subcategories, moves every SKU, drops the emptied `RF` code category
   (its two rows fold into _Services & Fees_), and writes one
   `products.categorize` audit row. A second commit is a no-op.

A later re-import of `products.csv` does **not** undo this: the importer maps a
`CATG` code to the renamed root when no category of that code exists, and never
coarsens a product that already sits in a subcategory (A22.1).

**How the calls were made.** Every row carries a `SOURCE`:

| Source        | Meaning                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storefront`  | The retailer's own site (mattressstoreslosangeles.com) sells the line and labels its type — Innerspring / Hybrid / Memory Foam / Latex, Foundations, Adjustable Base, Sheets, … (268 product pages read on 2026-09-11). |
| `maker`       | The manufacturer's site or spec sheet.                                                                                                                                                                                  |
| `description` | The STORIS description says it (HYBRID, LATEX, HB, FND 9", ZIPPERED ENCASEMENT, …).                                                                                                                                     |
| `code`        | The STORIS `CATG` / `GROUP` code decides it (ADJBAS, PILPRO, \*PCAS, FRAMES, …).                                                                                                                                        |
| `inferred`    | No direct source; judged from the line, price and name. Listed below for review.                                                                                                                                        |

Regenerate the CSV after the export changes with
`python3 docs/imports/2026-09-11/build-product-categories.py` (stdlib only,
deterministic; the rules live in that file).

## The tree

| Category                       | Subcategory                           |     SKUs |
| ------------------------------ | ------------------------------------- | -------: |
| **Mattresses**                 |                                       | **1053** |
|                                | Innerspring                           |      528 |
|                                | Hybrid                                |      189 |
|                                | Memory Foam                           |      182 |
|                                | Latex                                 |      150 |
|                                | (none — filed on the category itself) |        4 |
| **Adjustable Bases**           |                                       |  **173** |
|                                | Adjustable Bed Bases                  |      145 |
|                                | Base Accessories & Parts              |       28 |
| **Foundations & Box Springs**  |                                       |  **159** |
|                                | Standard Profile (8–9")               |       75 |
|                                | Low Profile (4–5")                    |       60 |
|                                | Bunkie Board (2")                     |       24 |
| **Bed Frames**                 |                                       |   **94** |
|                                | Metal Bed Frames                      |       68 |
|                                | Frame Parts & Hardware                |       15 |
|                                | Platform & Folding Frames             |       11 |
| **Bedroom Furniture**          |                                       |  **126** |
|                                | Headboards                            |       46 |
|                                | Beds & Bed Pieces                     |       43 |
|                                | Nightstands                           |       13 |
|                                | Living Room & Decor                   |       13 |
|                                | Dressers, Chests & Mirrors            |        8 |
|                                | Daybeds & Sofa Beds                   |        3 |
| **Mattress Protection**        |                                       |  **106** |
|                                | Mattress Protectors                   |       74 |
|                                | Encasements & Covers                  |       26 |
|                                | Pillow Protectors                     |        6 |
| **Bedding**                    |                                       |  **113** |
|                                | Sheet Sets                            |       69 |
|                                | Pillowcases                           |       25 |
|                                | Toppers & Mattress Pads               |       18 |
|                                | Comforters & Duvets                   |        1 |
| **Pillows**                    |                                       |   **43** |
|                                | Memory Foam Pillows                   |       21 |
|                                | Latex Pillows                         |       12 |
|                                | Down & Down-Alternative Pillows       |        6 |
|                                | Specialty & Kids Pillows              |        4 |
| **Store Supplies & Equipment** |                                       |   **71** |
|                                | Office & Cleaning Supplies            |       35 |
|                                | Showroom & Signage                    |       17 |
|                                | Equipment & Fixtures                  |       15 |
|                                | Delivery Supplies                     |        4 |
| **Services & Fees**            |                                       |   **10** |
|                                | Delivery & Installation               |        8 |
|                                | Fees                                  |        2 |

Placeholders stay on the bare _Mattresses_ category: `KEYA` ("CKING MATT",
$1), `ENGIA-1070`, `SOUTHPROTOTYPE` and the unknown-maker `HAWK-T-F`.

## Mattress construction, by line

The four mattress subcategories follow the retailer's own storefront labels
where the line is sold online, then the maker's spec, then the STORIS
description. "Memory Foam" is the all-foam bucket (gel, copper, Technogel and
plant-based foams included); "Latex" holds natural-latex builds even when they
sit on coils, matching how the storefront files Harvest Green, Avalon and the
Scandinavian Collection.

| Brand                                                     | Innerspring                                                                                                                             | Hybrid                                                                                                   | Memory Foam                                                                                                                         | Latex                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Tempur-Pedic                                              | —                                                                                                                                       | every "HYB / HYBRID" build                                                                               | Adapt, ProAdapt, LuxeAdapt, ProBreeze, LuxeBreeze                                                                                   | —                                  |
| Stearns & Foster                                          | Estate, Lux Estate, Reserve, Studio, Cassatt, Hepburn, Hurston, Rockwell (IntelliCoil)                                                  | —                                                                                                        | —                                                                                                                                   | —                                  |
| Diamond                                                   | Tranquility Quilted, Grace Quilted, Lily, Dream (Grand, Bliss, Justice), Topaz, Rock 2.0, Marble, Slate, Generations Duchess & Heritage | every "HYBRID" build, Independence, Arise, Rockwell (Black Diamond), Snowbird, Flurry, Technogel Melodia | ProGel, Align, Glory All-Foam, Rally Foam, Float, Aura, Cheer, Surfside, Envoy, Restore+Copper, Technogel Armonia / Estasi / Favola | Diana, Lucille, Jeremiah, Natasha  |
| Eastman House / Eclipse (BIA)                             | Micah, Royal Sands, Cali Breeze, Greenwood, Lifetime Permatuft, Glacier & Ice Tufted, Spruce                                            | Cares (Joyfulness, Peacefulness, Kindness)                                                               | —                                                                                                                                   | Seville Latex, Avalon Latex Hybrid |
| Southerland                                               | Cobalt, Prelude II, Ovation                                                                                                             | Tobert Ultra Hybrid                                                                                      | Cool Comfort (Scandinavian foam core)                                                                                               | Anniversary, Sandmahn, Stockholm   |
| Chattam & Wells                                           | Lismore, Ashford, Kensington, Windsor, Chantilly, Miramare, Caserta, Carlton, Weston                                                    | Adelaide                                                                                                 | —                                                                                                                                   | Kingston, Buckingham, Geneva       |
| Spring Air / Cannon (SM-, SAM- SKUs)                      | value & tradition collections, Cambria, Christian, Clinton, Donna, Franklin, Hermosa, Pismo, Spirit, Yves, Royal Palm, Sydney Leah      | Francesca                                                                                                | —                                                                                                                                   | Sunrise Lux                        |
| Englander                                                 | Grenadier HD, Essex, Allendale, Amesbury                                                                                                | —                                                                                                        | —                                                                                                                                   | —                                  |
| Helix / Birch                                             | —                                                                                                                                       | Midnight, Twilight, Dusk, Sunset, Luxe, Elite                                                            | —                                                                                                                                   | Birch Natural                      |
| Brooklyn Bedding                                          | —                                                                                                                                       | Aurora Luxe, Signature Hybrid                                                                            | —                                                                                                                                   | —                                  |
| Harvest Green, Savvy Rest, Stress-O-Pedic (Christelle II) | —                                                                                                                                       | —                                                                                                        | —                                                                                                                                   | all                                |
| Easy Rest                                                 | —                                                                                                                                       | Dream 14" pocketed coil                                                                                  | Gel Lux                                                                                                                             | —                                  |

## Inferred calls (no direct source — worth a glance)

| Brand    | Why                                                         | Filed under              | Rows                        |
| -------- | ----------------------------------------------------------- | ------------------------ | --------------------------- |
| SOUTH    | placeholder / prototype / unknown maker                     | Mattresses               | 1 (e.g. `SOUTHPROTOTYPE`)   |
| SPINE    | pillow-top coil build                                       | Mattresses › Innerspring | 1 (e.g. `CLOUDGELPT`)       |
| SPINE    | gel foam build                                              | Mattresses › Memory Foam | 1 (e.g. `ELE-MED-QN`)       |
| SUPPLIES | placeholder / prototype / unknown maker                     | Mattresses               | 1 (e.g. `HAWK-T-F`)         |
| CANN     | Spring Air/Cannon private-label coil builds (SM-/SAM- SKUs) | Mattresses › Innerspring | 47 (e.g. `SAM-18002-ET-CK`) |
| CANN     | mis-coded pillow-top mattress (Cannon SM- SKU)              | Mattresses › Innerspring | 1 (e.g. `SMROYPALPT46`)     |
| DIAMO    | placeholder / prototype / unknown maker                     | Mattresses               | 2 (e.g. `ENGIA-1070`)       |

## Corrections to the STORIS codes

Rows whose STORIS code disagreed with what the product is were filed by what
it is: `SMROYPALPT46` (Royal Palm pillow top, coded FURN) → _Mattresses ›
Innerspring_; `SHEETS` (coded FURN) → _Bedding › Sheet Sets_; the Savvy Rest
wool _Bed Rug_ and cotton/wool _mattress pads_ (coded MATT / PROT) → _Bedding ›
Toppers & Mattress Pads_; the Chattam POP, display body pillow, foot protector
and Reverie retail kiosk (coded PROT / PILLOW / ADJUST) → _Store Supplies &
Equipment › Showroom & Signage_.

## Sources

- LA Mattress Store product pages and type collections
  (mattressstoreslosangeles.com/collections/{hybrid,memory-foam,innerspring,latex}-mattresses).
- diamondmattress.com (Tranquility, Grace, Rock 2.0, Snowbird, Heritage,
  Duchess, Surfside, Envoy, Cheer product pages); technogelworld.com (Armonia,
  Estasi, Favola); harvestgreenmattress.com; southerlandsleep.com and
  scandinaviansleep.com (Tobert, Cool Comfort); springair.com (Back Supporter
  Francesca); englander.com (Grenadier, Essex, Allendale); stearnsandfoster.com
  (IntelliCoil lines); goodbed.com / mattressunderground.com (Chattam & Wells,
  Spring Air Sunrise Lux latex); abt.com (S&F Lux Estate down-blend/latex
  pillow); Consumer Reports / landodreams.com (Eastman House Lifetime,
  Permatuft two-sided).
