import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isAppError, traces } from '@culture-atlas/domain';
import { getServerContext } from '@/lib/server/session';
import { InspectorView } from './inspector-view';

/**
 * /inspector/{jobId} — owner-controlled "Show how it works" view for the demo.
 * Server-rendered with the same service as GET /v1/demo/traces/{job_id}:
 * only the owning demo owner (accounts.is_demo_owner or
 * DEMO_INSPECTOR_ACCOUNT_IDS) sees it; everyone else gets a 404. Nothing in
 * the consumer flow links here.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'How it works · culture atlas',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InspectorPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID.test(jobId)) notFound();
  const ctx = await getServerContext();
  if (!ctx) notFound();
  let trace;
  try {
    trace = await traces.getTrace(ctx, { job_id: jobId });
  } catch (err) {
    if (isAppError(err) && (err.code === 'not_found' || err.status === 403 || err.status === 401)) notFound();
    throw err;
  }
  return <InspectorView trace={trace} />;
}
