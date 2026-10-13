import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { consumeDailyQuota, enforceIpLimit, ipBucket, secondsUntilUtcMidnight, tryConsume, utcDay } from './quotas';
import { closeTestDb, getTestDb, insertAccount, insertAnonymousSession, testConfig } from './testing';

const db = getTestDb();
afterAll(closeTestDb);

describe('quotas', () => {
  it('tryConsume is atomic and never exceeds the limit', async () => {
    const bucket = `test:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => tryConsume(db, { bucket, metric: 'm', day: '2026-10-13', limit: 5 })));
    expect(results.filter((r) => r !== null)).toHaveLength(5);
    expect(results.filter((r) => r === null)).toHaveLength(3);
  });

  it('anonymous sessions get their own daily plan/analysis buckets', async () => {
    const config = testConfig({ ANON_DAILY_ANALYSES: '2' });
    const a = await insertAnonymousSession(db);
    const b = await insertAnonymousSession(db);
    const now = new Date('2026-10-13T12:00:00Z');
    await consumeDailyQuota(db, { principal: a, metric: 'analyses', config, now });
    await consumeDailyQuota(db, { principal: a, metric: 'analyses', config, now });
    await expect(consumeDailyQuota(db, { principal: a, metric: 'analyses', config, now })).rejects.toMatchObject({
      code: 'quota_exceeded',
      status: 429,
      retryAfter: 12 * 3600,
    });
    // Another anonymous visitor is unaffected (no merging of anonymous users).
    await consumeDailyQuota(db, { principal: b, metric: 'analyses', config, now });
    // A new day starts fresh.
    await consumeDailyQuota(db, { principal: a, metric: 'analyses', config, now: new Date('2026-10-14T00:00:01Z') });
  });

  it('accounts and their agents share the account bucket', async () => {
    const config = testConfig({ ACCOUNT_DAILY_PLANS: '1' });
    const acct = await insertAccount(db);
    const now = new Date();
    await consumeDailyQuota(db, { principal: acct, metric: 'plans', config, now });
    await expect(consumeDailyQuota(db, { principal: acct, metric: 'plans', config, now })).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('per-IP limits hash the address and return rate_limited', async () => {
    const config = testConfig({ IP_DAILY_REQUESTS: '2' });
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
    expect(ipBucket(ip, 's')).not.toContain(ip);
    const now = new Date();
    await enforceIpLimit(db, { ip, config, now });
    await enforceIpLimit(db, { ip, config, now });
    await expect(enforceIpLimit(db, { ip, config, now })).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await enforceIpLimit(db, { ip: null, config, now });
  });

  it('computes UTC days and reset times', () => {
    expect(utcDay(new Date('2026-10-13T23:59:59Z'))).toBe('2026-10-13');
    expect(secondsUntilUtcMidnight(new Date('2026-10-13T23:59:00Z'))).toBe(60);
  });
});
