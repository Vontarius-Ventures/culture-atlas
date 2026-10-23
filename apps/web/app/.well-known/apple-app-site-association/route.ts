const STORE_BUNDLES = [
  'com.cultureatlas.app',
  'com.cultureatlas.app.experimental',
  'com.aomg.cultureatlas',
] as const;

function teamId(): string {
  return (process.env.APPLE_TEAM_ID ?? 'U9XG3X374H').trim();
}

/** Apple App Site Association for iOS identity universal links. */
export function GET() {
  const team = teamId();
  const details = STORE_BUNDLES.map((bundle) => ({
    appID: `${team}.${bundle}`,
    paths: ['/identity/callback', '/identity/*'],
  }));
  const body = {
    applinks: {
      apps: [] as string[],
      details,
    },
  };
  return Response.json(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
  });
}
