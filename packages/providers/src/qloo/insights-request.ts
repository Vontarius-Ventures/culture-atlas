import { ProviderError } from '../errors';
import type { QlooInsightsRequest } from './types';

function validateIds(ids: readonly string[] | undefined, field: string): void {
  if (ids?.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new ProviderError('qloo', 'bad_request', `${field} contains a blank or invalid ID`);
  }
}

function validateOperator(operator: unknown, ids: readonly string[] | undefined, field: string): void {
  if (operator === undefined) return;
  if (operator !== 'union' && operator !== 'intersection') {
    throw new ProviderError('qloo', 'bad_request', `${field} must be union or intersection`);
  }
  if (!ids?.length) {
    throw new ProviderError('qloo', 'bad_request', `${field} requires corresponding tag IDs`);
  }
}

/** Shared GET validation/serialization so HTTP and replay use identical request identity. */
export function insightsQuery(req: QlooInsightsRequest): Record<string, string | string[] | undefined> {
  const signalTags = req.signalTags?.map((tag) => tag.id);
  validateIds(req.signalEntities, 'signalEntities');
  validateIds(signalTags, 'signalTags');
  validateIds(req.filterTags, 'filterTags');
  validateIds(req.filterResultsEntities, 'filterResultsEntities');
  validateIds(req.filterTagTypes, 'filterTagTypes');
  validateOperator(req.filterTagsOperator, req.filterTags, 'filterTagsOperator');
  validateOperator(req.signalTagsOperator, signalTags, 'signalTagsOperator');
  if (req.signalTags?.some((tag) => tag.weight !== undefined)) {
    throw new ProviderError('qloo', 'bad_request', 'GET insights does not support per-tag weights; weighted tags require a separately verified POST contract');
  }
  if (!req.signalEntities?.length && !signalTags?.length && !req.signalLocationQuery && !req.filterTags?.length && !req.filterLocationQuery) {
    throw new ProviderError('qloo', 'bad_request', 'insights requires at least one signal or filter');
  }
  return {
    'filter.type': req.filterType,
    'signal.interests.entities': req.signalEntities,
    'signal.interests.tags': signalTags,
    'operator.signal.interests.tags': req.signalTagsOperator,
    'signal.location.query': req.signalLocationQuery,
    'filter.location.query': req.filterLocationQuery,
    'filter.popularity.min': req.filterPopularityMin === undefined ? undefined : String(req.filterPopularityMin),
    'filter.results.entities': req.filterResultsEntities,
    'filter.tags': req.filterTags,
    'operator.filter.tags': req.filterTagsOperator,
    'filter.tag.types': req.filterTagTypes,
    'bias.trends': req.biasTrends,
    'feature.explainability': req.explainability ? 'true' : undefined,
    take: String(Math.min(req.take ?? 10, 50)),
    page: req.page === undefined ? undefined : String(req.page),
  };
}
