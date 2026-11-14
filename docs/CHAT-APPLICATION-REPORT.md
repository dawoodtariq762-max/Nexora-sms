# NEXORA — Test Panel and dedicated Chat application

## Delivery status

Implemented in the existing project, preserving the preceding targeted fixes. Local API and Chromium regression suites pass. **Not pushed to GitHub, deployed to the VPS, or certified on physical phones.** This report supersedes the earlier report where the requirements have changed, particularly Chat authentication and Agent-only registration.

Entry points:

- Dedicated Chat login: `/chat-app/login`
- Dedicated Chat application: `/chat-app/`
- Existing main panels and `/chat` remain; Manager/Agent Chat access now requires the separate Chat login. A main-panel token cannot bypass the Chat Security Code.
- Admin: **Security Code Management** and **WhatsApp Management** sidebar sections.

The Supervisor and Support credential capitalization follows your clarification, not the contradictory original attachment. Configure the agreed values privately using the provided terminal utility; they are not embedded in frontend code. The short, shared passwords you requested are weak: use strong unique replacements before public exposure. Passwords/codes are bcrypt-hashed in the database.

## Confirmed causes and corrections

### Test Panel

1. **Agent navigation and page were incomplete.** Agent contained Test Panel loading/rendering functions, but no usable Test Panel sidebar entry or complete page section. The existing Client/Agent-compatible Test Panel markup and Agent functions are now connected; there is no second Test Panel backend.
2. **Page sizes were hard-coded.** Agent/Client/standalone Test tables initialized to 25, without the required selector. Manager loaded only the first 100 records, then filtered that subset in the browser. Admin exposed an incomplete selector.
3. **Range filtering used inconsistent sources.** Manager's dropdown could be populated from role-scoped live-number ranges rather than the active Test Number pool. Filtering a previously truncated subset could miss valid matches. Filters now query `/api/test-numbers` server-side, and the range options come from that same pool.
4. **Pagination lacked complete first/last navigation.** Shared Test Panel controls now provide first, previous, numbered, next and last buttons, current-page highlighting and disabled boundary controls. Changing a page size or range resets the number page appropriately.
5. **A global page-size initializer could overwrite Test Panel options later.** `api.js` now leaves the dedicated Admin Test Number selector to its own exact options.

Options are **25, 50, 100, 500, All**, default 25. All returns the full matching pool using the existing cursor-streamed JSON infrastructure, rather than a hidden 10,000-row cap or an extra cached materialized dataset. Very large All views still require browser rendering resources; choose a bounded page size for huge pools.

Existing statistics meanings are preserved: main dashboard summaries stay global; Agent/Client/standalone selected-range SMS views stay filtered as before; Admin's recent-SMS table deliberately remains independent of its Test Number range filter. Admin Test Number selection/delete/move controls are retained. No SMS allocation, provider, rate or finance logic was changed.

### Reply delivery and group structure

The existing message route constructed `mine: true` for the sender and forwarded that same payload to recipients. Recipients could therefore render replies as their own outgoing messages. This was reproduced and corrected: recipient events carry `mine: false`, and the client derives ownership from the authenticated sender ID as an additional safeguard.

The existing system also assumed every conversation had exactly two members (`a_id` / `b_id`). That cannot deliver the required four-party support groups. The extension adds explicit group membership and fanout to all eligible recipients, while retaining existing conversation IDs and message/attachment tables.

- Each Manager/Agent receives one stable, private **NEXORA SMS Support Chat** group with that user, their relevant Admin, Supervisor and Support.
- Agents also receive the existing direct conversation with their actual active assigned Manager. No Manager is fabricated when one is missing.
- Unique owner/conversation mappings prevent duplicate groups on repeated logins.
- Existing one-to-one histories are retained, including legacy threads. They are not merged into another user's support group or deleted.
- Admin/Supervisor/Support are distinct sender identities. System-side actors use separate, stable Chat identity IDs, not newly created main-panel users or elevated panel roles.
- Sender labels use current database roles: `M Name`, `A Name`, Admin, Supervisor, Support.
- Per-recipient read cursors prevent one group reader from clearing everybody else's unread count.
- Existing SSE reconnect/history synchronization is reused. Streams revalidate credentials before events and on heartbeat. Text, emoji, images, TXT sharing and existing message history remain on the same backend.

