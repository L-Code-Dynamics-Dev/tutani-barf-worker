#!/usr/bin/env python3
"""
Import inventárních záznamů z tutani_full_catalog_2026-09-09.json crawler exportu
(scraper potvrdil jen NÁZEV + URL, ŽÁDNÁ composition/cena/kód data).

Zapisuje:
  - tenants/tutani/rules/tutani-supplements.json (doplňky ÚKOL A + přílohy ÚKOL B)
  - tenants/tutani/rules/tutani-products.json (BARF na cesty ÚKOL C)

R7: declared=[] všude, žádné vymyšlené composition/procenta/ceny.
Read-modify-write s retry proti race s paralelním agentem, který zapisuje
pamlsky do stejného tutani-supplements.json.
"""
import json
import time
import sys
from pathlib import Path

REPO = Path("/Users/lucky/tutani-barf-worker")
SUPP_PATH = REPO / "tenants/tutani/rules/tutani-supplements.json"
PROD_PATH = REPO / "tenants/tutani/rules/tutani-products.json"

TODAY = "2026-09-09"
BASE_DOPLNKY = "https://obchod.tutani.cz/doplnky/"
BASE_PRILOHY = "https://obchod.tutani.cz/prilohy/"
BASE_BARF_CESTY = "https://obchod.tutani.cz/barf-na-cesty/"

SOURCE_NOTE_SUPP = (
    "tutani_full_catalog_2026-09-09.json crawler export — jen inventární "
    "potvrzení existence (název+URL slug), ŽÁDNÁ nová composition/cena data. "
    "declared/ingredientList/cena zůstávají prázdné/null, dokud nebude "
    "dostupný skutečný štítek/scraper výstup s hodnotami (R7)."
)


def supplement_stub(product_id, code, name_cs, category, base_url, slug,
                     marketing_claims=None, note_extra=None, ingredient_list=None):
    note = SOURCE_NOTE_SUPP
    if note_extra:
        note = note_extra + " | " + note
    return {
        "productId": product_id,
        "code": code,
        "nameCs": name_cs,
        "brand": None,
        "category": category,
        "declared": [],
        "derivedPer100g": [],
        "marketingClaims": marketing_claims or [],
        "ingredientList": ingredient_list,
        "mineralAssay": None,
        "dosageInstructionCs": None,
        "packGrams": None,
        "priceWithVatCzk": None,
        "availability": "UNKNOWN",
        "url": base_url + slug,
        "evidence": {
            "source": "TUTANI_PRODUCT_PAGE",
            "sourceDate": TODAY,
            "confidence": "ESTIMATED",
            "noteCs": (
                "Tutani kód zatím NEZNÁM — code je URL-slug, ne skutečný "
                "katalogový kód. " + note
            ),
        },
        "updatedAt": TODAY,
    }


def product_stub(product_id, code, name_cs, composition, kind, note_extra=None):
    note = SOURCE_NOTE_SUPP
    if note_extra:
        note = note_extra + " | " + note
    return {
        "productId": product_id,
        "code": code,
        "nameCs": name_cs,
        "brand": "MAX deluxe",
        "categoryPath": "Barf na cesty",
        "topCategory": "BARF_NA_CESTY",
        "priceWithVatCzk": None,
        "packGrams": None,
        "availability": "UNKNOWN",
        "url": BASE_BARF_CESTY + code,
        "kind": kind,
        "composition": composition,
        "compositionAccountedPct": 0,
        "analytical": [],
        "claims": {
            "rawDescriptionCs": name_cs,
            "ageCategory": None,
            "dietaryClaimsCs": [],
        },
        "evidence": {
            "source": "TUTANI_PRODUCT_PAGE",
            "sourceDate": TODAY,
            "confidence": "ESTIMATED",
            "noteCs": (
                "Tutani kód zatím NEZNÁM — code je URL-slug. " + note
            ),
        },
        "updatedAt": TODAY,
    }


def partial_ingredient(name_cs, species, part, source_cs):
    return {
        "ingredientId": None,
        "nameCs": name_cs,
        "species": species,
        "part": part,
        "role": "INGREDIENT",
        "subcomponentsCs": [],
        "subcomponentRatio": None,
        "percentage": None,
        "certainty": "PARTIAL",
        "sourceCs": source_cs,
    }


# =====================================================================
# ÚKOL A — DOPLŇKY (existing codes for dedup check)
# =====================================================================
# existing supplement codes checked: TUT142 (Psyllium 200g), DR4/DR1
# (Dromy Balancer 8in1), TUT181 (Multivitamín), TUT134 (Kelpa), DR16
# (Dromy FLEX), DR8 (Bronchovet), E11/E12/E13/E17 (Energy), DR24
# (Krill Pure 500g)

new_supplements = []
dup_notes = []  # (existing_code, note_to_append)

# 1. Pivovarské kvasnice 500g/1kg — no existing dup
new_supplements.append(supplement_stub(
    "pivovarske-kvasnice", "pivovarske-kvasnice",
    "Pivovarské kvasnice 500g, 1kg", "OTHER", BASE_DOPLNKY, "pivovarske-kvasnice",
    marketing_claims=[{"claimCs": "pivovarské kvasnice — přírodní zdroj B-vitaminů a bílkovin (obecné tvrzení, bez konkrétního mg)", "backedByDeclaredNutrient": None}],
))

# 2. Barf CAULERPA - Zelená mořská řasa 200g
new_supplements.append(supplement_stub(
    "barf-caulerpa-zelena-morska-rasa-200g", "barf-caulerpa-zelena-morska-rasa-200g",
    "Barf CAULERPA - Zelená mořská řasa 200g", "OTHER", BASE_DOPLNKY, "barf-caulerpa-zelena-morska-rasa-200g",
    marketing_claims=[{"claimCs": "zelená mořská řasa (Caulerpa) — mineralizační doplněk dle názvu, bez deklarovaných hodnot", "backedByDeclaredNutrient": None}],
))

