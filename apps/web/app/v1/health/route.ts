import { NextResponse } from 'next/server';
import { getDb } from '@culture-atlas/domain';
import { getProviders } from '@culture-atlas/providers';

/** Liveness + capability statuses (no secrets, no details). */
export async function GET() {
  const db = await getDb()
    .query('SELECT 1')
    .then(() => true)
    .catch(() => false);
  const capabilities = Object.fromEntries(
    Object.entries(getProviders().capabilities()).map(([name, entry]) => [name, entry.status]),
  );
  return NextResponse.json({ ok: db, db, capabilities }, { status: db ? 200 : 503 });
}
