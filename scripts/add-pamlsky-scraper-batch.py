#!/usr/bin/env python3
"""
Přidá 57 pamlskových položek (kategorie "pamlsky") do
tenants/tutani/rules/tutani-supplements.json.

ZDROJ: scraper export potvrzující EXISTENCI produktů (URL slug + název),
ale BEZ composition/ceny/Tutani kódu. R7 zásada (PROGRESS_LOG.md):
nedomýšlet declared/cenu, kterou zdroj neuvádí.

- code = slugified poslední segment URL (skutečný Tutani kód neznámý)
- declared = [] (žádná čísla k dispozici)
- evidence.confidence = 'ESTIMATED', noteCs vysvětluje slug-placeholder
- ingredientList.itemsCs = suroviny JASNĚ vyjmenované v názvu (bez %)
- packGrams parsováno z názvu, jen když jednoznačné (kusy -> None)

Idempotentní: existující kódy v datasetu se přeskočí, neduplikuje se.
"""
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATASET_PATH = REPO / "tenants" / "tutani" / "rules" / "tutani-supplements.json"

BASE_URL = "https://obchod.tutani.cz/pamlsky/"
SOURCE_DATE = "2026-09-09"

# (slug, nameCs)
RAW_ITEMS = [
    ("barf-usakova-ouska-susena-100g", "Barf Ušákova ouška sušená 100g"),
    ("barf-rewards-dog-hovezi-s-boruvkami-a-tymianem-80-g", "Barf Rewards Dog hovězí s borůvkami a tymiánem 80 g"),
    ("barf-susene-kureci-paraty-100g", "Barf Sušené kuřecí pařáty 100g"),
    ("barf-susena-veprova-zaouska-10ks", "Barf Sušená vepřová zaouška 10ks"),
    ("barf-hovezi-ucho-susene-3ks", "Barf Hovězí ucho sušené 3ks"),
    ("susene-plice", "Sušené plíce 80g"),
    ("strivkove-makarony", "Střívkové makarony 12cm-8ks, 25cm-6ks"),
    ("barf-veprova-noha-susena-1ks", "Barf Vepřová noha sušená 1ks"),
    ("barf-susena-veprova-zaouska-5ks", "Barf Sušená vepřová zaouška 5ks"),
    ("dried-fish-susena-ryba-100g", "Dried Fish - sušená ryba 100g"),
    ("barf-hovezi-mulec-suseny-200-g", "Barf Hovězí mulec sušený 200 g"),
    ("barf-rewards-cat-kureci-se-santou-a-brusinkou-80-g", "Barf REWARDS Cat kuřecí se šantou a brusinkou 80 g"),
    ("barf-rewards-dog-kureci-s-mrkvi-a-bazalkou-80-g", "Barf Rewards Dog Kuřecí s mrkví a bazalkou 80 g"),
    ("barf-rewards-dog-veprove-s-dyni-a-rozmarynem-80-g", "Barf Rewards Dog vepřové s dýní a rozmarýnem 80 g"),
    ("barf-usakovo-ousko-susene-1ks", "Barf Ušákovo ouško sušené 1ks"),
    ("barf-veprova-chrupavka-z-lopatky-susena-100g", "Barf Vepřová chrupavka z lopatky sušená 100g"),
    ("barf-veprova-kost-susena-1ks", "Barf Vepřová kost sušená 1ks"),
    ("filety-z-hoveziho-masa-250g", "Filety z hovězího masa 250g"),
    ("hranolky-lososove-100-g", "Hranolky lososové -100g"),
    ("kolecko-kachni-250g", "Kolečko kachní-250g"),
    ("kost-kalciova-obalena-kachnim-masem-250g", "Kost kalciová obalená kachním masem-250g"),
    ("kosticky-kureci-s-krevetkami-mini-100g", "Kostičky kuřecí s krevetkami-mini 100g"),
    ("kosticky-mix-500g", "Kostičky Mix 500g"),
    ("kostky-kachni-s-treskou-100g", "Kostky kachní s treskou 100g"),
    ("kousky-hovezi-100-g", "Kousky hovězí -100g"),
    ("platek-kachni-mekky-100g", "Plátek kachní měkký-100g"),
    ("platek-kachni-mekky-250g", "Plátek kachní měkký-250g"),
    ("platek-kachni-suseny-100g", "Plátek kachní sušený -100g"),
    ("platek-kachni-suseny-250g", "Plátek kachní sušený -250g"),
    ("prouzek-kachni-mekky-12cm-100g", "Proužek kachní měkký 12cm 100g"),
    ("prouzek-kachni-mini-100g", "Proužek kachní mini-100g"),
    ("prouzek-kureci-mekky-100g", "Proužek kuřecí měkký-100g"),
    ("rolka-hovezi-250g", "Rolka hovězí 250g"),
    ("rolka-kachna-treska-100g", "Rolka kachna treska 100g"),
    ("rolka-kralik-treska-100g", "Rolka králík treska 100g"),
    ("rolka-sushi-kachni-100g", "Rolka sushi kachní 100g"),
    ("rolka-sushi-kachni-250g", "Rolka sushi kachní 250g"),
    ("rolka-sushi-kralici-jatra-100g-2", "Rolka sushi králičí játra-100g"),
    ("rolka-sushi-kralici-jatra-250g", "Rolka sushi králičí játra 250g"),
    ("rolka-sushi-losos-treska-100g", "Rolka sushi losos/treska 100g"),
    ("sendvic-hovezi-s-treskou-250g", "Sendvič hovězí s treskou-250g"),
    ("sendvic-jehneci-s-treskou-250g", "Sendvič jehněčí s treskou 250g"),
    ("sendvic-kachna-mini-100g", "Sendvič kachna mini 100g"),
    ("sendvic-kachna-treska-rolovany-250g", "Sendvič kachna treska rolovaný-250g"),
    ("sendvic-kralici-jatra-treska-mini-100g", "Sendvič králičí játra treska mini 100g"),
    ("sendvic-losos-treska-250g", "Sendvič losos treska 250g"),
    ("susenky-s-matou-500g", "Sušenky s mátou 500g"),
    ("tycinka-jehneci-mini-100g", "Tyčinka jehněčí mini-100g"),
    ("tycinka-kureci-1-cm-100g", "Tyčinka kuřecí 1 cm-100g"),
    ("tycinka-lososove-mini-100g", "Tyčinka lososové mini-100g"),
    ("tycinka-s-lososem-mini-100g", "Tyčinka s lososem mini-100g"),
    ("tycinka-tunakova-1-cm-100g", "Tyčinka tuňáková 1 cm-100g"),
    ("uzel-kureci-mekky-mini-100g", "Uzel kuřecí měkký mini-100g"),
    ("zavitek-jehneci-s-treskou-250g", "Závitek jehněčí s treskou 250g"),
    ("zavitek-kachni-s-treskou-100g", "Závitek kachní s treskou 100g"),
    ("zavitek-kureci-s-treskou-250g", "Závitek kuřecí s treskou -250g"),
    ("zavitek-kureci-s-treskou-100g", "Závitek kuřecí s treskou 100g"),
]

