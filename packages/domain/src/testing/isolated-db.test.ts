import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from './isolated-db';

describe('isolated database cleanup', () => {
  it('closes its own pool and supports repeated cleanup', async () => {
    const isolated = await createIsolatedDatabase({ migrate: false });
    try {
      await isolated.db.query('SELECT 1');
      await isolated.drop();
      await expect(isolated.drop()).resolves.toBeUndefined();
    } finally {
      await isolated.drop();
    }
  });

  // PostgreSQL waits before refusing a connected DROP. Allow concurrent private
  // database creation in the full suite without weakening the refusal checks.
  it('refuses to terminate a connected client and can retry after the client closes', async () => {
    const isolated = await createIsolatedDatabase({ migrate: false });
    const other = new pg.Client({ connectionString: isolated.url });
    const connectionErrors: Error[] = [];
    other.on('error', (err) => connectionErrors.push(err));
    try {
      await other.connect();
      // Normal DROP must report the open connection, not kill it via FORCE.
      await expect(isolated.drop()).rejects.toMatchObject({ code: '55006' });
      expect((await other.query('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }]);
      expect(connectionErrors).toEqual([]);
    } finally {
      await other.end();
      await isolated.drop();
    }
  }, 45_000);
});