# 3. Dromy OMEGA EPA & DHA oil 500ml — POZOR R7: jen marketingClaim, ne declared
new_supplements.append(supplement_stub(
    "dromy-omega-epa-dha-oil-500-ml", "dromy-omega-epa-dha-oil-500-ml",
    "Dromy OMEGA EPA & DHA oil 500ml", "OIL", BASE_DOPLNKY, "dromy-omega-epa-dha-oil-500-ml",
    marketing_claims=[{"claimCs": "název produktu tvrdí obsah EPA/DHA, ale scraper NEZÍSKAL konkrétní mg — dle R7/Omegavet pravidla se NEPŘEVÁDÍ na declared bez skutečné deklarované hodnoty", "backedByDeclaredNutrient": None}],
    note_extra="POZOR: název sám naznačuje EPA/DHA obsah, ale BEZ konkrétního mg — declared zůstává [] přesně dle R7 pravidla (Omegavet/kelpa precedent).",
))

# 4. Dromy Mladý ječmen 500g
new_supplements.append(supplement_stub(
    "dromy-mlady-jecmen-500g", "dromy-mlady-jecmen-500g",
    "Dromy Mladý ječmen 500g", "OTHER", BASE_DOPLNKY, "dromy-mlady-jecmen-500g",
    marketing_claims=[{"claimCs": "mladý ječmen — zelená potrava, obecné tvrzení o obsahu vlákniny/chlorofylu bez konkrétních čísel", "backedByDeclaredNutrient": None}],
))

# 5. Konopný olej pro psy 500 ml
new_supplements.append(supplement_stub(
    "konopny-olej-pro-psy-500-ml", "konopny-olej-pro-psy-500-ml",
    "Konopný olej pro psy 500 ml", "OIL", BASE_DOPLNKY, "konopny-olej-pro-psy-500-ml",
))

# 6. Barf PSYLLIUM - Rozpustná vláknina 200g — DUPLICITA s TUT142
dup_notes.append(("TUT142", "Potvrzena existence stránky 'Barf PSYLLIUM - Rozpustná vláknina 200g' "
                   "(slug barf-psyllium-rozpustna-vlaknina-200g) v tutani_full_catalog_2026-09-09.json "
                   "crawler exportu — vypadá jako TENTÝŽ produkt jako TUT142 Psyllium 200g, jen jinak "
                   "pojmenovaná stránka. NEDUPLIKOVÁNO, nový záznam nepřidán."))

# 7. Dromy Gastro 250 g
new_supplements.append(supplement_stub(
    "dromy-gastro-250-g", "dromy-gastro-250-g",
    "Dromy Gastro 250 g", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-gastro-250-g",
    marketing_claims=[{"claimCs": "podpora trávicího traktu (název 'Gastro') — funkční doplněk, mimo základní BARF balancování", "backedByDeclaredNutrient": None}],
))

# 8. Dromy Kličkový olej 500ml
new_supplements.append(supplement_stub(
    "dromy-klickovy-olej-500-ml", "dromy-klickovy-olej-500-ml",
    "Dromy Kličkový olej 500ml", "OIL", BASE_DOPLNKY, "dromy-klickovy-olej-500-ml",
))

# 9. Dromy Balancer BARF 8in1 - 800g — DUPLICITA s existujícím DR4
dup_notes.append(("DR4", "Potvrzena existence stránky 'Dromy Balancer BARF 8in1 - 800g' "
                   "(slug dromy-balancer-barf-8in1-800g) v crawler exportu 2026-09-09 — odpovídá "
                   "existujícímu DR4 (stejný název a gramáž). NEDUPLIKOVÁNO."))

# 10. Multivitamín sypký 200g — DUPLICITA s TUT181
dup_notes.append(("TUT181", "Potvrzena existence stránky 'Multivitamín sypký 200g' "
                   "(slug multivitamin-sypky-200g) v crawler exportu 2026-09-09 — odpovídá existujícímu "
                   "TUT181 (stejný název a gramáž). NEDUPLIKOVÁNO."))

# 11. Barf ENERGY DRINK IONS 4DOG 250g
new_supplements.append(supplement_stub(
    "barf-energy-drink-ions-4dog-250g", "barf-energy-drink-ions-4dog-250g",
    "Barf ENERGY DRINK IONS 4DOG 250g", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "barf-energy-drink-ions-4dog-250g",
    marketing_claims=[{"claimCs": "iontový nápoj/doplněk pro psy (rehydratace dle názvu) — funkční doplněk mimo základní BARF balancování", "backedByDeclaredNutrient": None}],
))

# 12. Barf CHLORELLA - Sladkovodní řasa 200g
new_supplements.append(supplement_stub(
    "barf-chlorella-sladkovodni-rasa--200g", "barf-chlorella-sladkovodni-rasa--200g",
    "Barf CHLORELLA - Sladkovodní řasa 200g", "OTHER", BASE_DOPLNKY, "barf-chlorella-sladkovodni-rasa--200g",
    marketing_claims=[{"claimCs": "sladkovodní řasa chlorella — obecné tvrzení o detoxikačních/nutričních účincích, bez konkrétních čísel", "backedByDeclaredNutrient": None}],
))

# 13. Barf KELPA - Hnědá mořská řasa 200g — DUPLICITA s TUT134
dup_notes.append(("TUT134", "Potvrzena existence stránky 'Barf KELPA - Hnědá mořská řasa 200g' "
                   "(slug barf-kelpa-hneda-morska-rasa-200g) v crawler exportu 2026-09-09 — odpovídá "
                   "existujícímu TUT134 KELPA 200g (hnědá mořská řasa = Ascophyllum nodosum, stejná "
                   "gramáž). NEDUPLIKOVÁNO."))

