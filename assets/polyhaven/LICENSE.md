# Poly Haven — CC0

Все файлы в этой папке взяты с https://polyhaven.com и распространяются по лицензии
**CC0 1.0** (общественное достояние): можно использовать и распространять без ограничений.

| Файл | Ассет | Страница |
|---|---|---|
| `monastery_stone_floor/*` | Monastery Stone Floor (автор Amal Kumar) | https://polyhaven.com/a/monastery_stone_floor |
| `dark_rock_02/*` | Dark Rock 02 | https://polyhaven.com/a/dark_rock_02 |

Карты: `diff` — цвет, `nor_gl` — нормали (OpenGL), `arm` — AO / шероховатость / металличность (R/G/B).
Исходники 1K JPG пересжаты в WebP (`tools/compress_assets.mjs`): `diff` — 1024, `nor_gl` и `arm` — 512.

Где используются: `dark_rock_02` — плиты пола арены, колонны, арки и блоки; `monastery_stone_floor` —
земля плато за ареной (`modules/world.js`, `loadPBR`).
