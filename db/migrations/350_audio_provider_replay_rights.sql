-- Discovery scrutiny repair DISC-SCR-013/014 (VAL-EVID-005): the two durable
-- Music Mode Qloo sinks written before the provider rights repair.
--
-- provider_rights_policies (migration 300) records for Qloo:
--   response_retention = 'transient_only', public_display =
--   'owned_or_cleared_only', rights_documented = false.
-- Until those rights are documented, Qloo-derived prose (properties
-- short_description/description) and Qloo-returned image URLs must never be
-- retained or displayed.
--
-- Sinks repaired here (new writes are sanitized at the producers,
-- audio/provider-rights.ts):
--   1) audio_analysis_requests.result — pre-repair rows store
--      artist.image_url and match artist/related `image` objects holding
--      Qloo-returned URLs. Recognition, names, destinations and trace stay.
--   2) job_stages.output for analyze_audio 'resolve-qloo'/'related-qloo' —
--      ctx.runStage (runStageOnce) serialized the COMPLETE provider response
--      (entity prose/images, envelope, raw body). These rows are replay
--      caches, so they are reduced to the minimal rights-safe replay
--      projection (entity_id, name, types, popularity, properties.website;
--      is_replay for the related stage): a retrying worker still replays
--      them instead of buying another provider call.
--
-- What is NOT restricted content here: recognition/trace fields (names,
-- vendor recording data, evidence/recognition/job ids), verified destination
-- links (properties.website -> destination_url), user-owned stored media
-- (image.object_key) and app-served assets ("/...", never "//"), the only
-- cleared images (services/display.ts isClearedDisplayImageUrl). The
-- 'recognize' stage (vendor recognition output) is untouched.
-- Idempotent: every statement keys on the restricted content still being
-- present, so re-applying is a no-op.

-- 1) Legacy result: artist.image_url — keep only cleared URLs.
UPDATE audio_analysis_requests
   SET result = jsonb_set(result, '{artist,image_url}', 'null'::jsonb, true)
 WHERE jsonb_typeof(result) = 'object'
   AND jsonb_typeof(result->'artist') = 'object'
   AND result->'artist' ? 'image_url'
   AND jsonb_typeof(result->'artist'->'image_url') = 'string'
   AND (coalesce(left(result->'artist'->>'image_url', 1), '') <> '/'
        OR coalesce(left(result->'artist'->>'image_url', 2), '') = '//');

-- 2) Legacy result: match.artist.image — keep only cleared display images.
UPDATE audio_analysis_requests
   SET result = jsonb_set(result, '{match,artist,image}', 'null'::jsonb, true)
 WHERE jsonb_typeof(result) = 'object'
   AND jsonb_typeof(result->'match') = 'object'
   AND jsonb_typeof(result->'match'->'artist') = 'object'
   AND result->'match'->'artist' ? 'image'
   AND jsonb_typeof(result->'match'->'artist'->'image') <> 'null'
   AND (
        jsonb_typeof(result->'match'->'artist'->'image') <> 'object'
        OR NOT (
             result->'match'->'artist'->'image' ? 'object_key'
             OR (coalesce(left(result->'match'->'artist'->'image'->>'url', 1), '') = '/'
                 AND coalesce(left(result->'match'->'artist'->'image'->>'url', 2), '') <> '//')
        )
   );

