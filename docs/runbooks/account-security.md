# Runbook: account security (lost phone, compromise, email outage)

Identity rules are in specs/capture-platform-v2/IDENTITY-CONTRACT.md. Support
never changes account ownership, never moves media between accounts and never
signs anyone in on a user's behalf.

## Lost or stolen phone

The user, signed in on a browser, opens **Settings → Devices** (or
`/identity/sessions`) and removes the phone. `DELETE /v2/devices/{id}`:

- revokes every native session family for that installation;
- ends capture sessions and remote arming, aborts that phone's pending
  uploads, clears its push token, in the same transaction;
- keeps media already in the library.

## "Someone else is in my account"

1. The user runs **Recover account** from `/identity` (email proof). Recovery
   signs out every browser and phone, revokes enrollment grants and other
   email proofs, and removes any legacy password.
2. If they still have a fresh session they can use **Sign out of all
   devices** on `/identity/sessions`. It requires an email verification from
   the last 5 minutes; the page sends them through it.
3. If abuse continues while the user cannot act, kill capture for the account
   as a stop-gap (it does not lock reads):
   `sudo atlas-ops pnpm ops:kill kill file_photo_upload --account <uuid> --reason "<ticket>"`
   (plus `camera_photo`, `camera_video`, `file_video_upload`,
   `meta_glasses_capture_enabled` as needed).

## Refresh-token reuse

A reused native refresh token revokes the whole family and records
`identity_authority_events.reason='refresh_reuse'`. Spikes for one account
mean a copied token or a broken client; spikes across many accounts after a
release mean a client bug (check the release before suspecting attackers).

```sql
SELECT date_trunc('hour', created_at) AS hour, reason, count(*)
FROM identity_authority_events WHERE created_at > now() - interval '1 day' GROUP BY 1,2 ORDER BY 1;
```

## Sign-in link delivery problems

Sign-in, verification and recovery depend on the configured mail driver. In
production (on-prem Compose) that is the spec's file mailbox
(`IDENTITY_MAIL_DRIVER=file`): no email is sent, and each link is a 0600 JSON
file in the `mailbox` volume of the `web` container. Failures return the same
neutral response (no enumeration) and consume the failed proof.

1. Check that the newest link was written:
   `docker compose exec web sh -c 'ls -t /var/lib/culture-atlas/mail | head'`
   (docs/deploy.md, "Identity mail" row). A write error usually means the
   volume is full or not owned by the `node` user.
2. Logs: `identity_mail_misconfigured` at startup means the driver settings
   are incomplete. The app then fails closed with 503 for email start in
   production instead of pretending to send.
3. Existing browser and phone sessions keep working during an outage.
