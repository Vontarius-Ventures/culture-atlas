import type { Queryable } from '../packages/domain/src/db/pool';
import {
  KILLABLE_FLAGS,
  isKillableFlag,
  liftFeatureKill,
  setFeatureKill,
} from '../packages/domain/src/flags/feature-flags';

export type KillCommand =
  | { action: 'list' }
  | { action: 'kill'; flag: string; accountId: string | null; reason: string; actor: string }
  | { action: 'lift'; flag: string; accountId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USAGE = `Usage:
  pnpm ops:kill list
  pnpm ops:kill kill <flag> --reason "<why>" [--account <uuid>] [--actor <name>]
  pnpm ops:kill lift <flag> [--account <uuid>]
Flags: ${KILLABLE_FLAGS.join(', ')}`;

export function parseKillArgs(argv: string[], defaultActor = 'operator'): KillCommand {
  const [action, flag, ...rest] = argv;
  const option = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (action === 'list') return { action };
  if ((action !== 'kill' && action !== 'lift') || !flag || !isKillableFlag(flag))
    throw new Error(USAGE);
  const account = option('account') ?? null;
  if (account !== null && !UUID.test(account))
    throw new Error('--account must be an account UUID.');
  if (action === 'lift') return { action, flag, accountId: account };
  const reason = option('reason')?.trim();
  if (!reason || reason.length > 200)
    throw new Error('--reason is required (at most 200 characters).');
  const actor = (option('actor') ?? defaultActor).slice(0, 100);
  return { action, flag, accountId: account, reason, actor };
}

/** Prints IDs, flags and reasons only; never account emails or media. */
export async function runKillCommand(db: Queryable, command: KillCommand): Promise<string> {
  if (command.action === 'list') {
    const { rows } = await db.query<{
      flag: string;
      account_id: string | null;
      reason: string;
      created_by: string;
      created_at: Date;
    }>(
      `SELECT flag,account_id,reason,created_by,created_at FROM feature_flag_kills
       WHERE lifted_at IS NULL ORDER BY created_at`,
    );
    if (!rows.length) return 'No active kill switches.';
    return rows
      .map(
        (r) =>
          `${r.flag}\t${r.account_id ?? 'global'}\t${r.created_at.toISOString()}\t${r.created_by}\t${r.reason}`,
      )
      .join('\n');
  }
  const scope = command.accountId ? `account ${command.accountId}` : 'all accounts';
  if (command.action === 'kill') {
    const result = await setFeatureKill(db, command);
    return result.created
      ? `Killed ${command.flag} for ${scope}. Takes effect on the next request.`
      : `${command.flag} was already killed for ${scope}.`;
  }
  const result = await liftFeatureKill(db, command);
  return result.lifted
    ? `Lifted the ${command.flag} kill for ${scope}. Activation rules still apply.`
    : `No active ${command.flag} kill for ${scope}.`;
}
