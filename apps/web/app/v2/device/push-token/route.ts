import { devicePushTokenRoute } from '@/lib/server/device-push-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const PUT = devicePushTokenRoute;
export const DELETE = devicePushTokenRoute;
