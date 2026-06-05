# Remote IoT Shipping (Future Work)

Future-facing notes. **Not yet implemented.** The local JSONL files produced by [session-logging.md](session-logging.md) are the on-disk staging format; this doc sketches how to move them off-box.

## Why log first, ship later

Decoupling capture from delivery means:

- The capture path (`robot/touch` → JSONL) never blocks on network errors.
- A session always produces a complete on-disk artifact, even if the upstream server is down.
- Re-shipping is just re-reading the file — the same shape goes out as went in.

## Target server (placeholder)

Likely candidate: the ITB Engineering Physics department server referenced in the README. Final endpoint TBD. Probable shapes, in rough order of preference:

1. **MQTT bridge** — publish each JSONL line to a remote broker on topic `cloud/sessions/<session_id>`. Simplest: re-use the existing wire format. Needs broker URL + credentials.
2. **HTTPS batch POST** — `POST /sessions/<session_id>` with the whole `.jsonl` file as the body. Works through corporate firewalls that block raw MQTT.
3. **WebSocket stream** — open a connection per session, stream lines live. Lowest latency, highest complexity.

Pick one based on what the server actually exposes.

## Sketch: shipping process

A separate `src/uploader.js` (or a `cron`-driven script) that:

1. Lists files under `logs/` matching `session-*.jsonl`.
2. For each file not yet marked uploaded:
   - Stream-read line by line.
   - Publish/POST per the chosen transport.
   - On success, either rename to `*.jsonl.sent` or record the filename in `logs/.uploaded`.
3. Never deletes original files — let the user prune manually.

## What the captured record needs to carry

The on-disk JSONL is already shaped for this — every line is self-contained:

```jsonc
{
  "ts": 1716537812345,
  "session_id": "20260605-141233",
  "source": "nxt_touch",
  "note": "DO",
  "nxt": 0,
  "port": 1
}
```

If the remote schema demands extras (device ID, location, user), add them at **ship time** rather than rewriting the historical files — keep on-disk data immutable.

## Security / privacy

- Touch-press logs are low-sensitivity, but session timing data can fingerprint a user. Treat the destination as you would any IoT telemetry endpoint: TLS, per-device credentials, never commit secrets.
- Use `.env` (gitignored) for the remote broker URL and credentials. Read via `process.env.CLOUD_BROKER`, `CLOUD_USER`, `CLOUD_PASS`.

## Out of scope right now

- Buffering / replay / retry semantics — handle when the real server exists.
- Multi-device aggregation — each bench machine ships its own session files independently.
- Schema migration — JSONL append-only on disk, schema versioning can be added (`"v": 1`) when needed.
