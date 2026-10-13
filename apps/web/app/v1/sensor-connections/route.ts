import { sensorConnections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.listSensorConnections, ({ ctx }) => sensorConnections.listSensorConnections(ctx));
export const POST = apiRoute(ROUTES.createSensorConnection, ({ ctx, body }) =>
  sensorConnections.createSensorConnection(ctx, body),
);
