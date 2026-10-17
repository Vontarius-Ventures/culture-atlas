/**
 * libpq environment for pg_dump/pg_restore child processes.
 *
 * libpq does NOT expand a connection URI placed in PGDATABASE (only an
 * explicit dbname argument is expanded), and putting the URI on argv exposes
 * the password in `ps`. So the URI is split into the standard variables.
 */
export function libpqEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Expected a postgres:// connection URL.');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    PGHOST: decodeURIComponent(url.hostname) || 'localhost',
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  const sslrootcert = url.searchParams.get('sslrootcert');
  if (sslrootcert) env.PGSSLROOTCERT = sslrootcert;
  return env;
}
