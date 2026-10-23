import { requireAccount } from '../authz';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { getCommand } from './agent-commands';
import { getAnalysis, getUpload } from './agent-media';

export async function getOperation(ctx: ServiceContext, id: string) {
  const account = requireAccount(ctx.principal);
  const command = await ctx.db.query('SELECT id FROM device_commands WHERE id=$1 AND account_id=$2', [id, account.accountId]);
  if (command.rowCount) {
    const value = await getCommand(ctx, id);
    return { schema_version: '2.1' as const, request_id: ctx.requestId, id, kind: 'command' as const,
      state: value.state, result_id: value.result_asset_id, error_code: value.error_code };
  }
  const analysis = await ctx.db.query('SELECT id FROM media_analysis_requests WHERE id=$1 AND account_id=$2', [id, account.accountId]);
  if (analysis.rowCount) {
    const value = await getAnalysis(ctx, id);
    if (!value) throw new AppError('not_found');
    return { schema_version: '2.1' as const, request_id: ctx.requestId, id, kind: 'analysis' as const,
      state: value.state, result_id: value.asset_id, error_code: value.error_code };
  }
  const upload = await getUpload(ctx, id);
  if (!upload) throw new AppError('not_found');
  return { schema_version: '2.1' as const, request_id: ctx.requestId, id, kind: 'upload' as const,
    state: upload.state, result_id: upload.asset_id, error_code: upload.error_code };
}
