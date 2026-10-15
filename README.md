# Orbit — a private virtual phone network

A working, self-hosted web app built with **HTML, CSS, vanilla JavaScript, Node.js, Express, WebSocket, and WebRTC**. No frontend build step or external UI CDN.

## Start

Requires Node.js 20.19+ (Node 22 LTS recommended).

```sh
npm ci
npm start
```

Open **http://localhost:3000**. For another device, deploy this same server behind HTTPS and share its reachable URL. Everyone must connect to the same server; running independent copies creates separate networks.

### Requested administrator

- **Username:** `Angelbrs12`
- **Initial password:** `5121`
- The admin receives a random `+30` number on the first launch.
- Change the weak initial password immediately in **Settings → Password & security**.
- A fresh installation can override the seed password with `ADMIN_INITIAL_PASSWORD`. This does not reset existing accounts.

Your running preview has its own saved database. The downloadable source does **not** include live accounts, messages, API secrets, or session tokens; on first launch it creates a clean network with the requested administrator.

## What works

- Choose a random, unique virtual number from the **+12, +67, and +30** pools.
- Create an account with a username and password; sign in using the username **or number** on other devices.
- Persisted one-to-one text messages with live WebSocket delivery, unread counts, typing indicators, search, and presence.
- Save, rename, and remove contacts.
- Browser-to-browser voice and video calls: incoming-call UI, accept/decline, microphone mute, camera toggle, hangup, missed calls, and call history.
- Admin: member list, generate numbers, remove unassigned numbers, reassign member numbers, suspend and restore accounts. Admin account is protected from suspension/reassignment.
- Scoped, revocable API keys. Raw keys are shown once; only their hashes are stored.
- REST API for number lookup, messaging, contacts, and browser-call control.
- In-app developer documentation with Python, server-side JavaScript, and cURL examples.
- Responsive desktop/mobile UI, profile editing, password changes, and invitations.

**These are app-only identifiers, not real telephone numbers.** The prefixes are arbitrary identifiers within Orbit, not a claim to own telecom country codes. There is no carrier/PSTN/SMS integration, public-phone dialing, emergency calling, or external SMS verification.

## Try it with two people

1. Sign in as the administrator.
2. On another browser profile, incognito window, or device, open the **same URL**, create an account, and choose a number.
3. Copy that new account’s number. On the first account, choose **New message**, look up the number, and start chatting.
4. With both accounts online, use the phone/video buttons in the conversation.
5. Accept browser microphone/camera permissions. If your hosting platform embeds the app and blocks permissions, use the **Open Orbit in a new tab** link on the Calls page.

Different accounts in the same browser cookie profile are not isolated; use separate profiles/incognito for testing. Multiple browser profiles can also sign into the same account and see its saved conversations. A call is intended to use one active media device per account; this version does not support transferring a live call between devices or keeping a call alive through a page reload.

## Voice/video networking

Calls use WebRTC. Media flows between browsers, or through your configured TURN relay; REST and WebSocket carry invitations/control/signaling only. Microphone/camera access requires **HTTPS**, except on localhost. Both users must have Orbit open to receive/place calls. Calls ring for 45 seconds.

A public STUN server is configured by default. STUN alone cannot connect every pair of networks. For reliable internet calling, supply a TURN relay (for example a separately deployed coturn service):

```sh
export TURN_URL='turns:turn.example.com:5349'
export TURN_USERNAME='orbit-user'
export TURN_PASSWORD='replace-with-a-real-relay-secret'
npm start
```

Orbit does not include a TURN server or provision relay credentials. The current simple TURN config is shared with authenticated browser users; use restricted quotas/short-lived credentials and a credential service for a production rollout.

If browser media fails, check permissions, HTTPS, iframe permissions policy, firewalls, and TURN configuration. **Local integration tests are not proof of universal cross-network connectivity.**

## Use the API

1. Sign in and open **Developers → API keys**.
2. Create a named key and select the permissions it needs.
3. Copy the full key once and store it in your server environment.
4. Use the public origin of **your running Orbit server**, with `/api` appended.

```sh
export ORBIT_BASE_URL='http://localhost:3000/api'
export ORBIT_API_KEY='orb_live_your_actual_key'
```

### Python (standard library; no pip dependencies)

```sh
python examples/orbit_client.py message --to '+301234567' --text 'Hello from Python!'
python examples/orbit_client.py messages --limit 100
python examples/orbit_client.py call --to '+301234567' --kind video
python examples/orbit_client.py end --id 'actual-call-id'
```

Replace the example recipient with **another registered number from your network**.

```python
from examples.orbit_client import Orbit
client = Orbit()  # ORBIT_BASE_URL and ORBIT_API_KEY
print(client.send_message('+301234567', 'Hello!'))
```

### JavaScript / a website

```js
const { Orbit } = require('./examples/orbit-client.js');
const orbit = new Orbit(); // reads the environment
const result = await orbit.sendMessage('+301234567', 'Hello from Node!');
console.log(result.message);
```