# 14. Barf Spirulina 200g
new_supplements.append(supplement_stub(
    "barf-spirulina-200g", "barf-spirulina-200g",
    "Barf Spirulina 200g", "OTHER", BASE_DOPLNKY, "barf-spirulina-200g",
    marketing_claims=[{"claimCs": "spirulina — sinice, obecné tvrzení o obsahu bílkovin/mikroživin bez konkrétních čísel", "backedByDeclaredNutrient": None}],
))

# 15. Dromy Balancer BARF 8in1 - 200 g — DUPLICITA s DR1
dup_notes.append(("DR1", "Potvrzena existence stránky 'Dromy Balancer BARF 8in1 - 200 g' "
                   "(slug dromy-balancer-barf-8in1-200-g) v crawler exportu 2026-09-09 — odpovídá "
                   "existujícímu DR1 (stejný název a gramáž). NEDUPLIKOVÁNO."))

# 16. Dromy Boswellia liquid 500ml
new_supplements.append(supplement_stub(
    "dromy-boswellia-liquid-500-ml", "dromy-boswellia-liquid-500-ml",
    "Dromy Boswellia liquid 500ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-boswellia-liquid-500-ml",
    marketing_claims=[{"claimCs": "kadidlovník (Boswellia) — bylinný doplněk, typicky kloubní/protizánětlivé použití dle názvu řady, bez deklarovaných hodnot", "backedByDeclaredNutrient": None}],
))

# 17. Dromy Bronchovet 500 ml — DUPLICITA s DR8
dup_notes.append(("DR8", "Potvrzena existence stránky 'Dromy Bronchovet 500 ml' "
                   "(slug dromy-bronchovet-500-ml) v crawler exportu 2026-09-09 — odpovídá existujícímu "
                   "DR8 (stejný název a objem). NEDUPLIKOVÁNO."))

# 18. Dromy Brutnákový olej 200 ml
new_supplements.append(supplement_stub(
    "dromy-brutnakovy-olej-200-ml", "dromy-brutnakovy-olej-200-ml",
    "Dromy Brutnákový olej 200 ml", "OIL", BASE_DOPLNKY, "dromy-brutnakovy-olej-200-ml",
))

# 19. Dromy Collagen 160 tbl.
new_supplements.append(supplement_stub(
    "dromy-collagen-160-tbl", "dromy-collagen-160-tbl",
    "Dromy Collagen 160 tbl.", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-collagen-160-tbl",
    marketing_claims=[{"claimCs": "kolagenový doplněk (klouby/kůže/srst dle typického určení kolagenu), bez deklarovaného množství", "backedByDeclaredNutrient": None}],
))

# 20. Dromy Cuketa powder 300g
new_supplements.append(supplement_stub(
    "dromy-cuketa-powder-300g", "dromy-cuketa-powder-300g",
    "Dromy Cuketa powder 300g", "OTHER", BASE_DOPLNKY, "dromy-cuketa-powder-300g",
    marketing_claims=[{"claimCs": "sušená cuketa v prášku — zeleninový doplněk, obecné tvrzení bez konkrétních čísel", "backedByDeclaredNutrient": None}],
))

# 21. Dromy D-Tox 300g (slug: dromy-ascokelp-360-g) — nesrovnalost slug vs. název
new_supplements.append(supplement_stub(
    "dromy-ascokelp-360-g", "dromy-ascokelp-360-g",
    "Dromy D-Tox 300g", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-ascokelp-360-g",
    marketing_claims=[{"claimCs": "detoxikační doplněk (název 'D-Tox') — funkční doplněk mimo základní BARF balancování", "backedByDeclaredNutrient": None}],
    note_extra=("OTEVŘENÝ NÁLEZ: URL slug říká 'dromy-ascokelp-360-g' (360 g, jiný "
                "produktový název 'Ascokelp'), ale dodaný název stránky říká 'Dromy D-Tox 300g'. "
                "Nesrovnalost mezi slugem a názvem NEOPRAVENA ani nedomyšlena — packGrams "
                "záměrně null, dokud nebude ověřeno, který údaj (300g/D-Tox vs. 360g/Ascokelp) je správný."),
))

# 22. Dromy FLEX 500 ml — DUPLICITA s DR16
dup_notes.append(("DR16", "Potvrzena existence stránky 'Dromy FLEX 500 ml' (slug dromy-flex-500-ml) "
                   "v crawler exportu 2026-09-09 — odpovídá existujícímu DR16 (stejný název a objem). "
                   "NEDUPLIKOVÁNO."))

# 23. Energy Annovet 30ml
new_supplements.append(supplement_stub(
    "energy-annovet-30-ml", "energy-annovet-30-ml",
    "Energy Annovet 30ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-annovet-30-ml",
))

# 24. Energy Audivet 30ml
new_supplements.append(supplement_stub(
    "energy-audivet-30-ml", "energy-audivet-30-ml",
    "Energy Audivet 30ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-audivet-30-ml",
    marketing_claims=[{"claimCs": "podpora sluchu (název 'Audivet') — cílený funkční doplněk", "backedByDeclaredNutrient": None}],
))

# 25. Energy Cytovet 90 tbl
new_supplements.append(supplement_stub(
    "energy-cytovet-90-tbl", "energy-cytovet-90-tbl",
    "Energy Cytovet 90 tbl", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-cytovet-90-tbl",
))

# 26. Energy Etovet 30ml
new_supplements.append(supplement_stub(
    "energy-etovet-30-ml", "energy-etovet-30-ml",
    "Energy Etovet 30ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-etovet-30-ml",
))

# 27. Energy Imunovet 30ml — DUPLICITA s E11
dup_notes.append(("E11", "Potvrzena existence stránky 'Energy Imunovet 30ml' (slug energy-imunovet-30-ml) "
                   "v crawler exportu 2026-09-09 — odpovídá existujícímu E11 (stejný název a objem). "
                   "NEDUPLIKOVÁNO."))

