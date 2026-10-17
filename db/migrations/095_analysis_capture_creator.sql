-- An analysis request does not make the requesting agent the capture's creator.
-- Captures compiled for an agent's analysis of media it did not upload were
-- recorded with created_by_agent_connection_id = that agent, which kept the
-- result visible to a selected-collection agent after the owner removed the
-- media from its grant. Only the agent that uploaded the media keeps that link.
UPDATE captures c
   SET created_by_agent_connection_id = NULL
 WHERE c.media_asset_id IS NOT NULL
   AND c.created_by_agent_connection_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM media_assets m
      WHERE m.id = c.media_asset_id
        AND m.created_by_agent_connection_id = c.created_by_agent_connection_id);
