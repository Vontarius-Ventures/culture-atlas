# Onboarding catalog

`catalog.json` is the pre-resolved catalog behind the taste questionnaire (spec amendment 2.2, screen 14): 12 images and 8 chips for each of Wear, Play, Watch and Eat. Every entry holds real Qloo tag ids with the date they were retrieved. It is what keeps onboarding completable while Qloo is unavailable.

- **Built by** `pnpm onboarding:catalog` (`scripts/build-onboarding-catalog.ts`) from live `GET /v2/tags` lookups. A label is kept only when Qloo returns a tag with exactly that name and a tag type the category accepts. Nothing is filled in by hand.
- **Request discipline:** at most 3 requests in flight, a pause between requests, and a hard cap of 40 Qloo requests per run (retries included). A rerun reuses unchanged entries, so it only spends requests on labels that changed or never resolved. Use `--refresh` to resolve everything again.
- **Images** are project-owned mock photos in `apps/web/public/samples/onboarding` (generated for the project at the owner's request; see `fixtures/images/LICENSES.md`). Each one stands for 1–3 tags; a pick of an image counts once. Changing an image's URL changes `catalog_version`.
- **Refresh:** run it again when Qloo's taxonomy changes or when you edit the labels in `scripts/onboarding-catalog-lib.ts`, then commit the result. The `catalog_version` changes whenever items or ids change and is stored on each account's onboarding state.
- Without `QLOO_API_KEY` the script exits without writing anything. In a worktree without `.env`, pass `--env-file /path/to/.env`.

First build: October 18, 2026, in three runs (40, 8 and 2 requests). The first run lost requests to Qloo 429 throttling. Labels without an exact tag of an accepted type (Workwear, Streetwear, Soul, Linen, Arthouse) were replaced by Bohemian, Preppy, Art deco, Classical, Scandinavian and Art House.

Checked October 19, 2026 (build plan phase 4): the catalog was complete for the current labels, and a run without `--refresh` needed 0 Qloo requests. It was not rebuilt, so the stored ids were not re-checked against live Qloo that day.
