# MQTT Topic Map

Single source of truth for topic names, payloads, and direction. Update this file whenever a topic is added or renamed.

## Existing topics

| Topic           | Direction              | QoS | Payload                                 | Purpose                                                                 |
|-----------------|------------------------|-----|-----------------------------------------|-------------------------------------------------------------------------|
| `robot/nada`    | UI / Python → bridge   | 0   | plain string e.g. `"DO"`                | One discrete strike. Manual key tap from the UI, **and** each note in `main.py`'s `stream` delivery mode. |
| `score/mode`    | UI → Python            | 1 (retained) | plain string `"compiled"` or `"stream"` | Web UI picks how `main.py` delivers a song. Retained so the note-reader reads the current choice at startup. See [score-delivery-modes.md](score-delivery-modes.md). |
| `score/play`    | UI → Python            | 1   | `{}` or `{ "mode": "stream" }`          | Web UI Play button. Tells the note-reader **service** to play the cached score (optionally overriding the mode). |
| `score/convert` | UI → Python            | 1   | empty                                   | Web UI "Re-convert" button. Re-runs Audiveris on the latest PDF and re-caches the compiled score. |
| `score/stop`    | UI → Python            | 1   | empty                                   | Web UI Stop button. Halts the current playback (also makes the service publish `robot/stop`). |
| `score/status`  | Python → UI            | 1 (retained) | `{ "state": "ready", "title": "...", "notes": 42, "mode": "stream", "ts": ... }` | Note-reader service state (`idle`/`converting`/`ready`/`playing`). Retained so a fresh tab sees it. |
| `robot/stop`    | Python → bridge        | 0   | empty                                   | Cancel any scheduled (compiled) song and brake every motor. |
| `robot/hold`    | UI → bridge            | 0   | `{ "note": "DO", "action": "press" }` / `"release"` | Manual press-and-hold. `press` parks the motor at the press position; `release` retracts it. Used by the Piano Tiles keys so a held key stays put. Motor power/timing per [motor-tuning.md](motor-tuning.md). |
| `robot/score`   | Python → bridge, UI    | 1   | JSON `ScorePacket`                      | Compiled full-song push from `note-reader/main.py`. See [compiled-score-single-push.md](compiled-score-single-push.md). |
| `robot/strike`  | bridge → UI            | 0   | plain string e.g. `"DO"`                | **Real** strike confirmation — published when the NXT acknowledges the press command (reply-required Direct Command), not optimistically. Drives key highlight, Now Playing, and the motor heatmap. See [nxt-strike-confirmation.md](nxt-strike-confirmation.md). |
| `robot/latency` | bridge → UI            | 0   | `{ "note": "DO", "nxt": 0, "port": 0, "ms": 87, "confirmed": true }` | Bridge-measured command→ack round-trip for each strike. Feeds the Command→Strike Latency panel; populates in **both** delivery modes. `confirmed:false` means the ack timed out (lost reply / no brick). |

## New topics (touch input + session logging)

| Topic             | Direction       | QoS | Payload                                                                          | Purpose                                                                  |
|-------------------|-----------------|-----|----------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `robot/touch`     | bridge → world  | 0   | `{ "note": "DO", "nxt": 0, "port": 1, "ts": 1716537812345 }`                     | Rising-edge press event from an NXT touch sensor. See [nxt-touch-input.md](nxt-touch-input.md). |
| `session/begin`   | UI → logger     | 1   | `{ "session_id": "20260605-141233" }`                                            | Open a new JSONL log file.                                               |
| `session/end`     | UI → logger     | 1   | `{ "session_id": "20260605-141233" }`                                            | Close the active log file.                                               |
| `session/status`  | logger → UI     | 1 (retained) | `{ "active": true, "session_id": "20260605-141233", "started_ts": 1716...}` | Logger's authoritative state. Retained so a fresh tab sees current state on subscribe. |

## Conversion progress

| Topic            | Direction       | QoS | Payload                                                                 | Purpose                                                                  |
|------------------|-----------------|-----|-------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `convert/status` | Python → UI     | 0   | `{ "stage": "omr", "state": "active", "detail": "ibu-kita-kartini.pdf", "ts": 1716... }` | Live pipeline progress from `note-reader/main.py`. Lights the matching node (`src`/`omr`/`pub`) in the Web UI's data-flow diagram while that step runs; `state: "done"` clears it. Best-effort (QoS 0) — never blocks the conversion. |

## Monitor topics (health dashboard)

| Topic            | Direction       | QoS | Payload                                                                 | Purpose                                                                  |
|------------------|-----------------|-----|-------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `health/bridge`  | bridge → UI     | 0 (retained) | `{ "ts": 1716..., "ports": [{ "name": "NXT-1", "path": "COM4", "open": true }] }` | NXT bridge liveness + per-NXT serial-port state, every 3 s. See [visualizations.md](visualizations.md). |
| `health/server`  | server → UI     | 0 (retained) | `{ "ts": 1716... }`                                                      | Session-logger/HTTP-server liveness, every 3 s.                          |

## Notes

- **QoS choice**: control messages (`robot/score`, `session/*`) use QoS 1 so they survive transient broker hiccups. High-rate event streams (`robot/touch`, `robot/strike`) use QoS 0 — a dropped touch event is acceptable; latency isn't.
- **`session/status` is retained** so the UI's "Begin/End" button always renders the correct label even after a page refresh.
- **Backwards compatibility**: nothing changes in `robot/nada` / `robot/score` / `robot/strike`. The compiled-score pipeline and manual piano work untouched.

## Naming convention

- `robot/*` — anything touching physical hardware (NXT motors or sensors).
- `session/*` — recording lifecycle.
- `health/*` — per-process liveness heartbeats for the monitor dashboard.
- Reserve `cloud/*` for future remote-IoT bridging (see [remote-iot-shipping.md](remote-iot-shipping.md)).