These are verified local causes. Production-only faults in Nginx, actual upload volumes, deployment revisions or network behavior still need VPS inspection.

## Authentication and code management

- Admin: existing username and panel password.
- Manager/Agent: existing username and **exactly six numeric digits** in their separate Chat Security Code. Their panel password is not accepted for this login.
- Supervisor/Support: select the system identity on Chat login, use the existing Admin username and the privately configured identity password.
- Clients: rejected from Chat.
- Main-panel and Chat tokens have separate scopes/storage keys. Chat-only tokens cannot call main-panel APIs, including legacy account-PIN management endpoints. Manager/Agent panel tokens cannot substitute for a Chat session.
- Account activity, identity activity, code configuration/activity and credential revision are checked on requests. Deactivate, remove, change, or reactivate a code revokes old Chat tokens. Push subscriptions are removed when credentials change.
- Login has IP limits plus persistent per-username attempt limits. Codes and password material are not included in normal listings or audit logs.
- Admin can assign/change, securely generate, activate/deactivate and remove codes. Generated codes are disclosed once in the authorized generation response, so they can be handed to the account holder; subsequent listings show configuration/status only.
- Existing accounts receive **no automatic Chat code**. The new code table is deliberately separate from payment/account security PIN tables.
- Existing main-panel authentication, password hashes and roles remain intact. The new Chat scope is an intentional access change required by this specification.

Chat uses the existing JWT infrastructure and 12-hour expiration. A dedicated Chat token can survive app relaunch in its own storage namespace; signing out clears it without clearing main-panel sessions. Credential revocation is checked server-side, rather than relying on clearing a browser key alone.

## Registration

Public registration now accepts Agents only, requires the specified Chat Security Code helper text and six-digit code, and stores a separate bcrypt hash on the request. Pending requests have no account/session access. Approval atomically creates the existing Agent account, activates its registered Chat code and marks the request approved.

Older pending requests are preserved. If an older approved Agent request has no registered code, Admin must configure one. Previously submitted Manager requests are not silently rewritten or deleted; new public Manager/Client requests are rejected.

## Attachments and interface

Existing real file uploads, bearer-authenticated retrieval, inline image bubbles, aspect ratio handling, selection previews/removal, clipboard handling and history are reused. The larger image viewer now includes a Download control. TXT files use persistent filename/info/download attachments.

The preceding MIME/storage/privacy corrections remain included. Group attachment access now checks actual group membership; unrelated Managers/Agents cannot retrieve these private files. Backend storage is not published through the project-root static handler.

The dedicated app uses the existing Chat UI with a separate responsive login and NEXORA icons. A compact More menu holds new installation, notification and sign-out controls without overflowing the mobile toolbar. Existing emoji picker, message layout, panel themes and main-panel components are retained.

## Notifications, PWA and updates

- Existing SSE supports open-app message delivery, sound, conversation unread badges and counts.
- Notification permission is requested only after a user action.
- Web Push subscription management and server dispatch are implemented using `web-push`. Background delivery requires valid VAPID keys, HTTPS, platform support and permission.
- Defaults favor privacy: notification text says a new message is available, rather than placing private conversation content on a lock screen.
- The Chat service worker handles push, uses a bounded IndexedDB **message-ID-only** deduplication ledger and message tags, and directs notification clicks to the relevant conversation. It does not store private message bodies or API responses in Cache Storage.
- A visible Chat window relies on its in-app indicators instead of duplicate background popups. If Web Push is subscribed, it owns background notifications rather than also generating a page notification for the same message.
- Manifest ID `/chat-app/`, start URL `/chat-app/`, scope `/chat-app/`, name **NEXORA Chat**, short name **Chat**, standalone mode, existing NEXORA regular/maskable icons.
- The main panel's installer/worker registration is skipped on Chat app pages, allowing a distinct scoped Chat installation where the browser supports it.
- Native installation is triggered only after an eligible browser supplies its prompt. iOS gets Add to Home Screen instructions instead.
- Version identifiers and Admin-configured newer-version notices are implemented. Update calls `registration.update()` and activates a waiting worker after user action. If no newer worker is ready, it says so; changing a notice alone does not falsely claim an update was installed.
- No worker update deletes the database, attachment storage, tokens, or message history.

