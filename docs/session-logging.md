# Session-Based Press Logging

Captures NXT touch-sensor presses into a per-session log file on disk. Designed so that the same JSONL files can later be uploaded to a remote IoT server (see [remote-iot-shipping.md](remote-iot-shipping.md)) without any reshaping.

## Session model

A **session** is a user-bounded window of logging:

- The web UI has one button: **"Begin Session"** ↔ **"End Session"** (toggle).
- Pressing "Begin" creates a new file `logs/session-<YYYYMMDD-HHMMSS>.jsonl`.
- All `robot/touch` events received while the session is open are appended to that file.
- Pressing "End" closes the file. A subsequent "Begin" creates a *new* file (never appends to an old one).
- Only **one session at a time**. If the user clicks Begin while one is already running, ignore (or treat as restart — pick one consistently).

## MQTT control topics

| Topic              | Payload                                | Direction       | Purpose                          |
|--------------------|----------------------------------------|-----------------|----------------------------------|
| `session/begin`    | `{ "session_id": "20260605-141233" }`  | UI → logger     | Open a new log file.             |
| `session/end`      | `{ "session_id": "20260605-141233" }`  | UI → logger     | Close the active log file.       |
| `session/status`   | `{ "active": true, "session_id": ... }`| logger → UI     | Broadcast on change; UI sets button label + indicator. |

The logger is the single source of truth for "is a session active." The UI never assumes — it reads `session/status`. That way a refreshed browser tab still shows the correct state.

## File format — JSON Lines

One JSON object per line, appended with `fs.appendFile`. No commas, no array wrapper — each line stands alone, so partial files are still parseable and `tail -f` works:

```jsonl
{"ts":1716537812345,"session_id":"20260605-141233","source":"nxt_touch","note":"DO","nxt":0,"port":1}
{"ts":1716537813001,"session_id":"20260605-141233","source":"nxt_touch","note":"RE","nxt":0,"port":2}
{"ts":1716537813500,"session_id":"20260605-141233","source":"nxt_touch","note":"DO","nxt":0,"port":1}
```

Required fields: `ts` (ms since epoch), `session_id`, `source`, `note`. The `source` field exists so future inputs (UI clicks, MIDI, etc.) can share the same log.

## Where the logger lives

Two viable homes — pick one when implementing:

- **In `src/server.js`** — the HTTP server process already runs and has filesystem access. Adds a small `mqtt.connect('mqtt://localhost:1883')` block that subscribes to `robot/touch`, `session/begin`, `session/end`. Simplest.
- **New `src/session_logger.js`** — separate process, started via `npm run logger`. Cleaner separation; survives if the HTTP server is restarted.

Recommend the first option until logging volume justifies a dedicated process.

## Directory layout

```
iiot-capstone-01/
├── logs/                                # gitignored
│   ├── session-20260605-141233.jsonl
│   ├── session-20260605-153010.jsonl
│   └── ...
```

Add `logs/` to `.gitignore` before the first session ever runs.

## UI changes

In [public/index.html](../public/index.html), next to the existing settings button:

```html
<button id="session-toggle" data-state="idle">Begin Session</button>
<span id="session-indicator"></span>
```

In [public/script.js](../public/script.js):

- Subscribe to `session/status`. On state change, update the button label (`"Begin Session"` vs `"End Session"`) and the indicator (e.g. a red dot when recording).
- Click handler publishes `session/begin` or `session/end` with a fresh `session_id` (current ISO timestamp, compacted).
- Do **not** track session state purely in client memory — always reflect what the logger broadcasts on `session/status`.

## Failure modes

- **Broker down when "Begin" is clicked** — UI shows error, no file created. Acceptable; the broker is local.
- **Touch event arrives with no active session** — logger drops it silently. The wire event still reaches the UI (highlight still works), only the disk write is skipped.
- **Logger crash mid-session** — the JSONL file is still valid up to the last complete line. On restart, the next "Begin" opens a new file.
- **Two browser tabs open** — both publish `session/begin`. Logger ignores the second if a session is already active and re-broadcasts `session/status` so both tabs converge.
