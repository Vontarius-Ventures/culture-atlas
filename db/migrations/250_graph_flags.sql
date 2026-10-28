-- Interest graph, PR 8 packages A/F: rollout flags. The four graph flags
-- (projection, discovery, research, optional framework shadow) default false
-- in code; kills can only turn features off. The list gains the graph flags so
-- operators can kill projection, discovery, research and framework shadow
-- globally or per account. Reads, projection of removals/retractions and
-- deletion cleanup never depend on these rows.

ALTER TABLE feature_flag_kills DROP CONSTRAINT IF EXISTS feature_flag_kills_flag_check;
ALTER TABLE feature_flag_kills ADD CONSTRAINT feature_flag_kills_flag_check CHECK (flag IN (
  'camera_photo','camera_video','file_photo_upload','file_video_upload',
  'meta_glasses_capture_enabled','meta_glasses_audio_enabled','remote_glasses_capture_enabled',
  'concentrate_analysis_enabled','automatic_analysis','native_video_model_input',
  'agent_api_enabled','collection_sharing_enabled','agent_remote_capture_enabled',
  'onboarding_required','taste_seed_enabled','fast_analysis_two_stage','while_we_look_enabled',
  'analysis_verifier_enabled',
  'interest_graph_projection_enabled','interest_graph_discovery_enabled',
  'interest_graph_research_enabled','interest_graph_framework_shadow_enabled'));
