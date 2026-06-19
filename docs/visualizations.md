# Visualization Ideas

Cool ways to *see* what this Industrial IoT system is doing. The goal of every
visualization here is to make an otherwise invisible pipeline — PDF → OMR →
MQTT → Bluetooth → spinning motors — legible to someone watching for the first
time.

The system already emits everything we need: a live MQTT message bus
(see [mqtt-topics.md](mqtt-topics.md)) and per-session JSONL logs
(see [session-logging.md](session-logging.md)). Most of these can be built
without touching the hardware — just subscribe and draw.

> **Status:** #1, #3, #4, and #7 are implemented in the Web UI as the
> **Industrial Monitor** panel ([../public/index.html](../public/index.html),
> [../public/script.js](../public/script.js)). They run live off the MQTT bus;
> #7 is fed by the new retained `health/bridge` / `health/server` heartbeats.
> #2, #5, and #6 remain ideas.

---

## 1. Live data-flow diagram (the "money shot")

**What:** An animated version of the README architecture diagram where a glowing
packet travels each hop in real time:

```
PDF ──> Audiveris ──> main.py ──> [broker] ──> nxt_bridge ──> NXT-1 ──> 🎵 DO
                                      │
                                   Web UI
```

Each stage lights up as the message passes through it. When `robot/score`
fires, the whole chain pulses; when a `robot/strike` confirmation comes back,
the corresponding NXT box flashes green.

**Why it's cool:** It turns the abstract "edge → broker → actuator" IIoT
topology into something you can literally watch a note flow through. This is the
single best artifact for explaining *what IIoT is* to a non-expert.

**Data source:** Subscribe over MQTT-WS (port 8883) to `robot/score`,
`robot/nada`, `robot/strike`, `robot/touch`. No new instrumentation needed.

---

## 2. Note piano-roll / timeline

**What:** A horizontal piano-roll (like a MIDI editor) with the 8 notes
(DO, RE, MI, FA, SOL, LA, SI, DO') on the Y axis and time on the X axis. Plot:

- **Commanded notes** (`robot/score` schedule, or `robot/nada`) as hollow blocks
- **Confirmed strikes** (`robot/strike`) as filled blocks
- **Human touch presses** (`robot/touch`) as a third colored layer

**Why it's cool:** Lays the *intended* score against what the robots *actually*
played, and against what a human pressed. The gap between hollow and filled
blocks is a direct picture of actuation latency and dropped notes.

**Data source:** Replayable straight from a `logs/session-*.jsonl` file, or live
off the bus.

---

## 3. End-to-end latency histogram

**What:** Measure the delay between a command going out (`robot/nada` /
scheduled `robot/score` note) and the strike confirmation (`robot/strike`)
coming back. Plot the distribution as a histogram, plus a live "current
latency" gauge.

**Why it's cool:** Latency and jitter are *the* core quality metric for any
real-time IIoT control loop. The NXT is "ancient 2006 tech" talking over
Bluetooth serial at 9600 baud — visualizing that bottleneck makes the
engineering trade-offs concrete. The `HOLD_MS`, `POLL_INTERVAL_MS`, and
serial-write timing in [../src/nxt_bridge.js](../src/nxt_bridge.js) all show up
here.

**Data source:** Pair `robot/strike` timestamps against the originating command;
or post-process a session log offline.

---

## 4. Per-NXT / per-motor activity heatmap

**What:** A grid — 3 NXT bricks × 3 motor ports — where each cell's color
intensity reflects how often that motor fired during a song or session. A second
mode shows live "which motor is moving *right now*."

**Why it's cool:** Surfaces hardware load balancing — which brick is doing the
most work, whether one motor is a hotspot likely to wear out or overheat. That's
a genuine predictive-maintenance angle, which is a flagship IIoT use case.

**Data source:** Count `robot/strike` events per note, mapped to `{nxt, port}`
via the `NOTE_MAP` in [../src/nxt_bridge.js](../src/nxt_bridge.js).

---

## 5. Session replay scrubber

**What:** Load a `session-*.jsonl` file and scrub through it on a timeline,
re-animating the piano-roll (#2) and data-flow (#1) at 1×, 2×, or 0.25× speed.
Effectively a "DVR" for a performance.

**Why it's cool:** Demonstrates the value of historian/time-series logging — you
can review any past run without the hardware present. Great for demos and for
debugging "what happened on that one weird take."

**Data source:** [session-logging.md](session-logging.md) JSONL files in
`logs/`.

---

## 6. Human-vs-robot input duel (touch sensors)

**What:** Using the reverse-direction touch pipeline
(see [nxt-touch-input.md](nxt-touch-input.md)), show a split view: notes the
robot played vs. notes a human pressed on the physical touch sensors, scored for
timing accuracy against the reference melody — a "Guitar Hero" style accuracy
readout.

**Why it's cool:** Closes the loop visually — the same instrument is both an
*actuator* (motors) and a *sensor* (touch), which is exactly the bidirectional
edge-device story IIoT is about.

**Data source:** `robot/touch` events vs. `robot/strike` / `robot/score`.

---

## 7. System health / connection dashboard

**What:** A status strip showing each component's liveness: broker up?, bridge's
serial ports open (per COM port)?, web UI connected?, session active? Use a retained
MQTT heartbeat per component and the existing retained `session/status` topic.

**Why it's cool:** Every real IIoT deployment needs an ops dashboard. The serial
`open`/`error` events already logged in
[../src/nxt_bridge.js](../src/nxt_bridge.js) map directly onto green/red
indicators per NXT.

**Data source:** Existing `session/status` (retained); add a lightweight
`<component>/heartbeat` retained topic per process.

---

## Suggested build order

| Priority | Visualization                | Effort | Payoff                          |
|----------|------------------------------|--------|---------------------------------|
| 1        | Live data-flow diagram (#1)  | Medium | Best explainer of the whole system |
| 2        | Note piano-roll (#2)         | Low    | Reuses MQTT client already in the UI |
| 3        | Latency histogram (#3)       | Low    | Strong engineering/IIoT metric  |
| 4        | Activity heatmap (#4)        | Low    | Predictive-maintenance angle    |
| 5        | Session replay (#5)          | Medium | Builds on #1 and #2             |

Start with #2 and #3 — both are pure subscribers over the WebSocket port the
Piano Tiles UI already uses, so they drop into [../public/](../public/) with no
backend changes.
