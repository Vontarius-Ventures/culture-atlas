-- Discovery scrutiny repair DISC-SCR-001 (VAL-EVID-005): enforce the recorded
-- Qloo rights policy at the actual discovery_items persistence boundary.
--
-- provider_rights_policies (migration 300) records for Qloo:
--   response_retention = 'transient_only', public_display =
--   'owned_or_cleared_only', rights_documented = false.
-- Until those rights are documented, Qloo-derived prose (properties
-- short_description/description) and Qloo-returned image URLs must never be
-- retained or displayed. The legacy taste-seed / related-discovery / Music
-- Mode / capture-analysis producers persisted both into
-- discovery_items.display_metadata before this repair; this migration strips
-- those previously persisted copies. New writes are sanitized at the store
-- boundary (composer/store.ts) and card reads re-check clearance
-- (services/display.ts clearedDisplayImage).
--
-- What is NOT restricted content here: verified destination links
-- (destination_url, the subject's own official site), subtitles/years
-- (name-like trace metadata), user-owned stored media (image.object_key,
-- signed on read) and app-served sample assets ("/samples/...").

-- 1) Qloo-derived prose: rows carrying a Qloo entity or tag id are
--    provider-backed, and only provider paths ever wrote descriptions onto
--    them (taste-seed, related discovery, Music Mode, seeded-pick propagation).
UPDATE discovery_items
   SET display_metadata = display_metadata - 'description',
       updated_at = now()
 WHERE external_ids ?| ARRAY['qloo','qloo_tag']
   AND display_metadata ? 'description';

-- 2) Uncleared external image URLs: a display image may only be user-owned
--    stored media (object_key) or an app-served relative asset. No external
--    host has a recorded independent clearance, and HTTPS/provider license
--    fields are not clearance, so any absolute (or protocol-relative) URL
--    image is dropped. Rows with an object_key image (user-owned photos) are
--    untouched. This matches services/display.ts isClearedDisplayImageUrl.
UPDATE discovery_items
   SET display_metadata = display_metadata - 'image',
       updated_at = now()
 WHERE display_metadata -> 'image' ? 'url'
   AND NOT (display_metadata -> 'image' ? 'object_key')
   AND (left(display_metadata -> 'image' ->> 'url', 1) <> '/'
        OR left(display_metadata -> 'image' ->> 'url', 2) = '//');
