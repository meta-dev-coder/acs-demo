# Autodesk Platform Services sign-in (`/api/aps/*`)

Three-legged OAuth (Authorization Code + PKCE S256) and a read-only lookup of the Forma (ACC)
project **Seagirt Electrical Digital Twin POC** and its two IFC files. Mounted in the Vite dev server
(`vite.config.js`), so `http://localhost:5188/api/aps/*` is served by the same Node process as the
map, with no proxy. `npm run api` (`server/index.mjs`) mounts the same handler. It is not on the
EC2 live-dc host.

| File | Role |
|---|---|
| `api.mjs` | Routes, sessions, token refresh, error responses |
| `oauth.mjs` | Config, PKCE, authorize URL, token exchange/refresh, credential check, error codes |
| `dataManagement.mjs` | Hubs, projects, top folders, recursive file search, versions, derivative manifest |
| `sessions.mjs` | Memory store (default) and AES-256-GCM encrypted file store, cookie helpers |

## Configure

In `cesium-poc/.env.local` (git-ignored), then **fully restart** `npm run dev`. A running server
keeps the values it started with, even after Vite reloads itself on an `.env.local` save.

```
APS_CLIENT_ID=...
APS_CLIENT_SECRET=...
APS_CALLBACK_URL=http://localhost:5188/api/aps/callback
```

Optional: `APS_SCOPE` (default `data:read viewables:read`), `APS_TARGET_PROJECT_NAME`, `APS_TARGET_FILES` (comma
list), `APS_SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`) and `APS_SESSION_STORE_PATH`
(default `cesium-poc/.aps/sessions.enc`, git-ignored).

`npm run aps:check` tests the id and secret without a browser. `/api/aps/status?test=1` does the
same from the running server and shows `clientIdSuffix`, so a stale server is easy to spot.

## Viewer token (`GET /api/aps/viewer-token`)

The IFC Model Explorer (`src/ifcExplorer/`) shows models with the Autodesk Viewer, which needs a
token in the browser. It gets one from this route: the session's refresh token is refreshed down to
`viewables:read` (Autodesk's documented pattern), so the page can display derivatives but cannot
list or read project data. Answer: `{access_token, expires_in, scope: "viewables:read"}`; cached in
the session until a minute before it expires. A sign-in made before `viewables:read` was requested
answers `MISSING_SCOPE` with a hint to sign in again. `/api/aps/files` is cached per session for
5 minutes (`?refresh=1` re-reads) and searches the "Project Files" folder first.

## Token storage

The browser gets only an opaque `aps_sid` cookie (HttpOnly, SameSite=Lax, `Path=/api/aps`, `Secure`
when the callback is https). Tokens and PKCE verifiers stay server-side.

- **Default (local development): in memory.** A server restart signs everyone out.
- **Production: set `APS_SESSION_ENCRYPTION_KEY`.** Sessions are sealed with AES-256-GCM and written
  atomically with mode 0600. Keep the key in a secret manager, not beside the file. For several
  server instances, replace `sessions.mjs`'s store with a shared one (Redis or a database) that has
  the same `get`/`set`/`delete` interface.

The access token is refreshed 60 s before it expires. Every refresh for a session (data or viewer)
runs one at a time, because Autodesk rotates the refresh token on each one. A 401 from a data call is retried once after a
refresh. A refused refresh clears the session and answers `TOKEN_EXPIRED`.

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `APS_NOT_CONFIGURED` | 503 | An `APS_*` variable is missing, or the callback is not `/api/aps/callback` |
| `NOT_AUTHENTICATED` | 401 | No sign-in in this browser |
| `STATE_INVALID` / `STATE_EXPIRED` | 400 | Forged, reused or >10 min old state, or no session cookie |
| `ACCESS_DENIED` | 403 | Consent declined |
| `INVALID_CREDENTIALS` | 502 | Wrong id or secret |
| `APP_NO_API_ACCESS` | 502 | Client id not enabled for the API product, or a stale id |
| `CALLBACK_MISMATCH` | 400 | Redirect URI differs from the registration |
| `AUTH_CODE_INVALID` | 400 | Code expired or reused |
| `MISSING_SCOPE` | 403 | Token lacks `data:read` |
| `TOKEN_EXPIRED` | 401 | Refresh refused; sign in again |
| `HUB_INACCESSIBLE` | 403 | No hubs, or a hub refused (Custom Integration not added, or not a member) |
| `PROJECT_NOT_FOUND` | 404 | No accessible project with the target name |
| `FILES_MISSING` | 404 | One of the IFC files was not found (body still lists what was found) |
