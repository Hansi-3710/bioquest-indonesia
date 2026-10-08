# Security checklist before public launch

- Use private GitHub repository and never commit credentials.
- Require TLS for PostgreSQL and HTTPS for S3 and Vercel; restrict database access where possible.
- Keep storage bucket private; audit CORS origins and bucket policies.
- Add malware scanning and file-content inspection before researchers download uploads.
- Add email verification, account recovery, MFA for researchers, stronger rate limiting, and session revocation.
- Configure backup restoration tests, retention/deletion policies, log alerts and incident response.
- Test unauthorized access to every API route, CSRF, XSS, SQL injection, large uploads, and object storage permissions.
- Check privacy requirements for minors and biodiversity-sensitive locations before inviting users.
