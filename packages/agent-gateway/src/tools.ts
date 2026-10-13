import { z } from 'zod';
import {
  captures,
  collections,
  items,
  jobs,
  plans,
  preferences,
  references,
  schemas,
  taste,
  type Scope,
  type ServiceContext,
} from '@culture-atlas/domain';

/**
 * MCP tool catalogue (build spec "Agent interface"). Inputs/outputs mirror the
 * REST schemas; every tool calls the SAME domain service as its REST route, so
 * authorization (scopes, collection grants, ownership) is identical.
 * `scopes` here is documentation + a fast pre-check; services re-check.
 */
export interface ToolDefinition<I extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  scopes: readonly Scope[];
  input: I;
  /** Job-starting tools return immediately and instruct the client to poll get_job. */
  startsJob: boolean;
  run(ctx: ServiceContext, input: z.infer<I>): Promise<unknown>;
}

const define = <I extends z.ZodType>(t: ToolDefinition<I>): ToolDefinition<I> => t;
const { Uuid } = schemas;

export const TOOLS = [
  define({
    name: 'analyze_capture',
    title: 'Analyze a photo',
    description:
      'Start discovery for a photo you uploaded via POST /v1/uploads (pass its upload_id; URLs and file paths are not accepted). Returns immediately with job_id; call get_job until complete, then get_capture.',
    scopes: ['captures:write'],
    input: z.strictObject({ upload_id: Uuid, focus: schemas.Focus.optional() }),
    startsJob: true,
    run: (ctx, input) => captures.createCapture(ctx, { kind: 'json', body: { upload_id: input.upload_id, focus: input.focus } }),
  }),
  define({
    name: 'get_job',
    title: 'Check a job',
    description: 'Get the state, progress stage and completed sections of a job started by another tool.',
    scopes: [],
    input: z.strictObject({ job_id: Uuid }),
    startsJob: false,
    run: (ctx, input) => jobs.getJob(ctx, { id: input.job_id }),
  }),
  define({
    name: 'get_capture',
    title: 'Get capture results',
    description: 'Get a capture’s interpretation, references and recommended discoveries.',
    scopes: ['captures:read'],
    input: z.strictObject({ capture_id: Uuid }),
    startsJob: false,
    run: (ctx, input) => captures.getCapture(ctx, { id: input.capture_id }),
  }),
  define({
    name: 'explore_reference',
    title: 'Explore a cultural reference',
    description: 'Get a concise sourced reference page (overview, sections, claims with sources).',
    scopes: [],
    input: z.strictObject({ reference_id: Uuid }),
    startsJob: false,
    run: (ctx, input) => references.getReference(ctx, { id: input.reference_id }),
  }),
  define({
    name: 'get_taste',
    title: 'Get taste summary',
    description:
      'Get the user’s explicit interest summary. Connections limited to selected collections must pass collection_id.',
    scopes: ['taste:read'],
    input: z.strictObject({ collection_id: Uuid.optional() }),
    startsJob: false,
    run: (ctx, input) => taste.getTaste(ctx, input),
  }),
  define({
    name: 'record_preference',
    title: 'Record a preference',
    description:
      'Save, remove (unsave everywhere), hide or unhide an item. Only call this when the user has explicitly said they like or dislike the item in this conversation.',
    scopes: ['taste:write'],
    input: schemas.PreferenceRequest,
    startsJob: false,
    run: (ctx, input) => preferences.recordPreference(ctx, input),
  }),
  define({
    name: 'list_collections',
    title: 'List collections',
    description: 'List the collections this connection can access, with item counts and revisions.',
    scopes: ['collections:read'],
    input: z.strictObject({}),
    startsJob: false,
    run: (ctx) => collections.listCollections(ctx),
  }),
  define({
    name: 'get_collection',
    title: 'Get a collection',
    description: 'Get a collection’s revision and its mixed items (cursor-paginated).',
    scopes: ['collections:read'],
    input: z.strictObject({
      collection_id: Uuid,
      cursor: schemas.Cursor.optional(),
      filter: schemas.CollectionQuery.shape.filter,
    }),
    startsJob: false,
    run: (ctx, input) =>
      collections.getCollection(ctx, { id: input.collection_id, query: { cursor: input.cursor, filter: input.filter } }),
  }),
  define({
    name: 'create_collection',
    title: 'Create a collection',
    description: 'Create a private collection. Requires whole-library access.',
    scopes: ['collections:write'],
    input: schemas.CreateCollectionRequest,
    startsJob: false,
    run: (ctx, input) => collections.createCollection(ctx, input),
  }),
  define({
    name: 'add_collection_item',
    title: 'Add an item to a collection',
    description:
      'Add a discovery item to a granted collection (idempotent). Adding an item the user has not saved also requires taste:write and an explicit user request.',
    scopes: ['collections:write'],
    input: z.strictObject({ collection_id: Uuid, item_id: Uuid, expected_revision: z.number().int().positive().optional() }),
    startsJob: false,
    run: (ctx, input) =>
      collections.addCollectionItem(ctx, {
        id: input.collection_id,
        item_id: input.item_id,
        body: { expected_revision: input.expected_revision },
      }),
  }),
  define({
    name: 'remove_collection_item',
    title: 'Remove an item from a collection',
    description: 'Remove one membership from a granted collection; the saved item and other memberships remain.',
    scopes: ['collections:write'],
    input: z.strictObject({ collection_id: Uuid, item_id: Uuid }),
    startsJob: false,
    run: (ctx, input) => collections.removeCollectionItem(ctx, { id: input.collection_id, item_id: input.item_id }),
  }),
  define({
    name: 'discover_related',
    title: 'Discover related items',
    description:
      'Start a bounded related-discovery job for an item. Selected-collection connections pass the collection_id containing the item. Returns immediately; poll get_job.',
    scopes: [],
    input: z.strictObject({ item_id: Uuid, category: schemas.RelatedDiscoveryRequest.shape.category, collection_id: Uuid.optional() }),
    startsJob: true,
    run: (ctx, input) =>
      items.startRelatedDiscovery(ctx, { id: input.item_id, body: { category: input.category, collection_id: input.collection_id } }),
  }),
  define({
    name: 'create_plan',
    title: 'Create a movie night',
    description:
      'Create a movie-night plan from 2-5 items of one collection (include expected_revision). Returns immediately; poll get_job, then get_plan.',
    scopes: ['plans:write', 'collections:read'],
    input: schemas.CreatePlanRequest,
    startsJob: true,
    run: (ctx, input) => plans.createPlan(ctx, input),
  }),
  define({
    name: 'get_plan',
    title: 'Get a plan',
    description: 'Get a plan’s current version: film, food, music and section states.',
    scopes: ['plans:read'],
    input: z.strictObject({ plan_id: Uuid }),
    startsJob: false,
    run: (ctx, input) => plans.getPlan(ctx, { id: input.plan_id }),
  }),
  define({
    name: 'replace_plan_section',
    title: 'Replace one plan section',
    description: 'Replace the film, food or music section, keeping the others. Returns immediately; poll get_job.',
    scopes: ['plans:write'],
    input: z.strictObject({ plan_id: Uuid, section: schemas.PlanReplacementRequest.shape.section, instruction: schemas.PlanReplacementRequest.shape.instruction }),
    startsJob: true,
    run: (ctx, input) => plans.replacePlanSection(ctx, { id: input.plan_id, body: { section: input.section, instruction: input.instruction } }),
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];

export const SPEC_TOOL_NAMES = [
  'analyze_capture', 'get_job', 'get_capture', 'explore_reference', 'get_taste', 'record_preference',
  'list_collections', 'get_collection', 'create_collection', 'add_collection_item', 'remove_collection_item',
  'discover_related', 'create_plan', 'get_plan', 'replace_plan_section',
] as const;
