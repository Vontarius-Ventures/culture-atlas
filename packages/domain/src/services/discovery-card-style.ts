import type { DiscoveryCard } from '../schemas/common';

export interface CardStyleContext {
  subject_id?: string | null;
  claims: { name: string }[];
  palette?: string[];
  via_entity?: string | null;
  discovery_proof?: unknown;
}

/**
 * Catalogue connections do not prove that an entity's illustration shares
 * the photographed object's attributes or palette. Keep the legacy wire
 * shape, but let the relation-specific reason explain those connections.
 */
export function discoveryCardStyle(
  match: CardStyleContext | null | undefined,
  experimental: boolean,
): DiscoveryCard['style_match'] {
  if (!match) return null;
  const catalogueConnection = match.discovery_proof != null;
  return {
    subject_id: match.subject_id ?? null,
    attributes: catalogueConnection ? [] : [...new Set(match.claims.map((claim) => claim.name))],
    palette: catalogueConnection ? [] : match.palette ?? [],
    via: match.via_entity ?? null,
    experimental,
  };
}
