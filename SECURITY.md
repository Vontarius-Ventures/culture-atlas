# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security > Report a vulnerability** form on this repository, not in a public issue. Include steps to reproduce and the affected commit. This is a small project and we'll respond as quickly as we can.

Please don't test against other people's accounts or data on the live demo.

## Security model

- **Owner-scoped data.** Captures, libraries, collections and analyses belong to one account. Requests for another account's data look like `not_found`.
- **Sign-in.** Email links are one-use and short-lived, and the proof travels in the URL fragment. Native sign-in also requires a PKCE verifier held by the phone that asked, so a forwarded link is not enough.
- **Agents.** MCP access uses scopes the owner grants and can narrow or revoke. Tokens are stored as hashes. Agents can be limited to selected collections.
- **Media.** Stored privately, with ownership rechecked on every read and range request, so deleting something also ends access through links already issued. Photo metadata, including GPS, is stripped from the derivative used for analysis.
- **Secrets.** Provider keys stay on the server, in configuration outside the repository. Production refuses to start with development secrets or the local file mailbox.
- **Logs.** The app logs ids, timings and safe error codes, not images, tokens or message contents.

## Known limits

This is a hackathon build and has not had an independent security review. The live demo runs on one machine, and its backups are not kept off that machine. Don't store anything there you can't afford to lose.