# 28. Energy Kingvet 30ml — DUPLICITA s E12
dup_notes.append(("E12", "Potvrzena existence stránky 'Energy Kingvet 30ml' (slug energy-kingvet-30-ml) "
                   "v crawler exportu 2026-09-09 — odpovídá existujícímu E12 (stejný název a objem). "
                   "NEDUPLIKOVÁNO."))

# 29. Energy Korovet 30ml — E13 existuje bez ceny; tento zdroj cenu TAKÉ NEMÁ (UNKNOWN) → E13 beze změny
dup_notes.append(("E13", "Potvrzena existence stránky 'Energy Korovet 30ml' (slug energy-korovet-30-ml) "
                   "v crawler exportu 2026-09-09 — odpovídá existujícímu E13. Tento zdroj cenu "
                   "NEMÁ (jen název+URL, žádná cena získána), takže E13.priceWithVatCzk zůstává "
                   "beze změny (null) — NEDOPLŇOVÁNO z domněnky, jen potvrzena existence produktu."))

# 30. Energy Nutrivet 90 tbl
new_supplements.append(supplement_stub(
    "energy-nutrivet-90-tbl", "energy-nutrivet-90-tbl",
    "Energy Nutrivet 90 tbl", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-nutrivet-90-tbl",
))

# 31. Energy Probiovet 90 tbl
new_supplements.append(supplement_stub(
    "energy-probiovet-90-tbl", "energy-probiovet-90-tbl",
    "Energy Probiovet 90 tbl", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-probiovet-90-tbl",
    marketing_claims=[{"claimCs": "probiotický doplněk (název 'Probiovet') — podpora střevní mikroflóry dle názvu", "backedByDeclaredNutrient": None}],
))

# 32. Energy Regavet 30ml — DUPLICITA s E17
dup_notes.append(("E17", "Potvrzena existence stránky 'Energy Regavet 30ml' (slug energy-regavet-30ml) "
                   "v crawler exportu 2026-09-09 — odpovídá existujícímu E17 (stejný název a objem). "
                   "NEDUPLIKOVÁNO."))

# 33. Energy Renovet 30ml
new_supplements.append(supplement_stub(
    "energy-renovet-30ml", "energy-renovet-30ml",
    "Energy Renovet 30ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-renovet-30ml",
    marketing_claims=[{"claimCs": "podpora ledvin (název 'Renovet') — cílený funkční doplněk", "backedByDeclaredNutrient": None}],
))

# 34. Energy Vet Tickvet 10 ml
new_supplements.append(supplement_stub(
    "energy-vet-tickvet-10-ml", "energy-vet-tickvet-10-ml",
    "Energy Vet Tickvet 10 ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-vet-tickvet-10-ml",
    marketing_claims=[{"claimCs": "repelentní/antiparazitický přípravek (název 'Tickvet' — klíšťata) — cílený funkční doplněk", "backedByDeclaredNutrient": None}],
))

# 35. Energy Virovet 30ml
new_supplements.append(supplement_stub(
    "energy-virovet-30ml", "energy-virovet-30ml",
    "Energy Virovet 30ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "energy-virovet-30ml",
    marketing_claims=[{"claimCs": "podpora imunity proti virovým infekcím (název 'Virovet') — cílený funkční doplněk", "backedByDeclaredNutrient": None}],
))

# 36. Grafikon pro výběr optimálního preparátu Energy Vet — NENÍ produkt, vynechat
# (jen zaznamenáno do poznámky, viz SKIPPED_NOTES níže)

# 37. Dromy Konopný olej 500 ml — možná duplicita s "konopny-olej-pro-psy-500-ml" výše
# Oba slugy odkazují na konopný olej 500 ml. Bez dalšího důkazu (jiná značka?) systém
# NEDOMÝŠLÍ — zapisujeme JEN JEDNOU (položka #5 výše), tuhle položku vynecháváme s poznámkou.
# (viz SKIPPED_NOTES)

# 38. Dromy Krill pure 130g
new_supplements.append(supplement_stub(
    "dromy-krill-pure-130-g", "dromy-krill-pure-130-g",
    "Dromy Krill pure 130g", "OIL", BASE_DOPLNKY, "dromy-krill-pure-130-g",
    marketing_claims=[{"claimCs": "krill (Euphausia superba) — stejná řada jako DR24 Krill Pure 500g, jiná gramáž; EPA/DHA tvrzení výrobce BEZ deklarovaného mg (stejné pravidlo jako DR24)", "backedByDeclaredNutrient": None}],
))

# 39. Dromy Krill pure 500g — DUPLICITA s existujícím DR24
dup_notes.append(("DR24", "Potvrzena existence stránky 'Dromy Krill pure 500g' (slug krill-pure-500-g) "
                   "v crawler exportu 2026-09-09 — odpovídá existujícímu DR24 Dromy Krill Pure 500 g "
                   "(stejný název a gramáž). NEDUPLIKOVÁNO."))

# 40. Dromy Lněný olej 500ml
new_supplements.append(supplement_stub(
    "dromy-lneny-olej-500-ml", "dromy-lneny-olej-500-ml",
    "Dromy Lněný olej 500ml", "OIL", BASE_DOPLNKY, "dromy-lneny-olej-500-ml",
))

# 41. Dromy Malpicoll 250 g
new_supplements.append(supplement_stub(
    "dromy-malpicoll-250-g", "dromy-malpicoll-250-g",
    "Dromy Malpicoll 250 g", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-malpicoll-250-g",
))

# 42. Dromy mast bylinná hojivá 500 ml
new_supplements.append(supplement_stub(
    "dromy-mast-bylinna-hojiva-500-ml", "dromy-mast-bylinna-hojiva-500-ml",
    "Dromy mast bylinná hojivá 500 ml", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-mast-bylinna-hojiva-500-ml",
    marketing_claims=[{"claimCs": "hojivá bylinná mast (zevní použití dle názvu) — funkční doplněk mimo základní BARF balancování", "backedByDeclaredNutrient": None}],
))