-- 3) Legacy result: match.related[*].image — the same clearance rule per entry.
--    Non-object and imageless entries pass through; empty arrays stay empty.
UPDATE audio_analysis_requests a
   SET result = jsonb_set(a.result, '{match,related}', (
        SELECT coalesce(jsonb_agg(
                 CASE
                   WHEN jsonb_typeof(el) <> 'object' OR NOT (el ? 'image') OR jsonb_typeof(el->'image') = 'null' THEN el
                   WHEN jsonb_typeof(el->'image') <> 'object' THEN jsonb_set(el, '{image}', 'null'::jsonb)
                   WHEN el->'image' ? 'object_key'
                        OR (coalesce(left(el->'image'->>'url', 1), '') = '/'
                            AND coalesce(left(el->'image'->>'url', 2), '') <> '//') THEN el
                   ELSE jsonb_set(el, '{image}', 'null'::jsonb)
                 END
                 ORDER BY ord
               ), '[]'::jsonb)
          FROM jsonb_array_elements(a.result->'match'->'related') WITH ORDINALITY AS t(el, ord)
      ), true)
 WHERE jsonb_typeof(a.result) = 'object'
   AND jsonb_typeof(a.result->'match') = 'object'
   AND jsonb_typeof(a.result->'match'->'related') = 'array'
   AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(a.result->'match'->'related') AS el
         WHERE CASE
                 WHEN jsonb_typeof(el) <> 'object' OR NOT (el ? 'image') THEN false
                 WHEN jsonb_typeof(el->'image') = 'null' THEN false
                 ELSE jsonb_typeof(el->'image') <> 'object'
                      OR NOT (el->'image' ? 'object_key'
                              OR (coalesce(left(el->'image'->>'url', 1), '') = '/'
                                  AND coalesce(left(el->'image'->>'url', 2), '') <> '//'))
               END
   );

-- 4) Legacy resolve-qloo stage cache (Qloo search response) -> minimal replay
--    projection {"data":[entity_id,name,types,popularity,properties.website,tags:[]]}
--    (the same shape audio/provider-rights.ts qlooReplayEntity persists).
UPDATE job_stages s
   SET output = (
        SELECT jsonb_build_object('data', coalesce(jsonb_agg(
                 CASE
                   WHEN jsonb_typeof(ent) <> 'object' THEN ent
                   ELSE jsonb_set(
                          jsonb_set(
                            ent - 'disambiguation' - 'query' - 'subtype',
                            '{tags}', '[]'::jsonb
                          ),
                          '{properties}',
                          CASE
                            WHEN jsonb_typeof(ent->'properties') = 'object' AND ent->'properties' ? 'website'
                              THEN jsonb_build_object('website', ent->'properties'->'website')
                            ELSE '{}'::jsonb
                          END)
                 END
                 ORDER BY ord
               ), '[]'::jsonb))
          FROM jsonb_array_elements(s.output->'data') WITH ORDINALITY AS t(ent, ord)
      )
  FROM jobs j
 WHERE j.id = s.job_id
   AND j.type = 'analyze_audio'
   AND s.stage = 'resolve-qloo'
   AND s.status = 'complete'
   AND jsonb_typeof(s.output) = 'object'
   AND jsonb_typeof(s.output->'data') = 'array';

-- 5) Legacy related-qloo stage cache (Qloo insights response) -> minimal
--    replay projection {"is_replay":bool,"data":{"entities":[...]}} (the same
--    shape audio/provider-rights.ts qlooReplayEntity persists).
UPDATE job_stages s
   SET output = (
        SELECT jsonb_build_object(
                 'is_replay',
                 CASE WHEN jsonb_typeof(s.output->'is_replay') = 'boolean' THEN s.output->'is_replay' ELSE 'false'::jsonb END,
                 'data',
                 jsonb_build_object('entities', coalesce(jsonb_agg(
                   CASE
                     WHEN jsonb_typeof(ent) <> 'object' THEN ent
                     ELSE jsonb_set(
                            jsonb_set(
                              ent - 'disambiguation' - 'query' - 'subtype',
                              '{tags}', '[]'::jsonb
                            ),
                            '{properties}',
                            CASE
                              WHEN jsonb_typeof(ent->'properties') = 'object' AND ent->'properties' ? 'website'
                                THEN jsonb_build_object('website', ent->'properties'->'website')
                              ELSE '{}'::jsonb
                            END)
                   END
                   ORDER BY ord
                 ), '[]'::jsonb))
               )
          FROM jsonb_array_elements(s.output->'data'->'entities') WITH ORDINALITY AS t(ent, ord)
      )
  FROM jobs j
 WHERE j.id = s.job_id
   AND j.type = 'analyze_audio'
   AND s.stage = 'related-qloo'
   AND s.status = 'complete'
   AND jsonb_typeof(s.output) = 'object'
   AND jsonb_typeof(s.output->'data') = 'object'
   AND jsonb_typeof(s.output->'data'->'entities') = 'array';
