# Identity integration contract

Identity owns verified email login/recovery and first-party native refresh
families. P5 owns agent OAuth, consent, and agent refresh families separately.

## Principals and credentials

`InstallationPrincipal` is `{kind:'installation', accountId:string,
installationId:string, sessionId:string, expiresAt:Date}`. It has no v1 scopes,
cannot enroll another installation, and is never an account-owner principal.
P1 explicitly allowlists installation operations under v2.

Native access tokens are opaque `cna_` + 32 random bytes (base64url), expire in
10 minutes, and are resolved against live family revocation on every call.
Refresh tokens are opaque `cnr_` + 32 random bytes, one-use, with 30-day idle and
90-day absolute expiry. Reusing a consumed refresh revokes the entire family,
including access tokens. Store both in Keychain/Keystore, never in URLs.

## Exported domain interface

```ts
// packages/domain/src/services/native-sessions.ts, exported as nativeSessions
type NativeSessionTokens = {
  session_id: string; installation_id: string; account_id: string;
  access_token: string; refresh_token: string;
  access_expires_at: string; refresh_expires_at: string;
};
type AuthorityEnded = {
  accountId: string; installationId: string | null; sessionId: string | null;
  reason: string; now: Date;
};
type AuthorityLifecycle = (tx: Db, event: AuthorityEnded) => Promise<void>;

// Register once at server startup. Hook must end capture/remote arm and fence
// pending uploads in this transaction, not just asynchronously.
setAuthorityLifecycle(hook: AuthorityLifecycle | undefined): void;
// P1 calls after same-owner enrollment/challenge; never expose as raw HTTP.
issueNativeSession(tx: Db, input: {
  accountId: string; installationId: string; authenticatedAt: Date;
}, now?: Date): Promise<NativeSessionTokens>;
resolveNativePrincipal(db: Queryable, token: string, now?: Date):
  Promise<InstallationPrincipal>;
rotateNativeSession(db: Db, refreshToken: string, now?: Date):
  Promise<NativeSessionTokens>;
revokeInstallationSessions(tx: Db, accountId: string, installationId: string,
  now?: Date): Promise<void>;
// P1 consumes this proof inside its enrollment transaction, verifies platform,
// creates/checks the same-owner installation, then calls issueNativeSession.
consumeNativeEnrollmentGrant(tx: Db, token: string, platform: 'ios'|'android',
  now?: Date): Promise<{accountId:string; authenticatedAt:Date}>;

// packages/domain/src/services/identity.ts, exported as identity
requireRecoverableAccount(ctx: ServiceContext): Promise<string>;
```

Issuance is a trusted internal API and requires P1's enrolled-installation
ownership predicate. The returned enrollment grant is NOT an API bearer, is
single-use, expires after five minutes, and binds the verified account and
platform. It cannot select a different account during exchange.

`identity_authority_events` persists `{id, account_id, installation_id nullable,
session_id nullable, reason, created_at}`. Null installation means every
installation for that account. Recovery, sign-out-all, refresh reuse,
installation revoke, and explicit switch write this event and invoke the
lifecycle hook within the revocation transaction. P1 must install the hook
before activating devices. A switch never rewrites old media/upload ownership;
local pending bytes retain their original account UUID and must wait for
reauthentication of that account or explicit deletion.

## HTTP

POST `/v2/identity/email/start`: `{email,purpose:'sign_in'|'verify'|'recover',
destination:'web'|'ios'|'android',state,nonce,code_challenge,claim_session?}`.
Always returns the same accepted response. IP/address rate limits apply.
`verify` requires a current authenticated password session for that exact
existing account email; no account IDs can be supplied by clients.

POST `/v2/identity/email/complete`: `{challenge_id,token,state,nonce,
code_verifier}`. Proof, state, nonce, S256 PKCE, expiry, initiating browser
session and one-use consumption are checked. Fixed destinations only:
`/identity/callback`, `cultureatlas://identity/callback`,
`https://app.cultureatlas.com/identity/callback`. No arbitrary redirects.
Web sets a new HttpOnly session cookie. Native returns a five-minute
`enrollment_grant` for P1's enrollment endpoint. Callback tokens are fragment
values delivered only to the mail adapter, not returned by email/start.

POST `/v2/identity/native/refresh`: `{refresh_token}`.
GET `/v2/identity/sessions`: owner-only session listing.
POST `/v2/identity/sessions/{id}/revoke`: owner-only, same-account lookup.
POST `/v2/identity/sign-out-all`: recent verified reauthentication required.
POST `/v2/identity/switch`: ends current authority, never changes ownership or
silently signs in another account; native clients authenticate the next account
through a fresh verified email flow. Browser sign-in rotates its cookie.

Auth exchange endpoints deliberately do not replay secret-bearing responses
from an idempotency cache. A consumed proof/refresh fails closed on replay.
Responses are `no-store` and never log credential/request bodies.

## Legacy account migration

Existing accounts use either demo email/password (`account_credentials`,
scrypt) or browser-only device demo accounts with no credentials. Neither is
verified today. Existing password accounts retain UUIDs by signing in with the
password, then proving email ownership through `purpose:verify`. An anonymous
email sign-in never auto-links a legacy email row: it returns the same accepted
start response but sends no login proof until password authentication plus
verification. Passwordless demo accounts cannot be recovered by guessed email;
the existing browser session must add/prove an unused email. No hardware ID,
display name, or email string alone is a recovery credential.

Anonymous conversion is explicit (`claim_session:true`), bound to the
initiating anonymous session, and uses the existing transactional claim
service. Unclaimed records do not move. Existing stored media keys remain
unchanged.