# 43. Dromy Osteo 450 g
new_supplements.append(supplement_stub(
    "dromy-osteo-450-g", "dromy-osteo-450-g",
    "Dromy Osteo 450 g", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-osteo-450-g",
    marketing_claims=[{"claimCs": "podpora kostí/kloubů (název 'Osteo') — cílený funkční doplněk", "backedByDeclaredNutrient": None}],
))

# 44. Dromy Parasitic 600 g
new_supplements.append(supplement_stub(
    "dromy-parasitic-600-g", "dromy-parasitic-600-g",
    "Dromy Parasitic 600 g", "THERAPEUTIC_SUPPLEMENT", BASE_DOPLNKY, "dromy-parasitic-600-g",
    marketing_claims=[{"claimCs": "antiparazitický doplněk (název 'Parasitic') — cílený funkční doplněk", "backedByDeclaredNutrient": None}],
))

# 45. Dromy Pupalkovy olej 200ml
new_supplements.append(supplement_stub(
    "dromy-pupalkovy-olej-200-ml", "dromy-pupalkovy-olej-200-ml",
    "Dromy Pupalkovy olej 200ml", "OIL", BASE_DOPLNKY, "dromy-pupalkovy-olej-200-ml",
))

# 46. Dromy Zvápenatělé mořské řasy 500 g
new_supplements.append(supplement_stub(
    "dromy-zvapenatele-morske-rasy-500-g", "dromy-zvapenatele-morske-rasy-500-g",
    "Dromy Zvápenatělé mořské řasy 500 g", "OTHER", BASE_DOPLNKY, "dromy-zvapenatele-morske-rasy-500-g",
    marketing_claims=[{"claimCs": "zvápenatělé mořské řasy — typicky přírodní zdroj vápníku, ale bez konkrétní deklarované hodnoty (%Ca) se nezapisuje do declared (R7)", "backedByDeclaredNutrient": None}],
))

SKIPPED_NOTES_A = [
    "Grafikon pro výběr optimálního preparátu Energy Vet (slug "
    "grafikon-pro-vyber-optimalniho-preparatu-energy-vet) — VYNECHÁNO jako Supplement. "
    "Není to produkt, je to marketingová/poradenská stránka výrobce Energy Vet "
    "(výběrový grafikon preparátů), nemá cenu ani vlastní SKU povahu.",
    "Dromy Konopný olej 500 ml (slug dromy-konopny-olej-500-ml) — pravděpodobná DUPLICITA "
    "s 'konopny-olej-pro-psy-500-ml' (Konopný olej pro psy 500 ml) výše — stejný objem, "
    "stejná surovina (konopný olej). Bez důkazu o odlišné značce/receptuře systém "
    "NEDOMÝŠLÍ rozdíl — zapsáno JEN JEDNOU (viz productId konopny-olej-pro-psy-500-ml), "
    "tahle druhá stránka NEBYLA přidána jako samostatný záznam.",
]

# =====================================================================
# ÚKOL B — PŘÍLOHY
# =====================================================================

# existing: TUT198 (Extrudovaná příloha s kelpu 1kg), TUT143 (Sušená zeleninová
# směs s rýží 1kg), TUT202 (Potravinářská křemelina 200g), NUT1 (Nutrin Barf
# Balancer 2500g)

new_supplements.append(supplement_stub(
    "zeleninovy-mix-300-g", "zeleninovy-mix-300-g",
    "Dromy Zeleninový mix 300g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "zeleninovy-mix-300-g",
))
new_supplements.append(supplement_stub(
    "barf-zeleninova-smes-500g", "barf-zeleninova-smes-500g",
    "Barf Zeleninová směs 500g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "barf-zeleninova-smes-500g",
))
new_supplements.append(supplement_stub(
    "barf-cervena-repa-500g", "barf-cervena-repa-500g",
    "Barf Červená Řepa 500g", "OTHER", BASE_PRILOHY, "barf-cervena-repa-500g",
    marketing_claims=[{"claimCs": "sušená/mražená červená řepa — zeleninová příloha", "backedByDeclaredNutrient": None}],
))
new_supplements.append(supplement_stub(
    "barf-mrkev-500g", "barf-mrkev-500g",
    "Barf Mrkev 500g", "OTHER", BASE_PRILOHY, "barf-mrkev-500g",
    marketing_claims=[{"claimCs": "sušená/mražená mrkev — zeleninová příloha", "backedByDeclaredNutrient": None}],
))

dup_notes.append(("TUT198", "Potvrzena existence stránky 'Barf Extrudovaná příloha pro BARF s kelpu 1kg' "
                   "(slug barf-extrudovana-priloha-pro-barf-s-kelpu-1kg) v crawler exportu 2026-09-09 — "
                   "odpovídá existujícímu TUT198 Extrudovaná příloha s kelpu 1kg. NEDUPLIKOVÁNO."))

dup_notes.append(("TUT143", "Potvrzena existence stránky 'Barf Sušená zeleninová směs s rýží 1kg' "
                   "(slug barf-susena-zeleninova-smes-s-ryzi-1kg) v crawler exportu 2026-09-09 — "
                   "odpovídá existujícímu TUT143 Sušená zeleninová směs s rýží 1 kg. NEDUPLIKOVÁNO."))

dup_notes.append(("TUT202", "Potvrzena existence stránky 'Barf Potravinářská křemelina 200g' "
                   "(slug barf-potravinarska-kremelina-200g) v crawler exportu 2026-09-09 — odpovídá "
                   "existujícímu TUT202 Potravinářská křemelina 200 g. NEDUPLIKOVÁNO."))

