# Orbit REST API

Base: `https://YOUR_ORBIT_HOST/api` (local development: `http://localhost:3000/api`).

Authenticate every endpoint below with `Authorization: Bearer YOUR_API_KEY`. Create keys in the browser's Developers page. Use `Content-Type: application/json` for JSON bodies. All responses are JSON; errors use `{ "error": "Description" }`. Keys represent their owning account and cannot impersonate another sender. There is no arbitrary public-phone-number support.

## Permissions

- `messages:write`: send messages.
- `messages:read`: read your messages.
- `calls:write`: read your call history, initiate a call, or end/decline your calls.
- Account identity, contact listing, and number lookup are available to any valid key.
- Admin operations, key creation/revocation, profile changes, signup/login, contact edits, and call acceptance require appropriate browser sessions rather than API keys.

## GET /me

Returns `{ "user": { "id", "username", "number", "role", "createdAt", "suspended", "avatar" } }`.

## GET /users/lookup?number=%2B301234567

The `+` must be URL-encoded as `%2B` in query parameters. Returns `{ "user": { ... }, "online": true }` or 404. Numbers may be entered with spaces, dashes, or parentheses in this lookup. Other endpoints expect the exact number, e.g. `+301234567`.

## GET /contacts

Returns `{ "contacts": [{ "id", "owner", "userId", "name", "user": { ... } }] }` for the key owner.

## POST /messages

Permission: `messages:write`.

```json
{ "to": "+301234567", "text": "Hello from my code!" }
```

- `to`: another registered Orbit number, including the + prefix, no spaces.
- `text`: 1–4,000 characters, trimmed. Plain text only; no attachments or HTML rendering.

201 response:

```json
{
  "message": {
    "id": "a-server-generated-uuid",
    "from": "sender-user-id",
    "to": "recipient-user-id",
    "text": "Hello from my code!",
    "createdAt": 1780000000000
  }
}
```

The message is saved even if the recipient is offline. Online sessions receive it immediately. A successful response means **stored by the server**, not proof of delivery/read status. There is no idempotency-key support; retrying a POST can create duplicates.

## GET /messages

Permission: `messages:read`.

Optional query parameters:

| Parameter | Meaning |
|---|---|
| `number` | Filter to one peer's current exact number (URL-encode +) |
| `limit` | 1–500, default 100 |
| `before` | Only messages with `createdAt` strictly less than this Unix-millisecond timestamp |

Returns `{ "messages": [...] }`, oldest to newest within the returned page. Objects also include `fromNumber` and `toNumber`. Messages belong to account IDs, so current numbers reflect any reassignment. To retrieve older messages, use the oldest returned timestamp as `before`. Messages sharing an exact boundary millisecond can require additional care; this lightweight version does not offer a composite cursor.

## GET /calls

Permission: `calls:write`. Returns `{ "calls": [...] }`, newest first, up to 100.

Call objects:

```json
{
  "id": "call-uuid",
  "from": "sender-user-id",
  "to": "recipient-user-id",
  "kind": "voice",
  "status": "ringing",
  "createdAt": 1780000000000,
  "source": "api"
}
```

Statuses: `ringing`, `connected`, `ended`, `missed`, `declined`, `cancelled`. `answeredAt` and `endedAt` are added when applicable. A `connected` server status means the invitation was accepted; the actual WebRTC media connection can still be negotiating or fail. Call duration in the history uses the acceptance/end timestamps, not measured media duration.

## POST /calls

Permission: `calls:write`.

```json
{ "to": "+301234567", "kind": "video" }
```

`kind` is `video` or `voice` (default). Returns 201 with `{ "call": { ... }, "note": "..." }`.

**Both accounts must have Orbit open and connected.** An API-triggered call rings the peer and shows a microphone activation prompt to the caller's connected browser if needed. The callee accepts from a browser. Audio/video uses browser WebRTC; this endpoint does not return media, dial a real phone number, or offer a headless Python audio channel.

- Only one active call per account.
- A ringing call times out after 45 seconds.
- Offline/busy participants produce a 409.
- Accepted calls require microphone/camera permissions and may need a TURN server across restrictive networks.

## POST /calls/:id/end

Permission: `calls:write`. Body: `{}`. Either participant may end a call. Returns `{ "call": { ... } }`. Ending a ringing call marks it `cancelled`.

## POST /calls/:id/decline

Permission: `calls:write`. Body: `{}`. Marks an active call `declined`. API keys cannot accept calls; acceptance requires the browser flow.

## Status codes and limits

| Code | Meaning |
|---|---|
| 200 | Successful read/update/action |
| 201 | Message/call/key created |
| 400 | Invalid fields, message too long, or self-message/call |
| 401 | Missing, revoked, expired, suspended, or invalid credentials |
| 403 | Missing key scope or browser/admin-only action |
| 404 | Unknown endpoint, number, call, or resource |
| 409 | Number claimed, recipient offline, participant busy, or stale call |
| 429 | Rate limited |
| 500 | Unexpected server error |

240 API requests per minute per IP; 10 active keys per account; up to 4,000 characters per message. Rate-limit headers are included. Login/registration additionally have a 60-attempt/15-minute IP limit. Cross-origin Bearer API requests are permitted, but **never expose secret keys in public frontend code**. Session-cookie requests are same-origin and use browser-specific protections.

There are no delivery webhooks, carrier calls, external SMS, group messages, or headless media-stream endpoints in this release. Live browser events use an authenticated same-origin WebSocket; that is an internal browser protocol, not a versioned public SDK contract.
