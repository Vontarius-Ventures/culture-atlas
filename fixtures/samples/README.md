# Sample discovery items

The first-visit feed uses the reviewed sample items defined in `packages/domain/src/feed/samples.ts` (kept in code so the server can upsert them without file access). They are public, labeled "Example result" in the UI, and never presented as provider results.

Review rules applied to every entry:

- Short factual text only: title, year, creator or a neutral one-line description.
- One real public reference page per item (`destination_url`, Wikipedia).
- No claimed relationships between samples. "Related" samples on an item page are simply other examples from different categories.
- No bundled images. Cards use the text treatment until licensed images are added under `apps/web/public/samples/` with their source and license recorded in this file.

Before release, have a person re-check each description against its reference page.

| Slug | Kind | Reference |
| --- | --- | --- |
| film-in-the-mood-for-love | film | https://en.wikipedia.org/wiki/In_the_Mood_for_Love |
| artist-nina-simone | artist | https://en.wikipedia.org/wiki/Nina_Simone |
| style-breton-shirt | style | https://en.wikipedia.org/wiki/Breton_shirt |
| food-cacio-e-pepe | food | https://en.wikipedia.org/wiki/Cacio_e_pepe |
| film-playtime | film | https://en.wikipedia.org/wiki/Playtime |
| artist-fela-kuti | artist | https://en.wikipedia.org/wiki/Fela_Kuti |
| brand-marimekko | brand | https://en.wikipedia.org/wiki/Marimekko |
| food-shakshouka | food | https://en.wikipedia.org/wiki/Shakshouka |
| reference-bauhaus | reference | https://en.wikipedia.org/wiki/Bauhaus |
| film-paris-texas | film | https://en.wikipedia.org/wiki/Paris,_Texas_(film) |
| artist-astrud-gilberto | artist | https://en.wikipedia.org/wiki/Astrud_Gilberto |
| style-mod | style | https://en.wikipedia.org/wiki/Mod_(subculture) |
| food-okonomiyaki | food | https://en.wikipedia.org/wiki/Okonomiyaki |
| film-amelie | film | https://en.wikipedia.org/wiki/Am%C3%A9lie |
| artist-air | artist | https://en.wikipedia.org/wiki/Air_(French_band) |
| style-workwear | style | https://en.wikipedia.org/wiki/Workwear |
| food-pastel-de-nata | food | https://en.wikipedia.org/wiki/Pastel_de_nata |
| reference-memphis-group | reference | https://en.wikipedia.org/wiki/Memphis_Group |