## Database changes

Additive/idempotent initialization in `backend/chatApplication.js`:

| Structure | Purpose |
|---|---|
| `chat_app_codes` | Separate hashed codes, active state and credential revision |
| `chat_system_identities` | Hashed Supervisor/Support credentials associated with an Admin |
| `chat_members` | Explicit group membership |
| `chat_support_groups` | One stable support group per owner |
| `chat_read_cursors` | Independent per-recipient unread position |
| `chat_push_subscriptions` | Private device push subscriptions |
| `chat_login_attempts` | Persistent failed-login limits |
| `creator_requests.chat_code_hash` | Pending registration's separate code hash |

WhatsApp/update settings use the existing `app_settings` table with `chat_app_` keys. Messages, conversations and attachments remain in the existing tables. No existing message/user/financial record is intentionally discarded or reassigned. Startup stops on a failed new migration rather than silently serving a partially migrated feature set.

## APIs added or modified

New:

- `POST /api/chat-app/login`
- `GET /api/chat-app/me`
- `GET /api/chat-app/codes` — panel Admin only
- `POST /api/chat-app/codes/:id` — set/generate/activate/deactivate/delete; panel Admin only
- `GET /api/chat-app/config` — only public channel/update metadata and public VAPID key
- `POST /api/chat-app/config` — panel Admin only
- `POST /api/chat-app/push/subscribe`
- `POST /api/chat-app/push/unsubscribe`

Modified existing routes:

- `/api/chatapp/conversations`, participants, open, messages, read, stream, attachment retrieval and export: scoped identity/membership, sender identity and group support. Existing message/attachment IDs remain valid.
- `/api/creator/register`, approval: Agent-only new registration, code validation/hash and atomic activation.
- `/api/test-numbers`: complete filtered All responses via cursor streaming; existing bounded pagination retained.

## Local verification

Both suites pass with Chromium enabled:

```bash
BROWSER_TESTS=1 npm run test:all
```

Machine-readable records:

- `docs/targeted-test-results.json` — preceding screenshot/image/theme/PWA regression checks, adapted to the new Chat authentication requirement.
- `docs/chat-app-test-results.json` — new scope, identity, group, revocation, registration, Test Panel, settings, interface and worker checks.

Coverage includes real SSE message events and replies, correct `mine` flags, conversation isolation, five identities, active/removed codes, no panel-token bypass, pending approval, PNG/TXT group privacy, prior PNG/JPG/WEBP and image-history checks, Agent/Manager/Admin/Client Test Panel controls, and the standalone Test Panel's actual range/reset controls.

The worker test injects a push via Chrome DevTools and spies notification display. It exercises the real worker push handler, deduplication ledger and target conversation URL. **It is not proof that an external push provider delivered a phone notification.**

Screenshots in `docs/chat-app-desktop.png` and `docs/chat-app-mobile.png` show synthetic test conversations only. Syntax checks include changed HTML inline scripts. `git diff --check` passes.

## Remaining limitations / acceptance checks

1. No production VPS/database/proxy/assets were supplied. Existing production image files and production-only reply failures still require a live check.
2. No physical Android or iPhone installation, launcher icon, real mobile gallery, OS clipboard, OS background-delivery or notification-click test was performed. Clipboard/mobile selection checks use browser emulation/synthetic events.
3. VAPID provider delivery requires deployment configuration and a subscribed permitted device. Browser-denied or unsupported notifications cannot be guaranteed.
4. The update control and worker handlers are implemented, but a real upgrade between two deployed releases has not been certified. Bump both client/worker version constants and deploy the new assets before announcing a matching newer version.
5. The requested shared system-side passwords are weak and known from the specification. Hashing and rate limits do not make weak passwords strong. Configure strong replacements before exposing the app publicly.
6. Very large All views can still be costly to render on mobile, despite streamed server responses.
7. Pre-existing dependency advisories remain (including Multer 1.x). Only `web-push` was added; unrelated dependency upgrades were not mixed into this work.

## VPS deployment

### Before applying

Back up the SQLite database **consistently with its WAL**, both private upload directories, `.env`, and current source. Use your existing backup/snapshot mechanism; do not copy only the live `.sqlite` file while writes continue. Preserve actual `DATA_DIR`, `DB_FILE`, `CREATOR_UPLOAD_DIR`, `CHAT_UPLOAD_DIR`, service user, PM2 process name and JWT secret.