# Mapování česky psaných surovin -> kanonický zápis pro ingredientList.
# Jen tam, kde název JEDNOZNAČNĚ vyjmenovává konkrétní suroviny.
INGREDIENT_TOKENS = [
    ("krevetkami", "krevety"),
    ("borůvkami", "borůvky"),
    ("tymiánem", "tymián"),
    ("mrkví", "mrkev"),
    ("bazalkou", "bazalka"),
    ("dýní", "dýně"),
    ("rozmarýnem", "rozmarýn"),
    ("šantou", "šanta"),
    ("brusinkou", "brusinka"),
    ("mátou", "máta"),
    ("treska", "treska"),
    ("treskou", "treska"),
    ("losos", "losos"),
    ("hovězí", "hovězí maso"),
    ("hovězího masa", "hovězí maso"),
    ("kuřecí", "kuřecí maso"),
    ("kachní", "kachní maso"),
    ("kachna", "kachní maso"),
    ("králičí", "králičí maso"),
    ("králík", "králičí maso"),
    ("jehněčí", "jehněčí maso"),
    ("jatra", "játra"),
    ("plíce", "plíce"),
    ("tuňáková", "tuňák"),
    ("tuňák", "tuňák"),
]


def slugify_ingredient_hint(name_cs: str) -> list[str]:
    """Vytáhne suroviny z názvu, JEN pokud jsou explicitně pojmenované.
    Konzervativní: bere jen shody z INGREDIENT_TOKENS, žádné dohady."""
    found = []
    lower = name_cs.lower()
    for token, canon in INGREDIENT_TOKENS:
        if token.lower() in lower and canon not in found:
            found.append(canon)
    return found


