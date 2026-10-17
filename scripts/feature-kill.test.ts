import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount } from '../packages/domain/src/testing';
import { parseKillArgs, runKillCommand, USAGE } from './feature-kill-lib';

const db = getTestDb();
afterAll(() => closeTestDb());

describe('ops:kill', () => {
  it('parses commands and rejects unknown or unkillable flags', () => {
    expect(parseKillArgs(['list'])).toEqual({ action: 'list' });
    expect(parseKillArgs(['kill', 'camera_video', '--reason', 'decoder incident'], 'ops')).toEqual({
      action: 'kill',
      flag: 'camera_video',
      accountId: null,
      reason: 'decoder incident',
      actor: 'ops',
    });
    expect(() => parseKillArgs(['kill', 'media_library', '--reason', 'x'])).toThrow(USAGE);
    expect(() => parseKillArgs(['kill', 'camera_video'])).toThrow(/--reason/);
    expect(() => parseKillArgs(['lift', 'camera_video', '--account', 'not-a-uuid'])).toThrow(
      /UUID/,
    );
  });

  it('kills and lifts a feature for one account', async () => {
    const account = await insertAccount();
    const kill = parseKillArgs([
      'kill',
      'meta_glasses_capture_enabled',
      '--account',
      account.accountId,
      '--reason',
      'SDK incident',
    ]);
    expect(await runKillCommand(db, kill)).toMatch(/^Killed meta_glasses_capture_enabled/);
    expect(await runKillCommand(db, kill)).toMatch(/already killed/);
    expect(await runKillCommand(db, { action: 'list' })).toContain(account.accountId);
    const lift = parseKillArgs([
      'lift',
      'meta_glasses_capture_enabled',
      '--account',
      account.accountId,
    ]);
    expect(await runKillCommand(db, lift)).toMatch(/^Lifted/);
    expect(await runKillCommand(db, lift)).toMatch(/^No active/);
  });
});
