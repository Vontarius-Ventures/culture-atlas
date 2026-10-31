import type { DiscoveryClaim } from './discovery-concepts';
import { activeConnectionTopicPlan, CONNECTION_TOPICS, planConnectionTopics, type ConnectionTopicPlan } from './connection-topics';
import type { StoredSubject } from './types';
import { safeSubjectLabel } from './source-feature-plan';

/** Compatibility seam for older documentary retrieval callers. */
export function documentaryTopic(subject: StoredSubject) {
  const plan = planConnectionTopics([subject])[0];
  const topic = CONNECTION_TOPICS.find((t) => t.key === plan?.key);
  return plan && topic ? { ...topic, name: topic.key, query: topic.tagQuery, claim: plan.claim } : null;
}

export interface ContentEvidence {
  topic: string;
  claim: DiscoveryClaim;
  field: 'description' | 'short_description';
  /** Exact candidate-owned sentence, never generated or paraphrased. */
  excerpt: string;
  /** Offsets into the exact original field (end exclusive), never normalized text. */
  range?: { start: number; end: number };
  focus?: 'central' | 'supporting' | 'incidental' | 'unknown';
  /** Bounded original synopsis fields needed to revalidate whole-context focus. */
  context?: { description?: string; short_description?: string };
  /** Optional for legacy stored proofs. New proofs always set this exact union. */
  kind?: 'documentary' | 'topic_film';
  sourceCue?: string;
  topicPlanKey?: string;
  /** Actual returned tag only; narrative films never receive a synthetic documentary tag. */
  documentaryTag?: { id: string; label: string };
  topicTag?: { id: string; label: string };
}

interface ContentEntity {
  types?: readonly string[];
  tags?: { id: string; name: string }[];
  properties?: Record<string, unknown>;
}

export type ContentFocus = NonNullable<ContentEvidence['focus']>;
export interface ContentFocusResult {
  focus: ContentFocus;
  field?: ContentEvidence['field'];
  excerpt?: string;
  range?: { start: number; end: number };
}

const INCIDENTAL = /\b(?:not about|does not explore|unrelated to|background|incidental(?:ly)?|brief(?:ly)?|vignettes?|cameos?|in passing|among (?:others|many)|various (?:practices|crafts))\b/i;
const OTHER_PLOT = /\b(?:murder|crime|trial|courtroom|conviction|heist|perilous affair|struggling actress|family reunion)\b/i;
const RELATION = /\b(?:about|devoted to|profiles?|interviews?|explor\w*|examin\w*|documents?|follows?|surveys?|chronicles?|portrait of|focus\w* on|delves? into|cent(?:er|re)s on|depicts?|portrays?)\b/gi;

/** A conservative, bounded role interpreter, not a claim of general language understanding.
 * Whole-field vetoes prevent a shorter synopsis from concealing an unrelated central plot.
 * Unknown/supporting are deliberately not central-focus proofs.
 */
