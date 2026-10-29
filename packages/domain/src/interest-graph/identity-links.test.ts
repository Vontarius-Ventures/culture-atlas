import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertReference } from '../compiler/store';
import type { PoolDb } from '../db/pool';
import { createIsolatedDatabase } from '../testing';
import { bindGraphIdentityReference, mapGraphExternalId, upsertGraphIdentity } from './evidence';
import {
  bilaterallyVerifiedReferenceNodes,
  linkGraphReferenceIdentities,
  verifiedReferenceNodeMatches,
} from './identity-links';

/**
 * Verified application-reference/corpus identity linkage (DISC-SCR-004):
 *
 *  - A corpus identity binds a real `cultural_references` row through the
 *    verified 1:1 link (never a name match): `upsertGraphIdentity` binds a
 *    later supplied reference onto an existing unlinked node idempotently,
 *    and competing or ambiguous links fail closed without changing another
 *    identity.
 *  - The linkage pass resolves compiler-shaped references (Qloo entity ids in
 *    `external_ids`/`canonical_key`, Wikidata keys) to canonical identities
 *    through EXACT confirmed provider-id equality, binds unlinked nodes
 *    durably, and is idempotent: replay reports everything already linked and
 *    writes nothing.
 *  - Name similarity, unconfirmed mappings and ambiguous matches (one
 *    reference matching two identities, or one identity matched by two
 *    references) never link anything.
 *
 * The whole file runs on ONE isolated database (like corpus.test.ts): the
 * linkage pass counts are global tallies, and exact assertions are only
 * deterministic in a population this file owns.
 */

let db: PoolDb;
let drop: () => Promise<void>;

beforeAll(async () => {
  const iso = await createIsolatedDatabase('idlinks');
  db = iso.db;
  drop = iso.drop;
});

afterAll(async () => {
  await drop();
});

