import { z } from 'zod';
import { LibraryAccess, Scope } from '../enums';
import { Timestamp, Uuid } from './common';
import { SafeCaptureDeviceSetup } from './capture-v2';
import { FoodExclusions } from './onboarding';

export const OrdinaryPreferences = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  language: z.enum(['en', 'es', 'fr', 'de', 'ja']).optional(),
  default_capture_mode: z.enum(['photo', 'video']).optional(),
  video_muted: z.boolean().optional(),
  exploration: z.enum(['familiar', 'balanced', 'adventurous']).optional(),
  /**
   * Amendment 2.2: food exclusions chosen at onboarding or in Settings -> Taste.
   * A preference (read with preferences:read, changed with preferences:write),
   * never taste; they default movie-night plans and filter Eat suggestions.
   * A patch replaces the whole list.
   */
  food: z.strictObject({ exclusions: FoodExclusions }).optional(),
});
export const PatchOrdinaryPreferences = OrdinaryPreferences.refine((v) => Object.keys(v).length > 0, 'Choose a preference.');
export const PreferencesResponse = z.object({
  schema_version: z.literal('2.1'), request_id: z.string(), version: z.number().int(),
  user_set: OrdinaryPreferences,
  effective: OrdinaryPreferences.required(),
  analysis_consent: z.object({ automatic_analysis: z.literal(false), requires_explicit_request: z.literal(true) }),
});
export const SetupResponse = z.object({
  schema_version: z.literal('2.1'), request_id: z.string(), observed_at: Timestamp,
  installations: z.array(SafeCaptureDeviceSetup),
  available_actions: z.array(z.string()),
  permission_summary: z.literal('Observed permissions only. OS access and remote capture require local consent.'),
});
export const CreateAgentV2 = z.strictObject({
  client_name: z.string().trim().min(1).max(80),
  scopes: z.array(Scope).min(1).default(['setup:read', 'preferences:read']),
  library_access: LibraryAccess.default('none'),
  collection_ids: z.array(Uuid).max(100).default([]),
  installation_ids: z.array(Uuid).max(100).default([]),
  expires_in_days: z.number().int().min(1).max(90).default(30),
}).refine((v) => v.library_access === 'selected_collections' ? v.collection_ids.length > 0 : v.collection_ids.length === 0,
  { message: 'Choose only the collections to grant.', path: ['collection_ids'] })
  .refine((v) => !v.scopes.includes('devices:command') || v.installation_ids.length > 0,
    { message: 'Choose the permitted installations.', path: ['installation_ids'] });
export const NarrowAgentV2 = z.strictObject({
  client_name: z.string().trim().min(1).max(80).optional(),
  scopes: z.array(Scope).min(1).optional(),
  collection_ids: z.array(Uuid).max(100).optional(),
  installation_ids: z.array(Uuid).max(100).optional(),
  expires_at: Timestamp.optional(),
});
export const AgentActivityResponse = z.object({
  schema_version: z.literal('2.1'), request_id: z.string(),
  items: z.array(z.object({
    id: Uuid, connection_id: Uuid, client_name: z.string(), action: z.string(),
    target_id: Uuid.nullable(),
    /** Owner-facing name of the target when it is one of the owner's collections. */
    target_label: z.string().nullable().optional(), created_at: Timestamp,
  })),
  next_cursor: z.string().nullable(),
});
export const OAuthConsent = z.strictObject({
  client_id: z.string().min(1).max(200), redirect_uri: z.url().max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
  state: z.string().min(16).max(512), resource: z.url().max(2048), grant: CreateAgentV2,
});
export const OAuthExchange = z.discriminatedUnion('grant_type', [
  z.strictObject({
    grant_type: z.literal('authorization_code'), client_id: z.string(), redirect_uri: z.url(),
    code: z.string().min(32).max(512), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    resource: z.url(),
  }),
  z.strictObject({
    grant_type: z.literal('refresh_token'), client_id: z.string(), refresh_token: z.string().min(32).max(512),
    resource: z.url(),
  }),
]);