new_supplements.append(supplement_stub(
    "barf-instantni-ryzova-kase-1kg", "barf-instantni-ryzova-kase-1kg",
    "Barf Instantní rýžová kaše 1kg", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "barf-instantni-ryzova-kase-1kg",
))
new_supplements.append(supplement_stub(
    "barf-instantni-ryzova-kase-500g", "barf-instantni-ryzova-kase-500g",
    "Barf Instantní rýžová kaše 500g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "barf-instantni-ryzova-kase-500g",
))
new_supplements.append(supplement_stub(
    "barf-herbal", "barf-herbal",
    "Dromy BARF HERBAL 500g", "THERAPEUTIC_SUPPLEMENT", BASE_PRILOHY, "barf-herbal",
    marketing_claims=[{"claimCs": "bylinná příloha/doplněk (název 'HERBAL') — funkční doplněk, konkrétní bylinné složení scraper nezískal", "backedByDeclaredNutrient": None}],
))
new_supplements.append(supplement_stub(
    "dromy-bramborovy-mix-1000-g", "dromy-bramborovy-mix-1000-g",
    "Dromy Bramborový mix 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-bramborovy-mix-1000-g",
))
new_supplements.append(supplement_stub(
    "dromy-digestive-barf-300-g", "dromy-digestive-barf-300-g",
    "Dromy Digestive BARF 300 g", "THERAPEUTIC_SUPPLEMENT", BASE_PRILOHY, "dromy-digestive-barf-300-g",
    marketing_claims=[{"claimCs": "podpora trávení (název 'Digestive') — funkční doplněk mimo základní BARF balancování", "backedByDeclaredNutrient": None}],
))
new_supplements.append(supplement_stub(
    "dromy-extrudo-alfalfa-fibre-1000-g", "dromy-extrudo-alfalfa-fibre-1000-g",
    "Dromy Extrudo ALFALFA FIBRE 1000 g", "FIBER", BASE_PRILOHY, "dromy-extrudo-alfalfa-fibre-1000-g",
    marketing_claims=[{"claimCs": "vojtěška (alfalfa) — vlákninová extrudovaná příloha", "backedByDeclaredNutrient": None}],
))
new_supplements.append(supplement_stub(
    "dromy-extrudo-barf-900g", "dromy-extrudo-barf-900g",
    "Dromy Extrudo BARF 900g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-extrudo-barf-900g",
))
new_supplements.append(supplement_stub(
    "instantni-jahlovy-mix", "instantni-jahlovy-mix",
    "Dromy Jáhlový mix 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "instantni-jahlovy-mix",
))

dup_notes.append(("NUT1", "Potvrzena existence stránky 'Nutrin Barf Balancer 2500g' "
                   "(slug nutrin-barf-balancer-2500g) v crawler exportu 2026-09-09 — pravděpodobně "
                   "TENTÝŽ produkt jako existující NUT1 Nutrin Barf Balancer 2500 g, jen bez Tutani "
                   "kódu ve slugu. NEDUPLIKOVÁNO."))

new_supplements.append(supplement_stub(
    "instantni-kuskus-se-zeleninou", "instantni-kuskus-se-zeleninou",
    "Dromy Kuskus se zeleninou 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "instantni-kuskus-se-zeleninou",
))
new_supplements.append(supplement_stub(
    "dromy-morsky-mix-900-g", "dromy-morsky-mix-900-g",
    "Dromy Mořský mix 900 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-morsky-mix-900-g",
))
new_supplements.append(supplement_stub(
    "dromy-obilny-mix-se-zeleninou-1000-g", "dromy-obilny-mix-se-zeleninou-1000-g",
    "Dromy Obilný mix se zeleninou 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-obilny-mix-se-zeleninou-1000-g",
))
new_supplements.append(supplement_stub(
    "dromy-ovocny-mix-450-g", "dromy-ovocny-mix-450-g",
    "Dromy Ovocný mix 450 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-ovocny-mix-450-g",
))
new_supplements.append(supplement_stub(
    "dromy-pohankovy-mix-se-zeleninou-1000g", "dromy-pohankovy-mix-se-zeleninou-1000g",
    "Dromy Pohankový mix se zeleninou 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-pohankovy-mix-se-zeleninou-1000g",
))
new_supplements.append(supplement_stub(
    "dromy-ryzovy-mix-se-zeleninou-1000-g", "dromy-ryzovy-mix-se-zeleninou-1000-g",
    "Dromy Rýžový mix se zeleninou 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-ryzovy-mix-se-zeleninou-1000-g",
))
new_supplements.append(supplement_stub(
    "dromy-seminkovy-mix-600-g", "dromy-seminkovy-mix-600-g",
    "Dromy Semínkový mix 600 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-seminkovy-mix-600-g",
))
new_supplements.append(supplement_stub(
    "dromy-vlockovy-mix-1000-g", "dromy-vlockovy-mix-1000-g",
    "Dromy Vločkový mix 1000 g", "EXTRUDED_SIDE_DISH", BASE_PRILOHY, "dromy-vlockovy-mix-1000-g",
))

# =====================================================================
# ÚKOL C — BARF NA CESTY -> tutani-products.json jako TutaniProduct
# =====================================================================

new_products = []
product_dup_notes = []  # (existing_code_in_supplements_or_products, note)

# 1. MAX deluxe SRNEC,DANĚK,JELEN 800g — no existing dup, SINGLE_INGREDIENT-ish (3 species mixed = COMPOSITE PARTIAL)
new_products.append(product_stub(
    "max-deluxe-srnec-danek-jelen-800g", "max-deluxe-srnec-danek-jelen-800g",
    "MAX deluxe SRNEC,DANĚK,JELEN 800g",
    composition=[
        partial_ingredient("srnec/daněk/jelen (zvěřina, druh v rámci balení nerozlišen)",
                            "GAME", None,
                            "Název uvádí tři druhy zvěřiny (srnec, daněk, jelen) bez podílu mezi nimi — "
                            "PARTIAL, poměr NEVYMÝŠLEN (R7)."),
    ],
    kind="COMPOSITE",
))

