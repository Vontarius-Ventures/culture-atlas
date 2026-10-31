import type { QlooEntity } from '@culture-atlas/providers';

/** Bounded, non-opaque evidence projection. No descriptions, URLs or person metadata. */
export function candidateAuditRecord(entity: QlooEntity, index: number) {
  const text = (value: string) => value.slice(0, 200);
  const tags = entity.tags ?? [];
  return {
    schema_version: 'qloo_candidate_audit_v1' as const,
    rank: index + 1,
    entity_id: entity.entity_id,
    name: text(entity.name),
    types: entity.types.slice(0, 12),
    tags: tags.slice(0, 160).map((t) => ({ id: text(t.id), name: text(t.name), ...(t.type ? { type: text(t.type) } : {}) })),
    tagsTotal: tags.length,
    tagsTruncated: tags.length > 160,
    affinity: entity.query?.affinity ?? null,
    explainability: entity.query?.explainability?.slice(0, 12) ?? null,
    metadataAvailability: {
      description: typeof entity.properties.description === 'string' && !!entity.properties.description.trim(),
      image: !!entity.properties.image,
      imageRole: 'unknown' as const,
    },
  };
}
