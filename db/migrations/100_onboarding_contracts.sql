-- Spec amendment 2.2 shared contracts (phase 0 integration, range 100-109).
-- Additive only: widens two CHECK lists so parallel packages can rely on them.
--  * feature_flag_kills.flag: the amendment's killable flags. A kill can only
--    turn a feature off (see 085).
--  * model ledger role: the stage-2 photo enrichment role vision_photo_enrich.

ALTER TABLE feature_flag_kills DROP CONSTRAINT IF EXISTS feature_flag_kills_flag_check;
ALTER TABLE feature_flag_kills ADD CONSTRAINT feature_flag_kills_flag_check CHECK (flag IN (
  'camera_photo','camera_video','file_photo_upload','file_video_upload',
  'meta_glasses_capture_enabled','meta_glasses_audio_enabled','remote_glasses_capture_enabled',
  'concentrate_analysis_enabled','automatic_analysis','native_video_model_input',
  'agent_api_enabled','collection_sharing_enabled','agent_remote_capture_enabled',
  'onboarding_required','taste_seed_enabled','fast_analysis_two_stage','while_we_look_enabled'));

ALTER TABLE inference_attempts DROP CONSTRAINT IF EXISTS inference_attempts_role_check;
ALTER TABLE inference_attempts ADD CONSTRAINT inference_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich'));

ALTER TABLE model_gateway_attempts DROP CONSTRAINT IF EXISTS model_gateway_attempts_role_check;
ALTER TABLE model_gateway_attempts ADD CONSTRAINT model_gateway_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich'));
