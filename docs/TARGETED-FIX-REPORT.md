# NEXORA targeted fixes — implementation and verification

> Historical report for the previous update. See `CHAT-APPLICATION-REPORT.md` for the subsequent Chat authentication, registration and Test Panel changes.

Date: 2026-11-12
Repository baseline: `cff328f0f5d88fecd4d6c1a768a9243b2d047b53`
Status: **local fixes and regression tests completed; not deployed or verified on the production VPS.**

## Important scope limitation

The public repository was inspected, including frontend, backend routes, database schema, file storage code, and bundled assets. No production database, uploaded screenshots, chat files, Nginx configuration, VPS credentials, or physical phones were provided. The tests use a disposable SQLite database and real uploaded image files; they never alter production records.

Several requested features were already implemented in this commit: Creator screenshot modal/blob fetching, inline chat images, clipboard paste, previews/removal, CAPTCHA-free login, transparent logo CSS, most CLI card colors, manifest/icons, and the installation banner. These were retained and tested, not rebuilt. The production failure cannot honestly be attributed to one confirmed cause without the live files and configuration.

## 1. Creator screenshot diagnosis and fixes

Confirmed code defects:

- Creator uploads defaulted to `backend/creator-uploads` even when the database used `DATA_DIR` or `DB_FILE`. A deployment preserving only its data volume could lose or omit screenshots independently of the database. This is a verified configuration mismatch, not proof that the production files were lost this way.
- A stored image with missing/incorrect MIME metadata was returned as `application/octet-stream`; the Admin viewer explicitly rejects non-image responses. Reproduced with an existing valid image and blank MIME metadata.
- The root static handler exposed the backend directory, contradicting the intended private-storage design. Authorization on the API alone did not protect files reachable through static paths.

Changes in `backend/creatorRequests.js` and `backend/server.js`:

- Default new uploads alongside the persistent database/data directory; explicit `CREATOR_UPLOAD_DIR` remains supported.
- Keep legacy `backend/creator-uploads` lookup so existing files need not be moved or database rows rewritten.
- Detect the response MIME from actual image bytes, including legacy rows.
- Keep Admin-only bearer authentication and existing request IDs/references.
- Mark private image responses `private, no-store`; sanitize inline filenames and handle read-stream failures.
- Replace project-root static serving with explicit assets, existing payment screenshot serving, and public root file allowlisting. Existing panel routes remain intact.

The existing screenshot icon, in-panel modal, aspect-ratio-preserving image, and larger viewer are retained. Actual missing files cannot be reconstructed from a filename: restore them from a backup or obtain a replacement upload if diagnostics show they are absent.

## 2. Chat image diagnosis and fixes

Fresh image upload/display was already implemented in the baseline. The following defects were confirmed in code:

- Upload responses returned the browser-supplied MIME rather than the server-verified MIME stored in SQLite.
- Legacy image attachments with generic MIME metadata were served with non-image headers/disposition.
- Invalid, already-linked, or foreign attachment IDs were silently skipped after creating a message, potentially producing empty/attachmentless messages.
- Root static serving could bypass private storage protection for backend files.

Changes in `backend/chatapp.js`:

- Return the verified MIME in upload responses.
- Sniff image bytes on retrieval for existing image records; serve inline with correct MIME.
- Validate all attachment IDs and ownership before inserting a message, rather than silently dropping attachments. Use the validated IDs for linking.
- Preserve the existing sender, recipient, hierarchy authorization, conversation IDs, message history, text flow, and approved chat CSS.
- Use private/no-store responses and guarded streams.

Existing selection, preview, remove-and-reselect, clipboard paste, mobile file inputs, bubble images, and larger viewer remain unchanged. Tests exercised them end to end. No evidence supports claiming a single confirmed VPS root cause for all reported chat failures.

## 3. CAPTCHA

CAPTCHA was **already absent** from the supplied main login HTML and `/api/login` validation. No authentication bypass or hashing/session/role changes were made. Tests confirm valid username/password login works without CAPTCHA and an invalid password is rejected. Remaining mentions in branding descriptions/animation comments are not active challenges or login requirements.

## 4. Sidebar and themes

