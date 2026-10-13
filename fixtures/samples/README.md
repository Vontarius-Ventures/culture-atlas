# Sample discovery items

The first-visit feed uses the reviewed sample items defined in `packages/domain/src/feed/samples.ts` (kept in code so the server can upsert them without file access). They are public, labeled "Example result" in the UI, and never presented as provider results.

Review rules applied to every entry:

- Short factual text only: title, year, creator or a neutral one-line description.
- One real public reference page per item (`destination_url`, Wikipedia).
- No claimed relationships between samples. "Related" samples on an item page are simply other examples from different categories.
- Images only where a project-original illustration (`apps/web/public/samples/feed/`, licenses in `fixtures/images/LICENSES.md`) shows the subject itself. Films and artists never get a stand-in picture; those cards use the text treatment.

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
| food-sesame-noodles | food | https://en.wikipedia.org/wiki/Sesame_noodles (image: `samples/feed/sesame-noodles.jpg`) |
| style-linen | style | https://en.wikipedia.org/wiki/Linen (image: `samples/feed/linen-days.jpg`) |
| reference-tetsubin | reference | https://en.wikipedia.org/wiki/Tetsubin (image: `samples/feed/tea-rituals.jpg`) |
| reference-phonograph-record | reference | https://en.wikipedia.org/wiki/Phonograph_record (image: `samples/feed/sunday-listening.jpg`) |
| film-le-mans | film | https://en.wikipedia.org/wiki/Le_Mans_(film) (example: outfit) |
| film-grand-prix | film | https://en.wikipedia.org/wiki/Grand_Prix_(1966_film) (example: outfit) |
| film-tokyo-story | film | https://en.wikipedia.org/wiki/Tokyo_Story (example: room) |
| artist-ryuichi-sakamoto | artist | https://en.wikipedia.org/wiki/Ryuichi_Sakamoto (example: room) |

The last four rows, plus some of the earlier ones, are also the reviewed picks of the example replays in `fixtures/examples/` (see its README).
