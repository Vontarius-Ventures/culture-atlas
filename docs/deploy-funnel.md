# Mac hosting with Tailscale Funnel

This is the optional on-prem edge when router forwarding is unavailable.
It does not require Cloudflare, nameserver changes, or a purchased hostname.
Use a **dedicated Tailscale container**, never reset the Mac's existing Serve
or Funnel configuration.

## Deployment

- Colima profile and Docker context: `culture-atlas-production` and
  `colima-culture-atlas-production`. The isolated VM uses 4 CPUs, 8 GiB RAM,
  and an 80 GiB disk. Other profiles and the global Docker context are unchanged.
- Bootstrap the edge with `docker compose -f docker-compose.funnel.yml up -d`
  in that explicit Docker context. Complete its device login in Tailscale.
- Put production secrets in a mode-600 file outside Git and the build context,
  for example `../.culture-atlas-deploy/production.env`. Generate independent
  database, session, storage-signing, and Garage secrets. Use a domain-restricted
  **sending-only** Resend key.
- Initialize the fresh Garage layout and private bucket using
  [production-readiness.md §4](production-readiness.md#4-object-store-garage-one-time-setup).
  The current single-node layout assigns 40 GB, not the example's 500 GB.

Always merge **all three files** for the full stack:

```sh
docker --context colima-culture-atlas-production compose \
  --env-file ../.culture-atlas-deploy/production.env \
  -f docker-compose.yml \
  -f docker-compose.funnel.yml \
  -f docker-compose.funnel-private.yml \
  up -d --no-build --wait --wait-timeout 180
```

Build/load the runtime image first with the configured `ATLAS_RELEASE`.
The last file requires Compose 2.24+ and removes inherited host port bindings.
Keep `COMPOSE_PROFILES` empty: do not also start the base public Caddy edge.
`ACME_EMAIL` is still required by base-file interpolation but is unused here;
Tailscale manages certificates.

Set `APP_BASE_URL=https://<dedicated-node>.ts.net`,
`APP_HOST=<dedicated-node>.ts.net`,
`MEDIA_HOST=<dedicated-node>.ts.net:8443`,
`S3_ENDPOINT=https://<dedicated-node>.ts.net:8443`, and
`TRUSTED_PROXY_HOPS=2`. Retain path-style S3 and the private bucket.
Missing analysis/provider keys leave those features unavailable; this hosting
setup does not authorize additional model spending or qualify recommendations.

After the backend is healthy, configure the two listeners **sequentially**:

```sh
docker --context colima-culture-atlas-production exec culture-atlas-tailscale-1 \
  tailscale funnel --bg --yes --https=443 http://127.0.0.1:3100
docker --context colima-culture-atlas-production exec culture-atlas-tailscale-1 \
  tailscale funnel --bg --yes --https=8443 http://127.0.0.1:3901
```

Funnel state and node identity persist in `tailscale-state`. App/database/Garage
publish no host ports. Caddy listens only on shared-namespace loopback, trusts
only loopback proxies, preserves the public Host/path for S3 signatures, and
streams responses. Its listener addresses deliberately have **no Host matcher**.
Mounting the configuration directory avoids stale file binds after atomic edits.
Reload changes with `caddy reload --config /etc/culture-atlas/Caddyfile.funnel
--adapter caddyfile` inside the proxy container.

## Current installation and checks

- App: `https://culture-atlas.tail463884.ts.net`
- Private signed media: the same hostname on HTTPS port `8443`.
- Verified mail domain: `mail.futarchists.com`; sender:
  `culture atlas <no-reply@mail.futarchists.com>`. Existing website and mail DNS
  records and nameservers were preserved.
- Both native Debug local overrides use the app origin. Physical iPhone uses
  the existing signed factory build, without account or Keychain resets.
- Check that `/v1/health` returns real application JSON, not merely HTTP 200.
  Verify an invalid email-start body is rejected without dispatching email.
- Verify public multipart signing, ETag receipts, read/range requests, CORS,
  and unsigned-access denial. Probe objects must be uniquely named and cleaned
  up; never print credentials or signed URLs. Finally confirm an actual sign-in
  email arrives and its link works on the initiating phone.

## Operation and limits

The local LaunchAgent `ai.culture-atlas.funnel-vm` starts/supervises only this VM
at user login. It runs Colima in the foreground under `caffeinate -is`; container
restart policies recover the running services. No system power, FileVault,
automatic-login, or global Tailscale settings are changed.

Keep the Mac powered, connected, and logged in. Recovery after user login is
not a guarantee of availability before login after a power failure.
The current Tailscale device key expires **2027-04-29 UTC**: renew before that
date. Key expiry was not disabled. Preserve node state to preserve the hostname.
Funnel has bandwidth limits and is not a substitute for a hosting SLA.

Data lives on this VM's persistent volumes. **No off-Mac backup is configured**;
use the existing backup/restore runbook before relying on it for irreplaceable
media. Never remove the profile or volumes as a troubleshooting shortcut.
