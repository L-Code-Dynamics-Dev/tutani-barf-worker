#!/usr/bin/env python3
"""Vygeneruje src/infrastructure/pdf/fonts.generated.ts z assets/fonts/*.subset.ttf.

Fonty jsou OFL (Barlow Condensed, Source Sans 3), ořezané na latinku CZ/SK
přes `pyftsubset` (fonttools). Spustit po změně fontu:
    python3 scripts/build-pdf-fonts.py
"""
import base64, hashlib, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
fonts = {
    'BARLOW_EXTRABOLD': 'BarlowCondensed-ExtraBold.subset.ttf',
    'BARLOW_BOLD': 'BarlowCondensed-Bold.subset.ttf',
    'SOURCE_SANS_REGULAR': 'SourceSans3-Regular.subset.ttf',
    'SOURCE_SANS_SEMIBOLD': 'SourceSans3-Semibold.subset.ttf',
}
out = ['/**', ' * VYGENEROVÁNO scripts/build-pdf-fonts.py — neupravovat ručně.', ' *',
       ' * Fonty pod licencí SIL OFL 1.1 (assets/fonts/OFL-*), ořezané na latinku CZ/SK.', ' */', '']
for const, name in fonts.items():
    data = (root / 'assets' / 'fonts' / name).read_bytes()
    out.append(f'/** {name} · {len(data)} B · sha256 {hashlib.sha256(data).hexdigest()[:16]} */')
    out.append(f"export const {const} = '{base64.b64encode(data).decode()}';")
    out.append('')
(root / 'src' / 'infrastructure' / 'pdf' / 'fonts.generated.ts').write_text('\n'.join(out))
print('OK', len(fonts))
