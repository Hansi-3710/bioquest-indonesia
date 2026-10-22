# Security

## How data is protected

| Asset | Protection |
|---|---|
| **Passwords** | Argon2id (64 MiB, 3 passes) over an HMAC-peppered input. 12+ character minimum, common-password blocklist. Equal-time responses for unknown emails. |
| **Emails** | Never stored in clear. AES-256-GCM ciphertext + keyed HMAC "blind index" for lookup. |
| **Photos & videos** | Validated by real file signature, images re-encoded (strips EXIF/GPS, defeats polyglot files), then encrypted with a **unique AES-256-GCM key per file**. That key is wrapped by a master key (KEK, rotatable). Ciphertext sits under random names outside the web root; tampering is detected on read. |
| **Locations & notes** | Exact GPS and notes are encrypted. Only a coarse grid cell (~11 km; ~55 km for protected species) is stored in clear and shown on maps. Researchers can request exact points; each request is audit-logged. |
| **Sessions** | 256-bit random token, only its SHA-256 stored. Cookie is `HttpOnly`, `Secure` (prod), `SameSite=Strict`, `__Host-` prefixed. Idle + absolute timeouts (researchers: 20 min / 8 h). All sessions end on password change. |
| **CSRF** | SameSite=Strict + Origin / Sec-Fetch-Site checks + per-session token header on every state-changing call. |
| **Researcher access** | Created only by an administrator on the server. Password **and** TOTP two-factor (replay-protected) required before any research API works. Account lockout after 5 failures. |
| **Database** | App runs as a non-owner role with **Row-Level Security**: users see only their rows; researchers see only sightings whose owners consented. Even a buggy route or SQL injection cannot read other users' data. The training worker has its own role: read-only access to verified + consented media, no access to users. Audit log is insert-only. |
| **Audit trail** | Hash-chained (each entry commits to the previous). `npm run audit:verify` detects edits or deletions. |
| **Web hardening** | Strict CSP (no inline/third-party scripts, self-hosted fonts), HSTS, frame denial, no-referrer, `nosniff`, `Permissions-Policy`, rate limits on login/sign-up/upload/2FA, request size limits, generic errors (no stack traces). |
| **Privacy by design** | Research sharing is opt-in; users can withdraw, download all their data, or delete their account (rows **and** encrypted files). Training manifests contain no user ids, names, or exact locations. |
| **Supply chain** | Dependabot, `npm audit` + secret scanning in CI, container runs as non-root with dropped capabilities. |

## Reporting a vulnerability
Please email the maintainers privately (add your contact here) rather than opening a public issue.

## Not covered yet (read before launching publicly)
* **Email verification and password reset by email** are not implemented (needs an email provider). Until then, password recovery is manual.
* **Children's data.** Students are a likely audience. Indonesia's Personal Data Protection Law (UU PDP 27/2022) and school policies may require parental/guardian consent and a formal privacy notice. Get this reviewed by a lawyer or your institution; the in-app text is a starting point, not legal advice.
* **Malware scanning** of uploads is not included (files are re-encoded or stored encrypted and never executed or served inline).
* **Key management.** Keys live in `.env`. For production use a secrets manager or KMS/HSM and restrict who can read them.
* **Single-server vault.** Encrypted files are on local disk. For multiple servers, swap `src/services/vault.js` for an S3-compatible bucket (the files are already encrypted client-side).
* **Models cannot "forget".** Withdrawing consent removes photos from future training; already-trained models are not retrained automatically.
* **Pen-test.** Automated tests cover the controls above, but an independent security review is recommended before handling real user data.
