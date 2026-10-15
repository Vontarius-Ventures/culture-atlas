-- Retain legacy ownership, dates and analysis links without inventing originals.
ALTER TABLE media_assets ADD COLUMN legacy_imported boolean NOT NULL DEFAULT false;
UPDATE media_assets m SET deleted_at=c.deleted_at,width=c.width,height=c.height,
  captured_at=c.captured_at,legacy_imported=true,
  byte_size=COALESCE((SELECT u.byte_size FROM uploads u WHERE u.id=c.upload_id),0),
  source=CASE c.source WHEN 'sensor' THEN 'legacy_sensor' WHEN 'camera' THEN 'browser_camera' ELSE 'upload' END,
  analysis_status=CASE WHEN c.active_analysis_id IS NOT NULL AND c.status IN ('ready','partial')
                       THEN 'complete' ELSE 'not_requested' END
 FROM captures c WHERE m.legacy_capture_id=c.id AND m.source='legacy_sensor';
