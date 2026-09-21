# approverr

A small poller that watches an Overseerr/Seerr instance for pending requests, moves the ones matching your
rules to a different root folder (optionally pinning a quality profile), and approves them.

## Configuration

Copy `config/config.example.yml` to `config/config.yml` and fill it in. `config/config.yml` is gitignored
because it holds a real API key, so nothing secret can be committed by accident.

Notifications are configured in the **environment**, never in the config file. Copy `.env.example` to
`.env`:

- `NOTIFY_URL` — the notification gateway's base URL.
- `NOTIFY_TOKEN` — this instance's publisher token.
- `NOTIFY_HOST` — optional, the host name shown on a card. Defaults to the container's hostname.

With either of the first two unset, approverr logs one warning at boot and runs without notifications.

## Notifications

`src/notify.js` posts to the gateway's `POST /v1/notify` with a bearer token and an `Idempotency-Key`.

- Each request approved or moved is one `info` card in the `media` area, keyed by request id so a retry
  cannot double-post it.
- A failing poll loop is one `warn` condition on the key `approverr:error`, which the gateway keeps as a
  single card. A successful poll publishes `state: resolved` against the same key.
- Sending is fire-and-forget with a 3 s deadline, so a slow or dead gateway can never delay or fail an
  approval. A failed send goes into a bounded in-memory retry queue (50 messages, exponential backoff,
  oldest dropped first with a log line).
- The error text itself travels in `detail`, which the gateway stores for its history page and never
  forwards to a chat. The token is never logged.

## Running

```sh
npm install
node src/index.js          # expects config/config.yml relative to the working directory
npm test                   # node's built-in test runner
docker compose up -d --build
```
