import { agentCommands, AppError } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';
export const POST = agentRoute(ROUTES.requestCapture, ({ ctx, params, body, request }) => {
  const key = request.headers.get('idempotency-key');
  if (!key) throw new AppError('invalid_input', { message: 'Idempotency-Key is required.' });
  return agentCommands.requestCapture(ctx, params.id, body, key);
});
