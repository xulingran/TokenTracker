# Self-hosted private backend installation

The local branch now contains a clean TokenTracker application installer and a private-function deployment manifest. They install free private synchronization on a compatible InsForge instance. They do not create the InsForge platform or complete VPS, browser, or packaged desktop acceptance.

Reconciled on 2026-11-21. The current manifest has 16 application steps, including the gift schema and the order-cancellation schema needed by the shared billing handler; self-hosted gifts and paid checkout remain unavailable. The official-stack 13/14-step results below are historical, not proof of an upgrade to the current manifest. See the [release handoff](cloud-release-readiness.md) and [remaining acceptance](self-hosting-remaining-acceptance.md) for current gates.

InsForge provides its own PostgreSQL/auth/API/function runtime. Install it in a separate directory using a reviewed release and pinned image digests. Its official README documents MCP support for self-hosted administration; the cloud CLI is not a VPS installer. [Official platform instructions](https://github.com/InsForge/InsForge#self-hosted-docker-compose)

## Required platform contract

The target database must already provide `auth.users(id uuid)`, `auth.uid()`, and roles `anon`, `authenticated`, and `project_admin`. The server role must have `BYPASSRLS`, schema usage on `auth`, and permission to read `auth.users.id`. The installer checks these prerequisites and does not create or alter the platform's authentication system. A platform administrator must confirm the selected release supplies this contract; the minimum check does not require reading password or profile columns.

Run the installer as the database owner in a new application database. It refuses a pre-existing TokenTracker database without its installation ledger. Do not execute all historical migrations. Production moderation cohorts and data repairs are excluded from this manifest.

## Generate and install the application schema

Run from the reviewed application checkout after `npm ci` and the dashboard dependencies are installed:

```sh
node scripts/self-host/install.cjs --sql /absolute/private/path/tokentracker-install.sql
```

Review the generated SQL and the target connection. On the self-hosted server, execute the complete file in one transaction with the selected database's PostgreSQL client:

```sh
psql --set ON_ERROR_STOP=1 --file /absolute/private/path/tokentracker-install.sql
```

The generated file contains its own transaction and advisory installation lock. Use your server's protected connection configuration. Do not put passwords in the command line or commit connection files. The generator only writes a file; it does not connect to a hosted project.

For a CLI-linked InsForge instance, use the platform migration mode. The ordinary SQL API rejects explicit `BEGIN`/`COMMIT`; the migration API supplies the transaction:

```sh
node scripts/self-host/install.cjs --migration /absolute/private/context/migrations/20261008190000_tokentracker-self-host.sql
cd /absolute/private/context
npx -y @insforge/cli@0.2.8 current --json
npx -y @insforge/cli@0.2.8 db migrations up --all --yes --json
```

Confirm `current.project.oss_host` is your own instance before applying. Use a fresh migration version. This mode retains the same advisory transaction lock and manifest checksums without nesting a transaction. Repeat unchanged contents under another version to verify the installation ledger; do not edit an applied migration.

`tokentracker_self_host_installations` records each manifest step and its SHA-256 checksum. Running the unchanged installer again preserves users, tokens and usage. Changed installed steps or missing required functions cause an error instead of silently replacing an existing installation. Upgrade through a separately reviewed manifest; do not erase the ledger or edit an already-installed migration to force a retry.

The manifest installs device identities/tokens/codes, raw hourly usage, account-level session snapshots, owner-scoped usage cache invalidation, the private aggregation RPCs and the current Cloud contract. Financial tables exist for API compatibility but contain no merchant credentials or sample orders. Waffo authorization audits are included as schema only. Public leaderboards, avatars and production moderation data are outside this private backend package. Archival is not enabled; retained private history stays in PostgreSQL until the instance owner installs a separately verified retention strategy.

The 2026-11-21 order-cancellation update adds the sixteenth installation step. It supplies the cancellation columns and receipts read by the shared billing handler; without it, the account endpoint fails on `cancel_requested_at`. The current 16-step installer and unchanged reinstall pass the self-host test suite, including the billing account response, two-user private access, device flow and RLS checks. Gifts remain unavailable in self-hosted mode; private synchronization stays free. This narrow check does not replace the earlier real InsForge authentication and browser evidence below.

## Explicit free instance policy

The final installation step selects `hosting_mode='self_hosted'` for the instance's Cloud environments. Existing hosted instances retain `hosting_mode='hosted'` when the new policy migration is applied independently.

A valid existing account receives private read/upload access without orders or a trial. Device quotas and hosted history windows do not apply. Per-request batch-size limits, device/token ownership, paused devices, token revocation, authentication and private RPC permissions continue to apply. The server does not impose the hosted synchronization interval; clients retain their configured polling schedule. Free access is not implemented by leaving the instance in `preview` or recording fake purchases. Trial and purchase RPCs explicitly reject creating paid entitlement records in this mode.

## Build the private functions

```sh
node scripts/self-host/build-functions.cjs /absolute/private/path/tokentracker-functions
```

Deploy every entry in the generated `functions.json` through the self-hosted platform's reviewed management interface. The 14 entries include device authorization/grant/poll/token issuance/rename, ingestion, seven account reads, and the account/device billing API. Relative local imports are bundled. The async CommonJS output supports the official v2.3.3 worker's `new Function` executor; an active ESM deployment can still fail at invocation. InsForge SDK imports are pinned to `1.4.5`, and payment-library dependencies retain the reviewed lockfile versions. Payment webhooks and official public-community functions are excluded.

The device-authorize build adapts the verification link to `TOKENTRACKER_DASHBOARD_URL`; it requires HTTPS, or loopback HTTP for local verification. It fails configuration checks instead of directing users to the official dashboard. The source-file adaptation has explicit anchors and fails when the source changes, so a future upgrade requires review.

Provide only the server configuration needed by those functions:

```dotenv
INSFORGE_BASE_URL=https://api.your-domain.example
INSFORGE_SERVICE_ROLE_KEY=your-server-only-service-credential
ANON_KEY=your-public-anonymous-key
JWT_SECRET=your-platform-signing-secret
TOKENTRACKER_DASHBOARD_URL=https://dashboard.your-domain.example
TOKENTRACKER_BILLING_ENVIRONMENT=live
```

Use `JWT_PUBLIC_KEY` instead of `JWT_SECRET` when the selected platform signs user sessions with RS256. Verify the real platform credentials and claims; do not assume its management `ACCESS_API_KEY` is interchangeable with an edge database credential. Do not configure Waffo, Paddle, WeChat Pay or Alipay keys for this personal instance.

On the verified official v2.3.3 stack, the generated handler reads reserved `INSFORGE_INTERNAL_URL` for backend calls and falls back to `INSFORGE_BASE_URL` when no internal URL exists. It uses reserved `API_KEY` only when no explicit `INSFORGE_SERVICE_ROLE_KEY` is provided. These aliases apply inside the self-hosted handler; they do not change the public dashboard URL or global environment. The official stack supplies its signing keys and anonymous key through its server secret store.

Build the dashboard with its own `VITE_INSFORGE_BASE_URL` and `VITE_INSFORGE_ANON_KEY`. Keep API/database credentials and signing secrets on the server. Client instance selection, credential clearing and packaged desktop routing require their own verification; this backend package does not change an existing desktop binary.

The 1.3.1 desktop client starts OAuth with the exact `tokentracker://auth/callback` redirect. Allow that URI on your own InsForge instance when enabling its OAuth provider. Web sign-in also needs your own dashboard origin and its `/dashboard` callback in the redirect list. The desktop flow keeps PKCE in its original WebView and no longer depends on an arbitrary loopback port or an official hosted relay. Verify the actual provider return and code exchange on the selected instance before marking native sign-in supported.

## Optional trusted-LAN HTTP without a domain

For an isolated home/lab LAN, the application also supports an explicit private-IP HTTP mode. This avoids a domain and certificate, but traffic is not encrypted; use it only on a trusted network. The default remains HTTPS (with loopback HTTP for local development), and public HTTP URLs are still rejected even when the mode is enabled.

Use three separate settings for the three different processes:

```dotenv
# NAS: runtime environment of the deployed device-authorize function
TOKENTRACKER_ALLOW_PRIVATE_HTTP=1
TOKENTRACKER_DASHBOARD_URL=http://192.168.1.20:8080

# Dashboard build machine: baked into the static bundle at build time
VITE_INSFORGE_BASE_URL=http://192.168.1.20:7130
VITE_INSFORGE_ANON_KEY=your-instance-public-anon-key
VITE_TOKENTRACKER_ALLOW_PRIVATE_HTTP=1
```

The Dashboard must be rebuilt after changing its `VITE_` setting. The function setting belongs to the NAS function worker, not the shell that runs `build-functions.cjs`. The generated `functions.json` lists both settings separately.

On each client, make the same explicit choice once:

```sh
tokentracker init \
  --base-url http://192.168.1.20:7130 \
  --dashboard-url http://192.168.1.20:8080 \
  --anon-key-file /private/path/anon-key \
  --allow-private-http
```

For a headless client, use `tokentracker device-login` with the same URL arguments and `--allow-private-http`. The CLI saves `allowPrivateHttp: true` in its local `config.json`, so subsequent `serve`, hook and background-sync processes retain the choice. Do not copy this setting or a device token between accounts or instances.

Only literal private addresses are accepted: RFC1918 IPv4, loopback, link-local and IPv6 ULA/link-local addresses. Hostnames such as `nas.local`, public IPs and CGNAT addresses are not accepted. This switch does not bypass browser mixed-content/CORS rules or the local dashboard's loopback Origin checks; serve the NAS Dashboard and API over the same HTTP LAN scheme, and keep the CLI's own port bound to loopback.

## Back up and restore an instance

Check the running PostgreSQL version and both client-tool versions before choosing `pg_dump` and `pg_restore`. The verified image runs PostgreSQL 15.18 but its default tools are 18.4; restoring that default dump into PostgreSQL 15 fails on `transaction_timeout`. The image also supplies matching 15.18 tools under `/usr/lib/postgresql/15/bin/`, which completed the local restore drill.

Keep the database dump, server configuration and storage files together in a private backup. Restore into an isolated instance first, retaining its PostgreSQL connection credentials and restoring the backed-up application signing/encryption keys. Verify actual sign-in, owner-scoped usage and file bytes before replacing an instance. The local drill restored all recorded device/usage fields and verified two users' private totals and a stored file; it did not restore or modify the hosted project.

## Verification completed locally

`node --test test/self-host-backend.test.js` executes the actual bundled handlers and InsForge SDK over loopback HTTP into independent PGlite PostgreSQL databases. It installs a fresh baseline twice, then repeats installation after real test usage exists. It checks two devices, seven free device enrollments, duplicate uploads, whole-row corrections, private summaries, timezone/pricing tiers, JWT expiry/signatures, token revocation, denied client-role reads, self-owned device-code URLs and the grant/poll flow. The test platform supplies isolated generated identities and credentials; no production users or keys are copied.

The current delivery also boots the official pinned v2.3.3 stack in an isolated local Linux ARM64 VM. Backend and Deno health endpoints return 200; the actual PostgreSQL version is 15.18 and Deno is 2.0.6. Real SDK signup/signin, anonymous-key rejection, `auth.uid()`, ownership RLS and `auth.users` foreign keys pass. The CLI migration installs all 13 application steps and validates the token environment constraint. A second unchanged migration preserves every step checksum and installation timestamp. All 14 deployed handlers return 200 in their actual flows, including billing account/catalog with no prices or enabled payment providers. Two signed-in users each enroll multiple free devices; upload and private readers run through the actual SDK. Deployment source hashes match the generated files after a second deployment. A real browser also verifies both users after sign-in, a fresh SDK client and page reload: all six checks preserve the expected identity and private total through HTTP-only cookie refresh and actual account queries. This controlled local stack does not prove a public VPS or Windows device deployment.

Before calling a VPS installation ready, test the real platform's sign-in/refresh/sign-out, HTTPS, own dashboard callbacks, native clients, storage if enabled, database backup/restore and a reviewed upgrade. Reinstalling unchanged SQL is not a restore drill. [Remaining end-to-end gates](self-hosting-status.md)
