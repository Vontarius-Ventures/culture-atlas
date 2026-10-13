# Qloo feasibility for a captured-style analysis app

Research checked October 11, 2026. Documentation review only; no authenticated API calls were made. The live docs site was unavailable through browsing, so this uses [Qloo's official documentation repository](https://github.com/qloo/docs-public), which identifies itself as the public mirror of the docs and OpenAPI specification.

## Conclusion

The proposed pipeline is feasible as **capture → VLM description → resolved Qloo entities/tags → cultural fit and momentum → actionable content recommendations**. Qloo can provide documented trend data as well as taste affinities. A calibrated probability that a specific post will go viral is an additional modeling task, not an output established by these APIs.

## Concrete integration

| Step | Documented API | App use |
|---|---|---|
| Resolve visible brand/cultural references | `GET /search`, with `query` and optional `types` | Resolve VLM candidates to canonical entity IDs; retain uncertain/unmatched observations. |
| Resolve style vocabulary | `GET /v2/tags`, with `filter.query` and exact `filter.tag.types` | Look up real taxonomy entries instead of inventing Qloo tag IDs. |
| Choose audiences | `GET /v2/audiences` | Retrieve audience IDs and categories for explicit target profiles. |
| Analyze cultural fit | `/v2/insights` | Use entity/tag interest signals, audience signals, and optional location; return relevant brands/artists and explain which inputs contributed. |
| Analyze demographics | `/v2/insights?filter.type=urn:demographics` | Return demographic affinities from an entity or tag signal. |
| Measure entity momentum | `GET /v2/trending` | Supply entity IDs, category, and date range for trend analysis. |
| Retrieve entity trend history | `GET /trends/entity` | Supply `entity_id` and `start_date`, optionally `end_date`. |

Lookup sources: [entity search](https://github.com/qloo/docs-public/blob/main/reference/get-search.md), [tags](https://github.com/qloo/docs-public/blob/main/reference/get-tags.md), [audiences](https://github.com/qloo/docs-public/blob/main/reference/get-audiences.md). Search permits up to 100 results; tags/audiences permit 50 per page. Tags support partial name search and require exact tag-type IDs.

[Insights documentation](https://github.com/qloo/docs-public/blob/main/reference/insights-api-deep-dive.md) supports `signal.interests.entities`, `signal.interests.tags`, `signal.demographics.audiences`, and `signal.location.query`. Weighted tags are supported in POST. `feature.explainability=true` adds contributing input entities with normalized influence. `filter.results.entities` can constrain candidate scoring. `bias.trends` accepts off/low/medium/high, with availability limited to selected categories. Typical result limit is 50. This API accepts structured signals; image interpretation belongs in the VLM stage.

[Demographic guidance](https://github.com/qloo/docs-public/blob/main/reference/demographics-use-case.md) requires an entity or tag signal and describes positive/negative demographic scores as above/below average affinity. [Taste analysis](https://github.com/qloo/docs-public/blob/main/reference/taste-analysis.md) uses `filter.type=urn:tag` to return descriptive tag associations.

The [v2 trend reference](https://raw.githubusercontent.com/qloo/docs-public/main/reference/get-trending.md) explicitly requires `signal.interests.entities`, `filter.type`, `filter.start_date`, and `filter.end_date` (ISO dates), and limits results to 50 per page. Its example omits required parameters: implement from the parameter specification, then verify against the assigned key. The [entity history reference](https://raw.githubusercontent.com/qloo/docs-public/main/reference/get-trends-entity.md) documents `/trends/entity`, requires `entity_id` and `start_date`, and lists 404/429 outcomes. The [API overview](https://github.com/qloo/docs-public/blob/main/reference/api-overview.md) describes this as week-over-week trend data and also lists category-level trending. Category route details were not retrieved successfully.

## Probability and timing limits

Qloo [defines affinity](https://github.com/qloo/docs-public/blob/main/docs/interpreting-affinity-scores.md) as relationship strength/similarity/relevance; scores are normalized per query. **An affinity of 85 does not mean an 85% chance of virality**, and raw values across different queries need contextual interpretation. The documented trend routes concern entity momentum/history. They do not establish hourly platform engagement, best posting times, creator reach, recommendation algorithms, or post-level viral outcomes.

Recommended product approach (inference): start with a transparent cultural opportunity assessment and show separate fit, momentum, visual confidence, and missing-data indicators. If probabilities are essential, define the platform, horizon, and success threshold; obtain outcome-labeled posts plus creator/audience/exposure variables; fit and evaluate a model on future-held-out data; report calibration and uncertainty. Without that dataset, label numeric ranges as heuristic scenarios, not calibrated probabilities. A still image also cannot establish video motion, audio appeal, or retention.

## Hackathon fit

The [official hackathon page](https://qloo.devpost.com/) currently lists **October 30, 2026, 11:45 p.m. EDT** as the deadline. It requires a working Qloo-integrated agentic application, public code repository, project description, externally published accessible demo, and visible open-source license. Videos are optional. Judging covers implementation, design, impact, and idea quality. The organizers emphasize that cultural intelligence must materially differentiate the experience from an LLM-only application.

Recommended demo (inference): capture an outfit; resolve recognizable brand and style signals; compare selected cultural audience profiles; inspect entity momentum; propose two content angles and a collaborator/soundtrack choice justified by Qloo evidence. Show the counterfactual result with cultural data removed so Qloo's contribution is concrete. Confirm the assigned hackathon API key has the needed endpoint permissions and quotas before committing the demo to trend history; those were not verified here.
