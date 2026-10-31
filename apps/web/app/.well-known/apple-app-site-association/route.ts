const STORE_BUNDLES = [
  'com.cultureatlas.app',
  'com.cultureatlas.app.experimental',
  'com.aomg.cultureatlas',
] as const;

function teamId(): string {
  // Compose passes an unset variable as an empty string.
  return process.env.APPLE_TEAM_ID?.trim() || 'U9XG3X374H';
}

/** Apple App Site Association for iOS identity universal links. */
export function GET() {
  const team = teamId();
  // Only iOS email links open the app; web sign-in callbacks stay in the browser.
  const body = {
    applinks: {
      details: [
        {
          appIDs: STORE_BUNDLES.map((bundle) => `${team}.${bundle}`),
          components: [{ '/': '/identity/callback', '?': { destination: 'ios' } }],
        },
      ],
    },
  };
  return Response.json(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
  });
}