The existing attempted fix set `background-attachment:scroll` on the sidebar while keeping `.sb-nav` as a separate scrolling element. This leaves the artwork stationary behind moving navigation.

`assets/nexora-theme.css` now makes the sidebar the single vertical scroll owner, gives its background layers `background-attachment:local`, prevents child shrinkage, and removes nested navigation overflow. The approved artwork, navigation items, dimensions, and mobile off-canvas logic are retained. Section labels, including Daily Operation where present, use a higher-contrast common color/line-height in both themes.

Chromium checks confirmed identical Admin sidebar geometry and functioning scroll ownership in both themes. Manager, Agent, and Client geometry were also checked in both themes. This is not a claim that every nested menu and every production-data page has been manually exercised.

## 5. Logo

The bundled square logo is already RGBA with transparent pixels. Existing shared CSS already normalizes the sidebar mark to 48 × 48 pixels with transparent containers. These rules were preserved, not replaced; Chromium verified matching dimensions and transparent backgrounds across Admin, Manager, Agent and Client themes. **No logo artwork or supplied image was altered.** Runtime branding overrides on the VPS still require verification.

## 6. CLI Analytics

Most light-card surface/text corrections were already present. A remaining badge issue allowed a generic dark text rule to color letter badges over saturated blue backgrounds. An explicit white badge foreground now wins, matching the existing white SVG badge treatment. Shared stat-card secondary labels also use a darker readable light-theme color.

The supplied Admin CLI Analytics page contains Today, Yesterday, Last 7 Days, and This Month cards—not cards literally named “2-Day OTP” or “Total Accounts”. Tests inspect the cards actually present. No statistics, calculations, data queries, or APIs were changed. Shared existing panel styles and core role panels were inspected; a complete manual contrast/accessibility audit of every populated module is still outstanding.

## 7. PWA

Retained the existing manifest, standalone mode, `SMS` short name, scope, and NEXORA icons. Verified all four manifest icon dimensions: 192/512 regular and 192/512 maskable. Artwork was not regenerated.

Changes:

- Service-worker cache version bumped; caching now uses an explicit public-shell allowlist instead of caching arbitrary same-origin GETs.
- Authorization-bearing requests and responses marked private/no-store are excluded; API/private attachment routes remain network-only.
- Existing service-worker update handling retained; `sw.js` served with `no-cache`.
- Dismissal is remembered until installation is manually reopened, rather than nagging after 14 days.
- Defer banner construction if the install event arrives before the body exists.
- Catch failures from native prompt invocation as well as choice resolution.
- Manual reentry no longer offers a nonfunctional install card when no native prompt is available; iOS reentry shows instructions.
- Removed the banner entrance animation; no new animation was added.
- A PWA launch to `/panel-login?source=pwa` validates an existing token through `/api/me` and resumes that role's panel. Ordinary login visits and existing session storage policy remain unchanged.
- Updated shared stylesheet/install-script cache-busting URLs.

Verified in Chromium: worker registration, no tested private/API cache entries, valid-session launch, simulated accepted/dismissed/appinstalled events, suppression across reload, and iOS instructions via user-agent emulation.

**Not verified:** real Android Chrome install eligibility/native confirmation, launcher icon, address-bar removal on a physical phone, genuine iOS Safari Add to Home Screen, deployed HTTPS/certificate/proxy headers, or a real service-worker upgrade from the VPS's currently installed version. Browser event simulations are not physical installation tests.

## 8. Regression results

Run: `BROWSER_TESTS=1 node scripts/test-targeted-fixes.cjs`

The complete passing check list is in `docs/targeted-test-results.json`. Groups include:

- CAPTCHA-free valid/invalid login.
- Creator upload, persistent file/reference, authorized byte retrieval, non-Admin rejection, missing MIME fallback, modal rendering and refresh.
- Static backend/private-upload path rejection.
- Chat participant history/byte equality, outsider rejection, invalid attachment rejection, fake image rejection, normal text, legacy MIME fallback.
- Images after logout/fresh login and backend restart.
- Real Chromium sender/recipient inline images, PNG/JPG/WEBP sends, selection preview/removal, larger viewer and refresh.
- Synthetic clipboard paste handler and mobile-emulated selection/preview.
- Theme geometry, transparent logo, scrolling and actual CLI card foregrounds.
- PWA checks listed above.

