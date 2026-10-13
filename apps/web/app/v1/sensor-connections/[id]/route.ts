import { sensorConnections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const DELETE = apiRoute(ROUTES.deleteSensorConnection, ({ ctx, params }) =>
  sensorConnections.deleteSensorConnection(ctx, params),
);
