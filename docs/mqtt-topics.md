# MQTT Topic Map

Single source of truth for topic names, payloads, and direction. Update this file whenever a topic is added or renamed.

## Existing topics

| Topic           | Direction              | QoS | Payload                                 | Purpose                                                                 |
|-----------------|------------------------|-----|-----------------------------------------|-------------------------------------------------------------------------|
| `robot/nada`    | UI → bridge            | 0   | plain string e.g. `"DO"`                | Manual key press from the Piano Tiles UI; bridge fires that motor.      |
| `robot/score`   | Python → bridge, UI    | 1   | JSON `ScorePacket`                      | Compiled full-song push from `note-reader/main.py`. See [compiled-score-single-push.md](compiled-score-single-push.md). |
| `robot/strike`  | bridge → UI            | 0   | plain string e.g. `"DO"`                | Motor-fired confirmation. UI uses this for key highlight + Now Playing. |

## New topics (touch input + session logging)

| Topic             | Direction       | QoS | Payload                                                                          | Purpose                                                                  |
|-------------------|-----------------|-----|----------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `robot/touch`     | bridge → world  | 0   | `{ "note": "DO", "nxt": 0, "port": 1, "ts": 1716537812345 }`                     | Rising-edge press event from an NXT touch sensor. See [nxt-touch-input.md](nxt-touch-input.md). |
| `session/begin`   | UI → logger     | 1   | `{ "session_id": "20260605-141233" }`                                            | Open a new JSONL log file.                                               |
| `session/end`     | UI → logger     | 1   | `{ "session_id": "20260605-141233" }`                                            | Close the active log file.                                               |
| `session/status`  | logger → UI     | 1 (retained) | `{ "active": true, "session_id": "20260605-141233", "started_ts": 1716...}` | Logger's authoritative state. Retained so a fresh tab sees current state on subscribe. |

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
