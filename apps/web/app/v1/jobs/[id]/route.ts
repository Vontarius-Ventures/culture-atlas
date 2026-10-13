import { jobs } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getJob, ({ ctx, params }) => jobs.getJob(ctx, params));