Two patches are supplied:

- `NEXORA-chat-update.patch`: apply **only if the previous delivered fixes are already present unchanged**.
- `NEXORA-complete-update.patch`: cumulative patch against public baseline `cff328f0f5d88fecd4d6c1a768a9243b2d047b53`.

Choose one, not both. The source ZIP includes both updates. Check for later unrelated VPS/Git changes before applying.

### Commands

Run from the existing project directory as its normal service user:

```bash
# Replace this path with the correct one of the two supplied patches.
git apply --check /path/to/NEXORA-chat-update.patch
git apply /path/to/NEXORA-chat-update.patch
npm ci
npm run test:all
pm2 restart ams-sms --update-env
pm2 logs ams-sms --lines 100
```

`ams-sms` is the repository's PM2 process name; substitute the actual deployed name if it differs. On the first startup, the additive schema initializes. Do not overwrite `.env`, uploads or the production database with ZIP/test files.

Configure the two system-side identities without putting passwords in shell history or arguments:

```bash
node scripts/configure-chat-identities.cjs YOUR_EXISTING_ADMIN_USERNAME
```

The terminal prompts for Supervisor and Support passwords and confirmation without echo. Enter the exact agreed capitalization from this conversation. The utility hashes the inputs, leaves the real Admin password untouched and revokes old identity sessions on rotation. Run it against the same environment/database as the service. It refuses noninteractive password input.

Alternatively, one-time bootstrap environment keys are documented in `.env.example`; they are blank by default. The interactive utility is preferred because it avoids persisting raw passwords in an environment file. Remove any plaintext bootstrap values after their hashes have been initialized.

For background Web Push:

```bash
npx web-push generate-vapid-keys
```

Save the generated **public/private** keys privately in the existing service environment as `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, and set a real contact `VAPID_SUBJECT`. Never commit the private key or paste it into frontend code. Keep the keys stable across restarts. Then:

```bash
pm2 restart ams-sms --update-env
```

Ensure the existing HTTPS proxy forwards `/chat-app/`, `/api/chat-app/` and `/api/chatapp/` to Node, serves the worker/manifest without an obsolete static fallback, permits upload bodies of at least the configured limit, and does not expose private backend/data directories. The SSE route needs buffering disabled and long-lived connections. Preserve existing TLS/security controls; do not replace the whole Nginx server block blindly.

Relevant existing HTTPS server-block guidance:

```nginx
client_max_body_size 30m;
location /api/chatapp/stream {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
# Existing general proxy must also forward /chat-app/ and its new APIs.
```

After editing an existing proxy configuration:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Optional full browser tests on staging (not a production runtime dependency):

```bash
npm install --no-save --package-lock=false playwright
npx playwright install --with-deps chromium
BROWSER_TESTS=1 npm run test:all
```

Finally, assign existing Manager/Agent codes through Admin, configure the WhatsApp Channel and update notice, verify old conversation histories and images on the real database, and complete physical-device install/push/update acceptance tests. **No remote deployment commands have been executed in this session.**

## Modified-file inventory for this update

Existing files modified:

```
.env.example
admin.html
agent.html
api.js
assets/pwa-install.js
backend/auth.js
backend/chatapp.js
backend/creatorRequests.js
backend/server.js
chat.html
client.html
creator-register.html
docs/targeted-test-results.json
docs/TARGETED-FIX-REPORT.md
login.html
manager.html
package-lock.json
package.json
scripts/test-targeted-fixes.cjs
test.html
```

New files:

```
assets/chat-admin.js
assets/chat-app-ui.js
assets/chat-login.js
assets/test-panel-controls.js
backend/chatApplication.js
chat-login.html
chat-manifest.webmanifest
chat-sw.js
docs/CHAT-APPLICATION-REPORT.md
docs/chat-app-desktop.png
docs/chat-app-mobile.png
docs/chat-app-test-results.json
scripts/configure-chat-identities.cjs
scripts/test-chat-application.cjs
```

The cumulative source/patch also contains the previous turn's fixes; its historical inventory is in `docs/TARGETED-FIX-REPORT.md`.