export function parseConnectionContentFocus(topicKey: string, properties: Record<string, unknown>): ContentFocusResult {
  const topic = CONNECTION_TOPICS.find((t) => t.key === topicKey);
  if (!topic) return { focus: 'unknown' };
  if (['description', 'short_description'].some((field) =>
    typeof properties[field] === 'string' && properties[field].length > 20_000)) return { focus: 'unknown' };
  const fields = (['description', 'short_description'] as const).flatMap((field) => {
    const text = properties[field];
    return typeof text === 'string' && text.length <= 20_000 ? [{ field, text }] : [];
  });
  const whole = fields.map((f) => f.text).join(' ');
  if (!topic.focus.test(whole)) return { focus: 'unknown' };
  const located = (focus: ContentFocus): ContentFocusResult => {
    for (const { field, text } of fields) {
      for (const match of text.matchAll(/[^.!?]+(?:[.!?](?=\s|$)|$)/g)) {
        const excerpt = match[0].trim();
        if (excerpt.length <= 900 && topic.focus.test(excerpt)) {
          const start = match.index + match[0].indexOf(excerpt);
          return { focus, field, excerpt, range: { start, end: start + excerpt.length } };
        }
      }
    }
    return { focus };
  };
  const practices = [/\b(?:chefs?|cooking)\b/i, /\bmusicians?\b/i, /\bcarpenters?\b/i, /\b(?:sculptors?|potters?)\b/i, /\bathletes?\b/i];
  const count = practices.filter((p) => p.test(whole)).length;
  if (INCIDENTAL.test(whole) || OTHER_PLOT.test(whole) || count >= 3 ||
    (count >= 2 && /\b(?:philosoph\w*|diverse|various|Heidegger)\b/i.test(whole)) ||
    (topicKey === 'coffee' && /\b(?:makes?|drinks?|sips?|orders?) coffee\b/i.test(whole)) ||
    (topicKey === 'tennis' && /\bformer tennis (?:professional|player|pro)\b/i.test(whole)))
    return located('incidental');
  for (const { field, text } of fields) {
    for (const match of text.matchAll(/[^.!?]+(?:[.!?](?=\s|$)|$)/g)) {
      const raw = match[0], excerpt = raw.trim();
      const start = match.index + raw.indexOf(excerpt);
      if (!excerpt || excerpt.length > 900 || !topic.focus.test(excerpt)) continue;
      for (const relation of excerpt.matchAll(RELATION)) {
        // The topic must be the subject/object of this narrative relation, not a later
        // daily-activity list attached to a portrait of someone in another practice.
        const tail = excerpt.slice(relation.index + relation[0].length).split(/[;:]/)[0]!;
        const focus = topic.focus.exec(tail);
        if (!focus || focus.index > 170) continue;
        const prefix = tail.slice(0, focus.index);
        if (/\b(?:includes?|including|such as|alongside|involving|appears?|visible|seen|drinks?|makes?)\b/i.test(prefix)) continue;
        if (topicKey === 'coffee' && !/\b(?:coffee(?:[- ](?:making|plantations?|growers?|production|trade|culture|brewing|industry|farmers?|ritual))?|espresso|baristas?|growers?|roasters?)\b/i.test(tail)) continue;
        if (topicKey === 'tennis' && !/\b(?:champions?|career|training|trains?|competition|tournament|tennis player|tennis match|tennis rivalry)\b/i.test(tail)) continue;
        return { focus: 'central', field, excerpt, range: { start, end: start + excerpt.length } };
      }
    }
  }
  return located('supporting');
}

export function connectionContentEvidence(subject: StoredSubject, entity: ContentEntity, supplied?: ConnectionTopicPlan): ContentEvidence | null {
  const plans = supplied ? [activeConnectionTopicPlan(subject, supplied)].filter((p): p is ConnectionTopicPlan => !!p) : planConnectionTopics([subject]);
  const documentary = entity.tags?.find((t) => /^urn:tag:(?:genre|subgenre)(?::|$)/.test(t.id) &&
    /\bdocumentary\b/i.test(t.name) && !/\b(?:non|not)[ -]documentary\b/i.test(t.name));
  for (const plan of plans) {
    const topic = CONNECTION_TOPICS.find((t) => t.key === plan.key)!;
    const topicTag = entity.tags?.find((t) => /^urn:tag:(?:genre|subgenre|theme|keyword)(?::|$)/.test(t.id) && !/\bdocumentary\b/i.test(t.name) && topic.focus.test(t.name));
    if (!documentary && (plan.requiresDocumentary || !entity.types?.includes('urn:entity:movie') || !topicTag)) continue;
    const focus = parseConnectionContentFocus(plan.key, entity.properties ?? {});
    if (focus.focus === 'central' && focus.field && focus.excerpt && focus.range) {
        return { topic: plan.tagQuery, claim: plan.claim.slot === 'label' ? { ...plan.claim, name: safeSubjectLabel(subject) } : plan.claim,
          sourceCue: plan.sourceCue, topicPlanKey: plan.key, focus: focus.focus, range: focus.range,
          context: Object.fromEntries(['description', 'short_description'].flatMap((field) => {
            const text = entity.properties?.[field];
            return typeof text === 'string' && text.length <= 20_000 ? [[field, text]] : [];
          })),
          kind: documentary ? 'documentary' : 'topic_film', field: focus.field, excerpt: focus.excerpt,
          ...(documentary ? { documentaryTag: { id: documentary.id, label: documentary.name } } : {}),
          ...(topicTag ? { topicTag: { id: topicTag.id, label: topicTag.name } } : {}) };
    }
  }
  return null;
}

/** Historical name retained; now also admits explicitly planned substantive narrative topic films. */
export const documentaryEvidence = connectionContentEvidence;
