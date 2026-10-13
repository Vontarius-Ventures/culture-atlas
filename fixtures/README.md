# Fixtures

Recorded-shape fixtures for contract tests and labeled replays. Nothing here may be presented as live provider data: anything served from a fixture is marked `is_replay` / `origin: 'replay'` or `'sample'` and the UI labels it "Example result".

| Directory | Contents | Owner |
| --- | --- | --- |
| `qloo/` | Response shapes for `/search`, `/v2/tags`, `/v2/insights` (with explainability), `/v2/trending`, `/trends/entity`, plus 401/404/429 error bodies. Built from the documented API shapes until a key is available; replace with sanitized real recordings once probes run. | Qloo adapter |
| `vlm/` | Structured `VlmAnalysis` outputs for clear, blurred, ambiguous, multicultural, logo-free and adversarial-text images. | VLM adapter / pipeline |
| `research/` | Wikipedia REST summaries (real URLs) and extracted claims. | Research adapter |
| `samples/` | The three supplied example inputs (outfit, room, café/table) with license notes and independently reviewed references. Images themselves live in `apps/web/public/samples/`. | Discovery feed |
| `relay/` | World Sensor relay asset list/content pages for the mock relay. | Sensor bridge |

Rules: no secrets, no personal data, no full copyrighted articles; record the source URL and license for every image.
