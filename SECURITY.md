# Security policy

## Supported version

Security fixes are applied to the current `main` branch and the latest production release.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, tokens or private media paths. Contact the repository owner privately with the affected version, impact and reproduction steps.

## Security controls

- Authentication uses seven-day HS256 JWTs in `HttpOnly`, `SameSite=Strict` cookies. Production requires a configured secret of at least 32 characters. Current account existence and role are checked on each authenticated request.
- Administrative operations require the `admin` role; media reads require an authenticated session.
- Webhook destinations are restricted to public HTTP(S) addresses and pinned after DNS resolution to mitigate SSRF and DNS rebinding.
- HTTP byte ranges are strictly parsed and bounded.
- Forwarded headers are ignored unless the proxy address is explicitly trusted. Browser mutations check Origin; LAN HTTP remains supported without forcing HTTPS.
- Media paths are checked against configured roots, and FFmpeg inputs cannot open network protocols. These checks are not an OS sandbox for malicious media files.
- Job deletion preserves media; replacement stages output before publication. See the audit for filesystem/DB crash-consistency limits.
- Helmet applies a restrictive Content Security Policy; browser dependencies are served locally.
- CI audits dependencies, scans tracked files for common secret material and validates JavaScript syntax before packaging.
- Production deploys exclude `.env`, data, media, Git metadata and dependencies. They create a rollback snapshot and update both instances from one immutable artifact.

No automated audit proves the absence of every vulnerability. Keep Node.js, FFmpeg, GPU drivers and the operating system patched, and review exposed network paths regularly.