Additional checks: JavaScript syntax checks, `git diff --check`, icon dimensions and alpha-channel inspection. Browser clipboard injection is synthetic, not a real operating-system Ctrl+V test. Mobile selection emulation is not a test of an Android/iOS gallery application. The suite does not test SMS delivery, allocations, rates, finance calculations, or external provider APIs; these paths were not intentionally changed.

Reproduce API tests (isolated temporary database; server starts and stops automatically):

```bash
npm ci
npm test
```

Optional browser tests (Playwright is test tooling, not a production dependency):

```bash
npm install --no-save --package-lock=false playwright
npx playwright install --with-deps chromium
BROWSER_TESTS=1 npm test
```

`npm ci` reported pre-existing dependency security advisories, including Multer 1.x. Dependencies were not upgraded as part of this restricted patch; schedule a separate compatibility-tested dependency/security update.

## 9. Deployment / VPS handoff

No remote commands were executed and nothing was pushed to GitHub. Deliverables include a full source ZIP and an applyable Git patch against the baseline above. Do not replace an existing VPS database or `.env` with test files.

1. Back up the production database **and both upload directories** using your existing consistent backup/snapshot mechanism. Do not copy just the main SQLite file while WAL writes are active.
2. Record the current `DATA_DIR`, `DB_FILE`, `CREATOR_UPLOAD_DIR`, `CHAT_UPLOAD_DIR` and application service user. Confirm actual files exist and are readable/writable by that user. Keep existing upload locations unless intentionally migrating all files.
3. Apply the patch from the project root (adjust the patch path):

```bash
git status --short
git apply --check /path/to/NEXORA-targeted-fixes.patch
git apply /path/to/NEXORA-targeted-fixes.patch
npm ci
npm test
pm2 restart ams-sms --update-env
pm2 logs ams-sms --lines 80
```

The process name comes from the repository's `ecosystem.config.js`; use the actual name if your VPS differs. Do not blindly overwrite the checkout from the ZIP if it contains later unrelated changes.

4. Set explicit durable private upload paths if your deploy replaces checkout directories. Example environment layout (adapt to existing paths; create directories with the existing service user as owner, permissions 750 or stricter):

```dotenv
DATA_DIR=/var/lib/nexora
CREATOR_UPLOAD_DIR=/var/lib/nexora/creator-uploads
CHAT_UPLOAD_DIR=/var/lib/nexora/chat-uploads
```

Changing a path alone does not move files. Copy/restore the corresponding existing files first, preserving names and access permissions. Creator lookup includes the legacy backend folder; chat retrieval still uses the configured chat directory, so do not change that directory without migrating all chat files.

5. Ensure Nginx does **not** serve the repository/backend/data directories directly. Prefer proxying application traffic to Node's restricted public routes. Inside the existing HTTPS server block, the proxy pattern is:

```nginx
client_max_body_size 30m;
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

This is guidance, not a replacement for your current TLS, routing, rate-limiting, or security configuration. Preserve valid existing controls and remove conflicting direct-static aliases only after review. If proxy configuration changes:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

6. Using an Admin bearer token, inspect `GET /api/creator/diagnostics` for real missing files. Keep the token in the Authorization header, not URLs. Do not publish diagnostic paths or screenshots. Verify unauthenticated and non-Admin requests fail, including any direct legacy static URLs.
7. Execute the physical Android/iOS checklist and inspect the production origin's manifest/service worker/cache entries. Confirm old screenshots and old conversations, not only new test uploads. Compare light/dark sidebars at desktop and mobile widths, long menus, and the site's actual runtime branding.

## 10. Remaining acceptance work

The code changes and local passing tests are delivered. Final production acceptance requires the VPS storage/database/proxy inspection, real old-record checks, physical device installation, OS clipboard/gallery checks, and broader populated-page theme audit described above. Missing historical image bytes require restoration rather than a UI workaround. No claim of production repair or universal PWA installability is made.
