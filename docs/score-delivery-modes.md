# Score Delivery Modes

Two ways `note-reader/main.py` can send a song to the NXTs. The mode is chosen
from the **Web UI** (the "Score send mode" toggle under the session controls)
and shared with `main.py` over the retained `score/mode` topic, so you can
switch approaches and compare their response time without editing code.

| Mode        | What main.py does                                                                 | Topic         | Per-note network cost |
|-------------|-----------------------------------------------------------------------------------|---------------|-----------------------|
| `stream`    | Sends **one note at a time, in real time**, sleeping each note's delay first.      | `robot/nada`  | Every note round-trips PC → broker → bridge → motor. |
| `compiled`  | Compiles the whole score and sends it **once**; the bridge schedules locally.      | `robot/score` | One upload, then zero — the bridge plays from its own clock. |

Both modes use the same compiled `{ note, delay_ms }` sequence (and therefore
the same per-motor tuning in [motor-tuning.md](motor-tuning.md)); they differ
only in *when* and *how* the notes cross the network.

## The note-reader service

`note-reader/main.py` runs as a small **service**: start it once
(`npm run note-reader`) and leave it running. On startup it converts the latest
PDF (Audiveris → compile) and caches the result, then waits for commands from
the Web UI. This means you **convert once and replay on demand** — no Audiveris
re-run between plays, so back-to-back A/B comparisons are fast.

The Web UI's playback controls map to MQTT commands the service listens for:

| Button          | Topic           | Effect                                                        |
|-----------------|-----------------|--------------------------------------------------------------|
| **▶ Play**      | `score/play`    | Play the cached score in the currently selected mode.        |
| **■ Stop**      | `score/stop`    | Halt playback now (cancels the bridge sequence via `robot/stop`). |
| **↻ Re-convert**| `score/convert` | Re-run Audiveris on the latest PDF and re-cache.             |

The service reports its state back on the retained `score/status` topic
(`idle` / `converting` / `ready` / `playing`), which drives the status line and
enables/disables the buttons in the UI.

## How to switch and compare

1. Start the broker, bridge, and note-reader service (`npm run broker`,
   `npm run bridge`, `npm run note-reader`).
2. Open the Web UI. Under the session controls, click **Streaming** or
   **Compiled** — published retained to `score/mode`.
3. Hit **▶ Play**. Watch the **Command → Strike Latency** panel (below).
4. Flip the mode toggle, hit **▶ Play** again, and compare. No reconvert needed
   unless you changed the PDF (then hit **↻ Re-convert**).

`SCORE_MODE=stream npm run note-reader` (env var) sets the fallback mode if the
UI has never published a choice. The retained UI value always wins when present.

## Comparing response time

Open the **Command → Strike Latency** panel in the Industrial Monitor while a
song plays. Each sample is the **real** command→ack round trip the NXT reports
back over Bluetooth — see [nxt-strike-confirmation.md](nxt-strike-confirmation.md)
— so the panel now fills up in **both** modes (it used to stay empty under
compiled, because there was no per-note MQTT command to measure).

What to look for:

- **Streaming** — notes are spaced out by the score's timing, so each press
  hits a relatively idle serial link; latencies are lower and steadier.
- **Compiled** — the bridge fires the whole schedule from its local clock, so
  bursts of near-simultaneous notes queue onto the same brick's 9600-baud link.
  You'll see the confirmation latency climb under those bursts — a direct
  picture of the actuation bottleneck that streaming's pacing hides.

So the head-to-head is: streaming trades simplicity and live control for
per-note network cost (and gentler serial load), while compiled trades a
one-time upload for tight local scheduling that can overwhelm the serial link in
dense passages. The latency panel and the motor heatmap (also driven by the real
`robot/strike`) make that trade-off visible at a glance.