def parse_pack_grams(name_cs: str) -> int | None:
    """Gramáž z názvu, jen jednoznačná (Xg / X g). Kusy/cm -> None."""
    # "12cm-8ks, 25cm-6ks" apod. -> žádná jednoznačná gramáž
    if re.search(r"\bks\b", name_cs, re.IGNORECASE) and not re.search(r"\d+\s*g\b", name_cs):
        return None
    m = re.search(r"(\d+)\s*g\b", name_cs, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return None


def has_explicit_pieces_only(name_cs: str) -> bool:
    return bool(re.search(r"\d+\s*ks\b", name_cs, re.IGNORECASE)) and not re.search(r"\d+\s*g\b", name_cs, re.IGNORECASE)


def build_supplement(slug: str, name_cs: str) -> dict:
    code = slug
    url = BASE_URL + slug
    pack_grams = parse_pack_grams(name_cs)
    ingredients = slugify_ingredient_hint(name_cs)

    ingredient_list = None
    if ingredients:
        ingredient_list = {
            "itemsCs": ingredients,
            "orderedByQuantity": False,
        }

    note = (
        "Scraper export potvrzuje existenci produktu (URL slug + název "
        "z kategorie 'pamlsky'), ale NEZÍSKAL Tutani kód, composition ani "
        "cenu. `code` je URL-slug placeholder, NE skutečný Tutani kód "
        "(ten zatím neznámý) — nezaměňovat s TUT-formátem u ostatních "
        "položek. `declared: []` a `priceWithVatCzk: null`, protože zdroj "
        "žádná čísla neuvádí (R7: nedopočítávat)."
    )

    return {
        "productId": code,
        "code": code,
        "nameCs": name_cs,
        "brand": None,
        "category": "TREAT",
        "declared": [],
        "derivedPer100g": [],
        "marketingClaims": [],
        "ingredientList": ingredient_list,
        "mineralAssay": None,
        "dosageInstructionCs": None,
        "packGrams": pack_grams,
        "priceWithVatCzk": None,
        "availability": "UNKNOWN",
        "url": url,
        "evidence": {
            "source": "TUTANI_PRODUCT_PAGE",
            "sourceDate": SOURCE_DATE,
            "confidence": "ESTIMATED",
            "noteCs": note,
        },
        "updatedAt": SOURCE_DATE,
    }


def bump_patch(version: str) -> str:
    parts = version.split(".")
    if len(parts) == 2:
        major, minor = parts
        return f"{major}.{int(minor) + 1}"
    # fallback pro major.minor.patch
    *head, patch = parts
    return ".".join(head + [str(int(patch) + 1)])


def main():
    with open(DATASET_PATH, "r", encoding="utf-8") as f:
        dataset = json.load(f)

    existing_codes = {s["code"] for s in dataset["supplements"]}

    added = []
    skipped = []
    for slug, name_cs in RAW_ITEMS:
        if slug in existing_codes:
            skipped.append(slug)
            continue
        added.append(build_supplement(slug, name_cs))
        existing_codes.add(slug)

    dataset["supplements"].extend(added)

    old_version = dataset.get("sourceVersion", "0.0")
    new_version = bump_patch(str(old_version))
    dataset["sourceVersion"] = new_version

    note_addendum = (
        f" | {SOURCE_DATE}: +{len(added)} pamlsky (kategorie 'pamlsky') "
        "ze scraper URL-listu bez composition/ceny/kódu — code=URL-slug "
        "placeholder, declared=[], confidence=ESTIMATED (R7)."
    )
    dataset["note"] = dataset.get("note", "") + note_addendum

    with open(DATASET_PATH, "w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Added: {len(added)}")
    print(f"Skipped (already existed): {len(skipped)}")
    if skipped:
        print("Skipped codes:", skipped)
    print(f"sourceVersion: {old_version} -> {new_version}")
    print(f"Total supplements now: {len(dataset['supplements'])}")


if __name__ == "__main__":
    main()