/** A fresh canonical identity (optionally with a directly supplied reference). */
async function identity(over: { withReference?: boolean; name?: string } = {}) {
  const name = over.name ?? `Linked thing ${randomUUID().slice(0, 6)}`;
  const referenceId = over.withReference
    ? await upsertReference(db, { canonicalKey: `test:${randomUUID()}`, name, type: 'work', externalIds: {} })
    : null;
  const node = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:work:${randomUUID()}`,
    canonicalName: name,
    nodeKind: 'work',
    domain: 'art',
    senseKey: 'painting',
    ...(referenceId ? { culturalReferenceId: referenceId } : {}),
  });
  return { node, referenceId };
}

/** A compiler-shaped reference: Qloo-resolved entity ids in key and external_ids. */
async function qlooReference(providerId: string, name = `Real reference ${randomUUID().slice(0, 6)}`) {
  return upsertReference(db, { canonicalKey: `qloo:${providerId}`, name, type: 'work', externalIds: { qloo: providerId } });
}

async function nodeReferenceId(nodeId: string): Promise<string | null> {
  const { rows } = await db.query<{ cultural_reference_id: string | null }>(
    'SELECT cultural_reference_id FROM graph_nodes WHERE id = $1',
    [nodeId],
  );
  return rows[0]?.cultural_reference_id ?? null;
}

// --- Verified null-to-reference binding ---------------------------------------

describe('verified null-to-reference binding', () => {
  it('upsertGraphIdentity binds a later supplied reference onto an existing unlinked node idempotently', async () => {
    const { node } = await identity();
    expect(node.cultural_reference_id).toBeNull();
    const referenceId = await qlooReference(`ent-${randomUUID()}`);

    // The later resolution binds the previously null link...
    const bound = await upsertGraphIdentity(db, {
      canonicalKey: node.canonical_key,
      canonicalName: node.canonical_name,
      nodeKind: node.node_kind,
      domain: node.domain,
      senseKey: node.sense_key,
      culturalReferenceId: referenceId,
    });
    expect(bound.id).toBe(node.id);
    expect(bound.cultural_reference_id).toBe(referenceId);
    expect(await nodeReferenceId(node.id)).toBe(referenceId);

    // ...and replaying the same resolution changes nothing.
    const replay = await upsertGraphIdentity(db, {
      canonicalKey: node.canonical_key,
      canonicalName: node.canonical_name,
      nodeKind: node.node_kind,
      domain: node.domain,
      senseKey: node.sense_key,
      culturalReferenceId: referenceId,
    });
    expect(replay.cultural_reference_id).toBe(referenceId);
    expect(await nodeReferenceId(node.id)).toBe(referenceId);
  });

  it('fails closed when the identity already holds a different reference, leaving that binding unchanged', async () => {
    const { node, referenceId: held } = await identity({ withReference: true });
    const other = await qlooReference(`ent-${randomUUID()}`);

    await expect(
      upsertGraphIdentity(db, {
        canonicalKey: node.canonical_key,
        canonicalName: node.canonical_name,
        nodeKind: node.node_kind,
        domain: node.domain,
        senseKey: node.sense_key,
        culturalReferenceId: other,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // Fail closed: the existing binding and the competing reference are untouched.
    expect(await nodeReferenceId(node.id)).toBe(held);
    expect(await nodeReferenceId((await identity()).node.id)).toBeNull();
  });

  it('fails closed when another identity holds the reference, leaving that identity unchanged', async () => {
    const holder = await identity();
    const referenceId = await qlooReference(`ent-${randomUUID()}`);
    await upsertGraphIdentity(db, {
      canonicalKey: holder.node.canonical_key,
      canonicalName: holder.node.canonical_name,
      nodeKind: holder.node.node_kind,
      domain: holder.node.domain,
      senseKey: holder.node.sense_key,
      culturalReferenceId: referenceId,
    });

    const claimant = await identity();
    await expect(
      upsertGraphIdentity(db, {
        canonicalKey: claimant.node.canonical_key,
        canonicalName: claimant.node.canonical_name,
        nodeKind: claimant.node.node_kind,
        domain: claimant.node.domain,
        senseKey: claimant.node.sense_key,
        culturalReferenceId: referenceId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // The holder keeps the reference; the claimant stays unlinked.
    expect(await nodeReferenceId(holder.node.id)).toBe(referenceId);
    expect(await nodeReferenceId(claimant.node.id)).toBeNull();
  });

  it('fails closed when creating a new identity with a reference another identity holds', async () => {
    const holder = await identity();
    const referenceId = await qlooReference(`ent-${randomUUID()}`);
    await upsertGraphIdentity(db, {
      canonicalKey: holder.node.canonical_key,
      canonicalName: holder.node.canonical_name,
      nodeKind: holder.node.node_kind,
      domain: holder.node.domain,
      senseKey: holder.node.sense_key,
      culturalReferenceId: referenceId,
    });

    await expect(
      upsertGraphIdentity(db, {
        canonicalKey: `atlas:work:${randomUUID()}`,
        canonicalName: `Another work ${randomUUID().slice(0, 6)}`,
        nodeKind: 'work',
        domain: 'art',
        senseKey: 'painting',
        culturalReferenceId: referenceId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await nodeReferenceId(holder.node.id)).toBe(referenceId);
  });
});

// --- The linkage pass ----------------------------------------------------------

describe('verified reference linkage', () => {
  it('binds compiler-shaped references to corpus identities by exact confirmed provider id, idempotently', async () => {
    const { node } = await identity();
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, {
      nodeId: node.id,
      provider: 'qloo',
      externalId: providerId,
      matchStatus: 'confirmed',
      provenance: 'Qloo entity lookup 2026-10-28 confirmed the id names this identity',
    });
    const referenceId = await qlooReference(providerId);

    const first = await linkGraphReferenceIdentities(db);
    expect(first.referencesLinked).toBe(1);
    expect(first.referencesMatched).toBe(1);
    expect(first.referenceLinksAmbiguous).toBe(0);
    expect(first.referenceLinksConflicting).toBe(0);
    expect(await nodeReferenceId(node.id)).toBe(referenceId);

    // Replay resolves the same pair and writes nothing new.
    const second = await linkGraphReferenceIdentities(db);
    expect(second.referencesLinked).toBe(0);
    expect(second.referencesAlreadyLinked).toBe(1);
    expect(await nodeReferenceId(node.id)).toBe(referenceId);
  });

  it('binds wikidata-keyed references through the canonical key arm', async () => {
    const { node } = await identity();
    const wikidataId = `Q${Math.floor(Math.random() * 1000000)}`;
    await mapGraphExternalId(db, {
      nodeId: node.id,
      provider: 'wikidata',
      externalId: wikidataId,
      matchStatus: 'confirmed',
      provenance: 'Wikidata wbsearchentities label+description lookup confirmed the mapping',
    });
    // A reference whose provider id lives only in its canonical key.
    const referenceId = await upsertReference(db, {
      canonicalKey: `wikidata:${wikidataId}`,
      name: `Keyed reference ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: {},
    });

    const result = await linkGraphReferenceIdentities(db);
    expect(result.referencesLinked).toBe(1);
    expect(await nodeReferenceId(node.id)).toBe(referenceId);
  });

  it('never links on name similarity or unconfirmed provider mappings', async () => {
    const name = `Famous work ${randomUUID().slice(0, 6)}`;
    const { node } = await identity({ name });

    // A reference with the same NAME but no matching provider id.
    const namesake = await upsertReference(db, {
      canonicalKey: `work:${randomUUID()}`,
      name,
      type: 'work',
      externalIds: {},
    });
    // This node's provider mapping is only a PROPOSAL: unconfirmed mappings
    // never verify a link, so its matching reference links nothing.
    const proposedId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: proposedId, matchStatus: 'proposed' });
    const proposedRef = await qlooReference(proposedId);
    // A CONFIRMED mapping on a different identity links its own reference.
    const confirmedId = `ent-${randomUUID()}`;
    const { node: other } = await identity();
    await mapGraphExternalId(db, { nodeId: other.id, provider: 'qloo', externalId: confirmedId, matchStatus: 'confirmed' });
    const confirmedRef = await qlooReference(confirmedId);

    const result = await linkGraphReferenceIdentities(db);
    // The namesake and the proposed-mapping reference link nothing to this
    // node; only the other identity's confirmed mapping links its reference.
    expect(await nodeReferenceId(node.id)).toBeNull();
    expect(await nodeReferenceId(other.id)).toBe(confirmedRef);
    const { rows: namesakeHolder } = await db.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [namesake],
    );
    expect(namesakeHolder).toHaveLength(0);
    const { rows: proposedHolder } = await db.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [proposedRef],
    );
    expect(proposedHolder).toHaveLength(0);
    expect(result.referenceLinksConflicting).toBe(0);
  });

  it('fails closed on ambiguous matches: one reference matching two identities, or one identity matched by two references', async () => {
    // Two identities, each confirmed for a different provider id...
    const { node: a } = await identity();
    const { node: b } = await identity();
    const qlooId = `ent-${randomUUID()}`;
    const wikidataId = `Q${Math.floor(Math.random() * 1000000)}`;
    await mapGraphExternalId(db, { nodeId: a.id, provider: 'qloo', externalId: qlooId, matchStatus: 'confirmed' });
    await mapGraphExternalId(db, { nodeId: b.id, provider: 'wikidata', externalId: wikidataId, matchStatus: 'confirmed' });
    // ...and ONE reference carrying both provider ids: ambiguous, so nothing binds.
    await upsertReference(db, {
      canonicalKey: `qloo:${qlooId}`,
      name: `Ambiguous reference ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: { qloo: qlooId, wikidata: wikidataId },
    });
    const ambiguousOne = await linkGraphReferenceIdentities(db);
    expect(ambiguousOne.referenceLinksAmbiguous).toBe(1);
    expect(ambiguousOne.referencesLinked).toBe(0);
    expect(await nodeReferenceId(a.id)).toBeNull();
    expect(await nodeReferenceId(b.id)).toBeNull();

    // One identity matched by TWO distinct references: also ambiguous. The
    // pass is global, so compare against the previous run's count: exactly the
    // two new references of the shared id become ambiguous, nothing else moves.
    const sharedId = `ent-${randomUUID()}`;
    const { node: c } = await identity();
    await mapGraphExternalId(db, { nodeId: c.id, provider: 'qloo', externalId: sharedId, matchStatus: 'confirmed' });
    await qlooReference(sharedId);
    await upsertReference(db, {
      canonicalKey: `work:second-${randomUUID()}`,
      name: `Duplicate provider id ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: { qloo: sharedId },
    });
    const ambiguousTwo = await linkGraphReferenceIdentities(db);
    expect(ambiguousTwo.referenceLinksAmbiguous - ambiguousOne.referenceLinksAmbiguous).toBe(2);
    expect(ambiguousTwo.referencesLinked - ambiguousOne.referencesLinked).toBe(0);
    expect(await nodeReferenceId(c.id)).toBeNull();
  });

  it('fails closed on competing bindings without changing another identity', async () => {
    // The node is already directly bound to a reviewed reference...
    const { node, referenceId: held } = await identity({ withReference: true });
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });
    // ...but a DIFFERENT reference carries the same provider id.
    const competing = await upsertReference(db, {
      canonicalKey: `work:duplicate-${randomUUID()}`,
      name: `Competing reference ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: { qloo: providerId },
    });

    const result = await linkGraphReferenceIdentities(db);
    expect(result.referenceLinksConflicting).toBe(1);
    expect(result.referencesLinked).toBe(0);
    // Fail closed: the held binding survives, the competing reference stays unbound.
    expect(await nodeReferenceId(node.id)).toBe(held);
    const { rows: holder } = await db.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [competing],
    );
    expect(holder).toHaveLength(0);
  });

  it('resolves only exact confirmed matches through the scoped reader used by expansion', async () => {
    const { node } = await identity();
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });
    const referenceId = await qlooReference(providerId);
    const unmatched = await upsertReference(db, {
      canonicalKey: `work:unmatched-${randomUUID()}`,
      name: `Unmatched reference ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: {},
    });

    const matches = await verifiedReferenceNodeMatches(db, { referenceIds: [referenceId, unmatched] });
    expect(matches.get(referenceId)).toEqual([node.id]);
    expect(matches.has(unmatched)).toBe(false);
  });
});