**Do not embed API keys in public HTML or browser JavaScript.** Browser code should POST to your own authenticated backend. That backend attaches its secret key and calls Orbit. The example `examples/website.js` demonstrates this pattern as a **local-only development demo**:

```sh
# From the Orbit project folder; leave the Orbit server running separately.
ORBIT_BASE_URL='http://localhost:3000/api' \
ORBIT_API_KEY='your_actual_key' \
node examples/website.js
# Open http://localhost:4000
```

The example website binds to localhost, contains no application login, and must not be exposed publicly as-is. Add your own site authentication, authorization, CSRF/rate protection, and abuse controls before deploying a sending proxy. Never allow visitors to use a shared account's key without authorization.

### Call API limitation

`POST /api/calls` triggers a browser call, **not a Python audio stream, SIP call, or carrier call**. Both participating accounts must have a connected Orbit browser. An API-triggered caller may need to press **Activate microphone** in its browser. The recipient accepts in their browser. REST can end a call, but accepting requires a browser session and media permissions.

See [API.md](API.md) and the in-app Developers documentation for endpoints and errors.

## Data, deployment, and security

- Default database: `data/network.json`, created on first launch, with atomic file replacement and owner-only file mode. Back it up privately. It includes messages in plaintext and password/session/key hashes; it is not an encrypted-at-rest database.
- Passwords: salted scrypt. Sessions: random tokens in HttpOnly cookies, hashed server-side, with a 30-day expiry. Password changes revoke other browser sessions. API keys are SHA-256 hashed, scoped, and revocable.
- On HTTPS, cookies use `Secure; SameSite=None; Partitioned` to support embedded previews. A standalone and embedded view may have separate cookie partitions; sign in again if necessary. State-changing session requests and WebSocket upgrades enforce same-origin checks.
- On local HTTP, cookies use `SameSite=Lax`. The server trusts **one** upstream reverse-proxy hop. Use a trusted HTTPS reverse proxy that preserves the original Host and sets `X-Forwarded-Proto` correctly. Do not expose an untrusted proxy path in front of this configuration.
- Proxy both HTTP and the `/ws` WebSocket upgrade to the same Node process. Keep the original host; use same-origin browser URLs.
- Configure a persistent writable volume for the data file; otherwise replacing a container loses your accounts.
- This uses a simple **single-process JSON database**, not a horizontally scalable production datastore. Do not run multiple Node workers against the same file. For a larger rollout, migrate to a transactional database and a shared session/presence/signaling system.
- HTTP API: 240 requests/minute per IP. Login/registration: an additional 60 attempts per 15 minutes per IP. Add production monitoring, abuse prevention, backups, security review, and appropriate deployment-specific rate limits.
- Admin cannot read everyone’s message content through the admin UI/API. Server operators with database access can read stored texts. Text messaging is **not end-to-end encrypted**. WebRTC media uses its browser-native encrypted transport.
- No password recovery, email verification, group chats/calls, media attachments, delivery/read receipts to the sender, webhooks, voicemail, or service-worker/background push. The checkmark on sent messages means **accepted by the server**, not read by the recipient. Calls do not ring when all recipient browsers are closed. Presence is live-connection presence, not a guarantee the person is looking at the app.
- Browser bootstrap loads the most recent 2,000 account messages and 200 calls. The REST messages endpoint can page through older messages; the UI currently has no older-history pagination control.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port; binds to `0.0.0.0` |
| `DATA_FILE` | `data/network.json` | Absolute or working-directory-relative database filename |
| `ADMIN_INITIAL_PASSWORD` | `5121` | Admin password for a fresh database only |
| `TURN_URL` | unset | Optional relay URL |
| `TURN_USERNAME` | empty | Relay username |
| `TURN_PASSWORD` | empty | Relay password |

Optional configuration template: `.env.example`. Node does not load it automatically; export variables or run `node --env-file=.env server.js` with a supported Node version.

### Container

```sh
docker build -t orbit-network .
docker run --rm -p 3000:3000 \
  -v orbit-data:/app/data \
  -e ADMIN_INITIAL_PASSWORD='choose-a-long-unique-password' \
  orbit-network
```

Place a TLS reverse proxy in front for use on other devices.

## Tests

```sh
npm test
# Browser suite (development dependencies required):
npx playwright install --with-deps chromium
npm test -- --browser
```

Tests start their own server and temporary database, then delete that database. They never modify your real network. The full suite passed **22 checks**, including two independent browser contexts exchanging live messages and a WebRTC video/audio connection with simulated media devices. It also covers key scope enforcement/revocation, second-device login, admin protections, number assignment, suspension/restoration, rendering, and a 390px mobile viewport.

Screenshots generated by tests go to `checks/` and are not part of the downloadable release.

## Files

```text
server.js             Authentication, JSON persistence, REST, WebSocket, signaling
public/index.html     Browser entry point
public/style.css      Responsive visual system
public/app.js         Client UI, accounts, messaging, admin, WebRTC, docs
examples/             Python and JavaScript SDKs + local website example
API.md                REST reference
Dockerfile            Simple container build
.env.example          Optional configuration template
package-lock.json     Reproducible dependency versions
test.js               Isolated integration + optional browser tests
```