# 2. MAX deluxe 3/4 KUŘE s drůbežími žaludky 1200g
new_products.append(product_stub(
    "max-deluxe-3-4-kure-s-drubezimi-zaludky-1200g", "max-deluxe-3-4-kure-s-drubezimi-zaludky-1200g",
    "MAX deluxe 3/4 KUŘE s drůbežími žaludky 1200g",
    composition=[
        partial_ingredient("3/4 kuřete (celé kuře bez čtvrtiny, přesné části neuvedeny)",
                            "CHICKEN", None,
                            "'3/4 kuře' — bez rozpisu na svalovinu/kosti/kůži, PARTIAL."),
        partial_ingredient("drůbeží žaludky", "CHICKEN", "MUSCLE_ORGAN",
                            "'s drůbežími žaludky' — druh drůbeže u žaludků samotných neupřesněn, "
                            "odvozen z kontextu (kuřecí balení), bez podílu — PARTIAL."),
    ],
    kind="COMPOSITE",
))

# 3. MAX deluxe 3/4 KUŘETE 1200g — DUPLICITA s existujícím "07 Barf MAX deluxe 3/4 kuřete"
product_dup_notes.append(("07", "Potvrzena existence stránky 'MAX deluxe 3/4 KUŘETE 1200g' "
                           "(slug max-deluxe-3-4-kurete-1200g, kategorie barf-na-cesty) v crawler "
                           "exportu 2026-09-09 — odpovídá existujícímu záznamu code=07 '07 Barf MAX "
                           "deluxe 3/4 kuřete', který je ALE aktuálně uložen v tutani-supplements.json "
                           "jako Supplement/OTHER (ne v tutani-products.json jako TutaniProduct) — "
                           "otevřený nález z předchozí session (BARF na cesty patří spíš do "
                           "TutaniProduct, dosud nepřesunuto, viz noteCs u code=07 v supplements.json). "
                           "NEDUPLIKOVÁNO, žádný nový záznam nepřidán ani v products.json, ani "
                           "v supplements.json."))

# 4. MAX deluxe KOSTKY LIBOVÉ SVALOVINY 400g — možná duplicita s existujícím 2559
product_dup_notes.append(("2559", "Potvrzena existence stránky 'MAX deluxe KOSTKY LIBOVÉ SVALOVINY 400g' "
                           "(slug max-deluxe-kostky-libove-svaloviny-400g, kategorie barf-na-cesty) "
                           "v crawler exportu 2026-09-09 — odpovídá existujícímu záznamu code=2559 "
                           "'MAX deluxe kostky libové svaloviny 400 g' (uloženo v tutani-supplements.json "
                           "jako Supplement/OTHER, stejná otevřená otázka jako u code=07 výše). "
                           "NEDUPLIKOVÁNO."))

# 5. MAX deluxe KOSTKY HOVĚZÍ SVALOVINY 800g — no existing dup found
new_products.append(product_stub(
    "max-deluxe-kostky-hovezi-svaloviny-800g", "max-deluxe-kostky-hovezi-svaloviny-800g",
    "MAX deluxe KOSTKY HOVĚZÍ SVALOVINY 800g",
    composition=[
        partial_ingredient("hovězí svalovina", "BEEF", "MUSCLE",
                            "'kostky hovězí svaloviny' — název naznačuje jednu surovinu (hovězí "
                            "svalovina), ale scraper nepotvrdil explicitní '100 %' v textu, proto "
                            "kind=COMPOSITE/PARTIAL, ne SINGLE_INGREDIENT s percentage 100 (R7)."),
    ],
    kind="COMPOSITE",
))

# 6. MAX deluxe KOSTKY HOVĚZÍ SVALOVINY 400g
new_products.append(product_stub(
    "max-deluxe-kostky-hovezi-svaloviny-400g", "max-deluxe-kostky-hovezi-svaloviny-400g",
    "MAX deluxe KOSTKY HOVĚZÍ SVALOVINY 400g",
    composition=[
        partial_ingredient("hovězí svalovina", "BEEF", "MUSCLE",
                            "'kostky hovězí svaloviny' — stejné odůvodnění jako 800g varianta výše, "
                            "bez explicitního '100 %' proto PARTIAL."),
    ],
    kind="COMPOSITE",
))

# 7. MAX deluxe 1 KUŘE 1200g
new_products.append(product_stub(
    "max-deluxe-1-kure-1200g", "max-deluxe-1-kure-1200g",
    "MAX deluxe 1 KUŘE 1200g",
    composition=[
        partial_ingredient("celé kuře (1 ks, přesné části neuvedeny)", "CHICKEN", None,
                            "'1 KUŘE' — celé kuře jako jedna jednotka, bez rozpisu na "
                            "svalovinu/kosti/kůži/droby, PARTIAL."),
    ],
    kind="COMPOSITE",
))

# 8. MAX deluxe KOSTKY LIBOVÉ SVALOVINY s dršťkami 800g — možná duplicita s existujícím 9493
product_dup_notes.append(("9493", "Potvrzena existence stránky 'MAX deluxe KOSTKY LIBOVÉ SVALOVINY "
                           "s dršťkami 800g' (slug max-deluxe-kostky-libove-svaloviny-s-drstkami-800g-2, "
                           "kategorie barf-na-cesty) v crawler exportu 2026-09-09 — odpovídá existujícímu "
                           "záznamu code=9493 'MAX deluxe kostky libové svaloviny s dršťkami 800 g' "
                           "(uloženo v tutani-supplements.json jako Supplement/OTHER, stejná otevřená "
                           "otázka jako u code=07/2559). NEDUPLIKOVÁNO."))

