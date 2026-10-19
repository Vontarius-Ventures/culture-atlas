-- Photo-role requalification (docs/requalification-plan.md, decisions 2 and
-- the verifier). Additive only.
--
--  * Text-only references (decision 2): a brand or person name read only in
--    the stage-2 reply is listed under "Explore the references" with the text
--    it was read from. It is never an anchor, never searched in Qloo and
--    never researched. text_only marks the row; read_text keeps the
--    transcription it rests on (the reading's own words, at most 60 chars).
--  * Verifier (vision_verify): the background check after stage 2 can only
--    lower a reference's certainty or mark it qualified; it never removes a
--    row. verifier_check records its answer for the reference.
--  * Model ledger roles gain vision_verify; the kill switch list gains
--    analysis_verifier_enabled (a kill can only turn the verifier off).

ALTER TABLE capture_references
  ADD COLUMN text_only boolean NOT NULL DEFAULT false,
  ADD COLUMN read_text text CHECK (read_text IS NULL OR char_length(read_text) <= 200),
  ADD COLUMN verifier_check text CHECK (verifier_check IS NULL OR verifier_check IN ('yes', 'no', 'unsure')),
  ADD CONSTRAINT capture_references_text_only_read CHECK (NOT text_only OR (read_text IS NOT NULL AND NOT is_anchor));

ALTER TABLE feature_flag_kills DROP CONSTRAINT IF EXISTS feature_flag_kills_flag_check;
ALTER TABLE feature_flag_kills ADD CONSTRAINT feature_flag_kills_flag_check CHECK (flag IN (
  'camera_photo','camera_video','file_photo_upload','file_video_upload',
  'meta_glasses_capture_enabled','meta_glasses_audio_enabled','remote_glasses_capture_enabled',
  'concentrate_analysis_enabled','automatic_analysis','native_video_model_input',
  'agent_api_enabled','collection_sharing_enabled','agent_remote_capture_enabled',
  'onboarding_required','taste_seed_enabled','fast_analysis_two_stage','while_we_look_enabled',
  'analysis_verifier_enabled'));

ALTER TABLE inference_attempts DROP CONSTRAINT IF EXISTS inference_attempts_role_check;
ALTER TABLE inference_attempts ADD CONSTRAINT inference_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich','vision_verify'));

ALTER TABLE model_gateway_attempts DROP CONSTRAINT IF EXISTS model_gateway_attempts_role_check;
ALTER TABLE model_gateway_attempts ADD CONSTRAINT model_gateway_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich','vision_verify'));
