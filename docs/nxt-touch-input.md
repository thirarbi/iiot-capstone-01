# NXT Touch Input — Reverse Direction

Reading **physical** key-presses from NXT touch sensors and feeding them back into the system. This is the inverse of the existing UI → motor flow already documented in [compiled-score-single-push.md](compiled-score-single-push.md).

## Goal

A LEGO touch sensor mounted next to (or under) each xylophone bar lets a human player tap a bar and:

1. Have the press **logged** locally in this project (see [session-logging.md](session-logging.md)).
2. Have the **web UI** highlight that key in real time (re-uses the existing key-highlight CSS).
3. **Not** fire the motor on that bar — the human is already striking it manually.

## Hardware mapping

Three NXT bricks, each with up to 4 input ports (1–4). Eight notes total:

| Note         | NXT brick (index) | Input port |
|--------------|-------------------|------------|
| `DO`         | NXT-1 (0)         | 1          |
| `RE`         | NXT-1 (0)         | 2          |
| `MI`         | NXT-1 (0)         | 3          |
| `FA`         | NXT-3 (1)         | 1          |
| `SOL`        | NXT-3 (1)         | 2          |
| `LA`         | NXT-3 (1)         | 3          |
| `SI`         | NXT-4 (2)         | 1          |
| `DO_TINGGI`  | NXT-4 (2)         | 2          |

Mirrors the existing motor map in [src/nxt_bridge.js](../src/nxt_bridge.js) — each NXT owns the same set of notes for input *and* output.

## Reading the sensor (Direct Command, no firmware change)

The bridge already holds an open `SerialPort` per NXT. Two Direct Commands are needed per sensor:

- `SetInputMode` (0x05): set port `n` to type=`SWITCH` (0x01), mode=`BOOLEANMODE` (0x20). Sent once at startup.
- `GetInputValues` (0x07): poll. Reply byte 12 is the boolean scaledValue (1 = pressed).

Both use the **reply-required** command type byte (`0x00`, not `0x80`). The bridge must `read` the response from the serial port.

```
TX (GetInputValues, port=1):  [0x03 0x00 0x00 0x07 0x01]
                                          │     │    └ port
                                          │     └ command
                                          └ status (0=reply required)
RX (16-byte status block): ...byte 9 = scaledValue (0 or 1)...
```

## Polling strategy

- Round-robin per brick at **~50 ms** per sensor (3 sensors × 50 ms = 150 ms per port → ~7 Hz polling per sensor, fast enough for a deliberate finger press).
- Bridge keeps `lastState[nxtIdx][port]` and emits an event only on the `false → true` transition (rising edge = press, not hold).
- Optional: emit a separate `release` event on `true → false` if hold-tracking becomes useful later.

## MQTT wire format

New topic: **`robot/touch`** (see [mqtt-topics.md](mqtt-topics.md) for the full topic map).

```jsonc
// Topic: robot/touch  (bridge → world)
{
  "note": "DO",
  "nxt": 0,
  "port": 1,
  "ts": 1716537812345     // ms since epoch, bridge-side
}
```

Two consumers:

- `public/script.js` — adds a `robot/touch` subscription, calls the existing `highlightKey(note)` + `showNowPlaying(note)`.
- The session logger (see [session-logging.md](session-logging.md)) — writes the event to disk when a session is active.

## Files touched

| File | Change |
|---|---|
| [src/nxt_bridge.js](../src/nxt_bridge.js) | Add `SetInputMode` at startup, polling loop, edge detection, publish `robot/touch`. |
| [public/script.js](../public/script.js) | Subscribe to `robot/touch`; reuse `highlightKey()` + `showNowPlaying()`. |
| `src/session_logger.js` *(new)* | Subscribe to `robot/touch` + session topics, write JSONL. |

## Edge cases / future considerations

- **Bluetooth read collisions**: bridge already writes to the serial port; mixing writes (motor strike) with reads (GetInputValues) needs a per-brick queue. A simple `await` chain per `SerialPort` is enough.
- **Sensor disconnects**: `GetInputValues` reply will report `valid=0`. Skip silently — don't spam the UI.
- **Latency budget**: end-to-end (finger → UI highlight) ~150–250 ms. Acceptable for logging; not adequate for tight rhythm feedback.
- **Firmware-push alternative**: if polling proves too slow, replace with custom NXC firmware that pushes mailbox messages on press. Documented but not implemented.