# 9. MAX deluxe 3/4 KUŘE s dršťkami 1200g — možná duplicita s existujícím 2553
product_dup_notes.append(("2553", "Potvrzena existence stránky 'MAX deluxe 3/4 KUŘE s dršťkami 1200g' "
                           "(slug max-deluxe-3-4-kure-s-drstkami-1200g, kategorie barf-na-cesty) "
                           "v crawler exportu 2026-09-09 — odpovídá existujícímu záznamu code=2553 "
                           "'MAX deluxe 3/4 kuře s dršťkami 1200 g' (uloženo v tutani-supplements.json "
                           "jako Supplement/OTHER, stejná otevřená otázka jako u code=07/2559/9493). "
                           "NEDUPLIKOVÁNO."))


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def bump_patch(version_str):
    parts = version_str.split(".")
    parts[-1] = str(int(parts[-1]) + 1)
    return ".".join(parts)


def append_note_to_existing(record, extra_note):
    ev = record["evidence"]
    existing = ev.get("noteCs", "")
    marker = "[POTVRZENO 2026-09-09 crawler]"
    if marker in existing:
        return False  # already annotated, avoid duplicate note growth on reruns
    sep = " " if existing else ""
    ev["noteCs"] = existing + sep + f"{marker} {extra_note}"
    return True


def write_supplements_with_retry(max_attempts=4, wait_seconds=10):
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            data = load_json(SUPP_PATH)
            existing_codes = {s["code"] for s in data["supplements"]}

            added = 0
            for stub in new_supplements:
                if stub["code"] in existing_codes:
                    print(f"  SKIP (already present, race-safe re-run): {stub['code']}")
                    continue
                data["supplements"].append(stub)
                existing_codes.add(stub["code"])
                added += 1

            by_code = {s["code"]: s for s in data["supplements"]}
            annotated = 0
            for code, note in dup_notes:
                if code not in by_code:
                    print(f"  WARN: dup-note target code {code} not found in dataset!")
                    continue
                if append_note_to_existing(by_code[code], note):
                    annotated += 1

            data["sourceVersion"] = bump_patch(data["sourceVersion"])
            data["updatedAt"] = TODAY
            src_note = (
                f"[{TODAY}] +{added} inventárních záznamů (doplňky+přílohy) z "
                f"tutani_full_catalog_2026-09-09.json crawler exportu — jen potvrzení "
                f"existence (název+URL), ŽÁDNÁ nová composition/cena data. "
                f"{annotated} existujících položek anotováno poznámkou o potvrzené duplicitě."
            )
            data["note"] = (data.get("note", "") + " | " + src_note).strip(" |")

            save_json(SUPP_PATH, data)
            return added, annotated
        except (json.JSONDecodeError, KeyError, FileNotFoundError) as e:
            last_err = e
            print(f"  Attempt {attempt} failed ({e}); waiting {wait_seconds}s and retrying "
                  f"(possible race with parallel agent)...")
            time.sleep(wait_seconds)
    raise RuntimeError(f"Failed to write supplements after {max_attempts} attempts: {last_err}")


def write_products_with_retry(max_attempts=4, wait_seconds=10):
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            data = load_json(PROD_PATH)
            existing_codes = {p["code"] for p in data["products"]}

            added = 0
            for stub in new_products:
                if stub["code"] in existing_codes:
                    print(f"  SKIP (already present, race-safe re-run): {stub['code']}")
                    continue
                data["products"].append(stub)
                existing_codes.add(stub["code"])
                added += 1

            data["sourceVersion"] = bump_patch(data["sourceVersion"])
            data["updatedAt"] = TODAY
            src_note = (
                f"[{TODAY}] +{added} inventárních záznamů (BARF na cesty, MAX deluxe) z "
                f"tutani_full_catalog_2026-09-09.json crawler exportu — jen potvrzení "
                f"existence (název+URL), composition je PARTIAL bez procent, ŽÁDNÁ nová "
                f"cena data. {len(product_dup_notes)} položek vyhodnoceno jako duplicita "
                f"stávajících záznamů (aktuálně uložených v tutani-supplements.json, "
                f"otevřený nález k přesunu do TutaniProduct)."
            )
            data["note"] = (data.get("note", "") + " | " + src_note).strip(" |")

            save_json(PROD_PATH, data)
            return added
        except (json.JSONDecodeError, KeyError, FileNotFoundError) as e:
            last_err = e
            print(f"  Attempt {attempt} failed ({e}); waiting {wait_seconds}s and retrying...")
            time.sleep(wait_seconds)
    raise RuntimeError(f"Failed to write products after {max_attempts} attempts: {last_err}")


def main():
    print("=== Writing tutani-supplements.json (doplňky + přílohy) ===")
    added_supp, annotated_supp = write_supplements_with_retry()
    print(f"  Added: {added_supp} new supplements, {annotated_supp} existing items annotated")

    print("=== Writing tutani-products.json (BARF na cesty) ===")
    added_prod = write_products_with_retry()
    print(f"  Added: {added_prod} new products")

    print("\n=== Skipped items (not products / true duplicates in task A) ===")
    for n in SKIPPED_NOTES_A:
        print(" -", n)

    print("\n=== Duplicate resolution summary (task A+B, annotated existing supplements) ===")
    for code, note in dup_notes:
        print(f" - {code}: {note[:90]}...")

    print("\n=== Duplicate resolution summary (task C, annotated via note only, no new record) ===")
    for code, note in product_dup_notes:
        print(f" - {code}: {note[:90]}...")

    print(f"\nTOTAL new supplements added: {added_supp}")
    print(f"TOTAL new products added: {added_prod}")
    print(f"TOTAL duplicates resolved (A+B): {len(dup_notes)}")
    print(f"TOTAL duplicates resolved (C): {len(product_dup_notes)}")
    print(f"TOTAL skipped (not a product): {len(SKIPPED_NOTES_A) - 1}")  # grafikon only; konopny olej counted as dup-like


if __name__ == "__main__":
    main()