// --- Bilateral read-time resolution (DISC-SCR-017) ----------------------------------

describe('bilateral read-time resolution', () => {
  /**
   * `bilaterallyVerifiedReferenceNodes` is the read-time gate both expansion
   * fallbacks use: a verified (reference → identity) pair resolves ONLY when
   * the DURABLE linker would bind the same pair — global one-to-one
   * cardinality in both directions, an active identity, and compatible
   * existing bindings on both sides. Ambiguity (the inverse direction is
   * global: another reference may claim the identity from outside any local
   * scope) and competing bindings fail closed without changing stored links.
   */

  it('accepts the clean verified pair the durable linker would bind', async () => {
    const { node } = await identity();
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });
    const referenceId = await qlooReference(providerId);

    const verdict = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [referenceId] });
    expect([...verdict.acceptedByReference]).toEqual([[referenceId, node.id]]);
    expect(verdict.ambiguousReferenceIds).toHaveLength(0);
    expect(verdict.conflictingReferenceIds).toHaveLength(0);
  });

  it('rejects inverse ambiguity: an identity claimed by another reference anywhere stays unresolved', async () => {
    const { node } = await identity();
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });
    const first = await qlooReference(providerId);
    const second = await upsertReference(db, {
      canonicalKey: `work:second-${randomUUID()}`,
      name: `Duplicate provider id ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: { qloo: providerId },
    });

    // Scoped to the SECOND reference only: the claiming first reference sits
    // OUTSIDE the requested scope, exactly the production read shape.
    const scoped = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [second] });
    expect(scoped.acceptedByReference.size).toBe(0);
    expect(scoped.ambiguousReferenceIds).toEqual([second]);
    expect(scoped.conflictingReferenceIds).toHaveLength(0);
    // Both claiming references fail together when both are in scope...
    const both = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [first, second] });
    expect(both.acceptedByReference.size).toBe(0);
    expect([...both.ambiguousReferenceIds].sort()).toEqual([first, second].sort());
    // ...and nothing changed durably either way.
    expect(await nodeReferenceId(node.id)).toBeNull();
  });

  it('rejects a competing node binding: an identity already linked to a different reference', async () => {
    // The durable-pass competing fixture shape: the identity is directly
    // bound to a reviewed reference, while a different reference carries its
    // confirmed provider id.
    const { node, referenceId: held } = await identity({ withReference: true });
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });
    const competing = await upsertReference(db, {
      canonicalKey: `work:competing-${randomUUID()}`,
      name: `Competing reference ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: { qloo: providerId },
    });

    const verdict = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [competing] });
    expect(verdict.acceptedByReference.size).toBe(0);
    expect(verdict.conflictingReferenceIds).toEqual([competing]);
    expect(verdict.ambiguousReferenceIds).toHaveLength(0);
    // Fail closed: the held binding survives and the competing reference stays unheld.
    expect(await nodeReferenceId(node.id)).toBe(held);
    const { rows: holder } = await db.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [competing],
    );
    expect(holder).toHaveLength(0);
  });

  it('rejects a reference already held by a different identity', async () => {
    const holder = await identity();
    const providerId = `ent-${randomUUID()}`;
    const referenceId = await qlooReference(providerId);
    // The holder binds the reference by review (no provider-id mapping of
    // its own), while a different active identity holds the confirmed
    // provider mapping: the durable linker would reject that pair as a
    // competing reference binding.
    await bindGraphIdentityReference(db, { nodeId: holder.node.id, culturalReferenceId: referenceId });
    const { node: claimed } = await identity();
    await mapGraphExternalId(db, { nodeId: claimed.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });

    const verdict = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [referenceId] });
    expect(verdict.acceptedByReference.size).toBe(0);
    expect(verdict.conflictingReferenceIds).toEqual([referenceId]);
    expect(verdict.ambiguousReferenceIds).toHaveLength(0);
    // Fail closed: the holder keeps the reference and the claiming identity stays unbound.
    expect(await nodeReferenceId(holder.node.id)).toBe(referenceId);
    expect(await nodeReferenceId(claimed.id)).toBeNull();
  });

  it('resolves the already-durably-bound pair idempotently, and never resolves a non-active identity', async () => {
    // The same durable pair reads back as accepted (idempotent, like the
    // linker's already_bound outcome).
    const { node } = await identity();
    const providerId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: node.id, provider: 'qloo', externalId: providerId, matchStatus: 'confirmed' });
    const referenceId = await qlooReference(providerId);
    await bindGraphIdentityReference(db, { nodeId: node.id, culturalReferenceId: referenceId });

    const bound = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [referenceId] });
    expect([...bound.acceptedByReference]).toEqual([[referenceId, node.id]]);
    expect(bound.ambiguousReferenceIds).toHaveLength(0);
    expect(bound.conflictingReferenceIds).toHaveLength(0);

    // A merged/retired identity never resolves at read time, exactly as the
    // durable linker never binds one: the verified match stays unresolved
    // without being reported as ambiguous or conflicting.
    const { node: inactive } = await identity();
    const inactiveId = `ent-${randomUUID()}`;
    await mapGraphExternalId(db, { nodeId: inactive.id, provider: 'qloo', externalId: inactiveId, matchStatus: 'confirmed' });
    const inactiveReference = await qlooReference(inactiveId);
    await db.query(`UPDATE graph_nodes SET status = 'merged' WHERE id = $1`, [inactive.id]);

    const merged = await bilaterallyVerifiedReferenceNodes(db, { referenceIds: [inactiveReference] });
    expect(merged.acceptedByReference.size).toBe(0);
    expect(merged.ambiguousReferenceIds).toHaveLength(0);
    expect(merged.conflictingReferenceIds).toHaveLength(0);
  });
});
