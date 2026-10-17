# Runbook: glasses kill switch

Use when Meta glasses capture misbehaves (wrong account media, stuck
recording, SDK incident), when Meta or a store asks us to stop, or when an
SDK/terms eligibility gate lapses.

## What a kill does

`meta_glasses_capture_enabled` is evaluated server-side on every request
(packages/domain/src/flags/feature-flags.ts). A kill:

- makes `GET /v2/capabilities` report `meta_glasses.available=false` with
  reason `temporarily_disabled` (the app shows the screen 09 "unavailable"
  explanation; the Experimental entry stays visible);
- rejects new glasses capture sessions and glasses uploads (`scope_denied`);
- also turns off `remote_glasses_capture_enabled` and
  `meta_glasses_audio_enabled`, which depend on it;
- does NOT delete media, revoke devices, or block library reads, deletion or
  phone-camera capture.

Commands already queued to a phone are re-checked at claim and before
execution, so they are cancelled instead of firing.

## Kill for everyone

```sh
sudo atlas-ops pnpm ops:kill kill meta_glasses_capture_enabled --reason "<incident id>: <short why>"
```

Takes effect on the next request; no deploy or restart. Alternative without
database access: add `meta_glasses_capture_enabled` to `FEATURE_KILL_SWITCHES`
in SSM (`/culture-atlas/<env>/FEATURE_KILL_SWITCHES`) and run
`sudo atlas-reload` to restart with the new environment.

## Kill for one account

```sh
sudo atlas-ops pnpm ops:kill kill meta_glasses_capture_enabled --account <account uuid> --reason "<ticket>"
```

Use the account UUID from logs or the support tool; never search by email in
shared channels.

## Kill only remote (agent) capture

```sh
sudo atlas-ops pnpm ops:kill kill remote_glasses_capture_enabled --reason "<why>"
sudo atlas-ops pnpm ops:kill kill agent_remote_capture_enabled --reason "<why>"
```

Phone users can still capture locally.

## Verify

1. `sudo atlas-ops pnpm ops:kill list` shows the kill.
2. With a test phone: the glasses entry shows "temporarily unavailable";
   starting a glasses session fails; the library still loads.
3. Logs show no new `device_push` events with outcome `sent` for glasses
   sessions after the kill.

## Lift

Only after the cause is fixed and the release owner agrees:

```sh
sudo atlas-ops pnpm ops:kill lift meta_glasses_capture_enabled
```

Lifting does not force anything on: every activation rule (qualified build in
`META_GLASSES_QUALIFIED_BUILDS`, entitled platform, rollout, permission, fresh
heartbeat) still has to pass. Phones never re-arm automatically; users arm
remote capture again on the phone.

## Record

Incident ID, who killed and lifted (the `created_by` column), times, scope
(global or account UUID) and the reason. No user content.
