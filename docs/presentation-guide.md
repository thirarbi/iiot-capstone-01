# Presentation Guide — IIoT Capstone (Robot Piano)

A slide-by-slide script for a **15–20 minute, 5-person** presentation of this
project for **TF4017 Industrial Internet of Things**. It tells you what goes on
each slide, **who owns it**, the **visualization to show**, and the **IIoT
competency** that slide is meant to prove.

> **The one-line story:** A PDF of sheet music is read by a computer, compiled
> into a timed note schedule, published once over an MQTT bus, and played by
> three LEGO NXT robots striking a real keyboard — while every press and
> heartbeat streams back to a live web dashboard. It is a complete
> **edge → broker → actuator → telemetry** loop built out of 2006 hardware.

---

## How the talk is divided (5 speakers)

| # | Speaker role | Slides | IIoT competency demonstrated | Time |
|---|--------------|--------|------------------------------|------|
| 1 | **Framing & Architecture** | 1–4 | What IIoT *is*; system topology; edge/broker/cloud layering | ~3 min |
| 2 | **Edge Input — Score Pipeline** | 5–7 | Digitizing the physical world; data ingestion & transformation at the edge | ~3 min |
| 3 | **Communication Layer — MQTT** | 8–10 | Pub/sub messaging, broker, QoS, topic design, decoupling | ~3.5 min |
| 4 | **Edge Actuation & Sensing** | 11–13 | Actuators + sensors on the same device; bidirectional edge; protocol work | ~3.5 min |
| 5 | **Monitoring, Results & Roadmap** | 14–17 | Telemetry, historian/logging, dashboards, predictive maintenance, cloud | ~3.5 min |
| — | **Live demo + Q&A** | 18 | Whole team | ~3–4 min |

**Total: 16–18 min of slides + 3–4 min demo/Q&A = comfortably inside 20 min.**
Target ~18 content slides. Keep ≈1 minute per slide; never read bullets aloud.

---

# SECTION 1 — Framing & Architecture (Speaker 1)

## Slide 1 — Title
**Owner:** Speaker 1 (whole team on stage)
**Content:**
- Project title: *"Robot Piano: An Industrial IoT Pipeline from Sheet Music to Sound"*
- Course / institution: TF4017 IIoT, ITB Engineering Physics
- All five names + role tags ("Edge Input", "Comms", "Actuation", "Dashboard", "Architecture")
- One hero photo: the three NXT robots over the keyboard.

**Visualization:** A single high-quality **photo or short looping video** of the
physical rig actually playing. This is your hook — open with the thing working.

**Speaker note:** 20 seconds. Name the team, name the one-line story, move on.

---

## Slide 2 — The Problem & Motivation
**Owner:** Speaker 1
**Content:**
- The challenge: take an *unstructured physical artifact* (a printed score) and
  drive *physical actuators* in real time, reliably, with feedback.
- Why this is an IIoT problem, not just robotics: it needs **distributed
  processes**, a **message bus**, **QoS guarantees**, **telemetry**, and an
  **operations dashboard** — the same building blocks as a factory line.
- The analogy to state explicitly: *notes → parts on a conveyor; motors →
  actuators on a line; the dashboard → a SCADA/ops screen.*

**Visualization:** A two-column "**Toy ↔ Factory**" mapping graphic:
`Sheet music → Work order`, `Note schedule → Production plan`,
`NXT motor strike → Actuator cycle`, `robot/strike → Machine confirmation`,
`Health heartbeat → Asset liveness`. This proves you understand the *industrial*
framing.

**Speaker note:** This slide earns the word "Industrial" in the course title.

---

## Slide 3 — System Architecture (the money slide)
**Owner:** Speaker 1
**Content:**
- The full end-to-end block diagram with every component labeled by technology.
- Call out the **three independent processes**: broker, HTTP/logger server, NXT
  bridge — plus the Python note-reader and the browser UI.

**Visualization (REQUIRED — the centerpiece):** The architecture diagram, drawn
cleanly from the repo's own data flow:

```
 PDF score
   └─► Audiveris (OCR)  ─►  .mxl  ─►  music21 / main.py (compile to JSON)
                                            │  publish robot/score (QoS 1, once)
                                            ▼
                              ┌──────  Aedes MQTT Broker  ──────┐
                              │   TCP :1883   |   WS :8883       │
                              ▼                                  ▼
                     src/nxt_bridge.js                  public/ Web UI (Paho.js)
                  (local sequencer, serial)         (keys, monitor dashboard)
                              │  NXT Direct Commands over Bluetooth @ 9600 baud
                              ▼
                  NXT-1 / NXT-3 / NXT-4  ──► 🎵 strike key ──► robot/strike ─► UI
                       ▲
                  touch sensors ──► robot/touch ──► session JSONL log
```

**Speaker note:** Spend real time here — every other speaker will point back to
*their box* on this diagram. Label the three colored layers: **Edge ingest** /
**Broker** / **Edge actuate+sense** / **Supervisory UI**.

---

## Slide 4 — Tech Stack & Team Ownership
**Owner:** Speaker 1
**Content:** The stack table straight from the codebase, with the owner of each:

| Layer | Technology | Owner |
|---|---|---|
| Web UI / Dashboard | HTML/CSS + Paho.js (MQTT over WebSocket) | Speaker 5 |
| HTTP server + session logger | Node.js `http` + `mqtt` | Speaker 5 |
| MQTT broker | Aedes (TCP 1883 / WS 8883) | Speaker 3 |
| NXT bridge | Node.js + `serialport` | Speaker 4 |
| Note reader | Python + `music21` + `paho-mqtt` | Speaker 2 |
| OMR | Audiveris (batch OCR) | Speaker 2 |
| Hardware | 3× LEGO NXT, motors + touch sensors | Speaker 4 |

**Visualization:** The table above, color-coded to match the layer colors on
Slide 3. Smooth handoff: "…and here's who built what."

---

# SECTION 2 — Edge Input: Score Pipeline (Speaker 2)

## Slide 5 — From Paper to Data (Ingestion)
**Owner:** Speaker 2
**Content:**
- The job of the edge-input node: turn a **physical/analog artifact** (printed
  score) into **structured digital data**.
- Pipeline: `PDF → Audiveris OCR (OMR) → MusicXML (.mxl) → music21 parse`.
- Mention the real artifact in the repo: `ibu-kita-kartini.mxl`.

**Visualization (REQUIRED):** A **before/after strip**: a snippet of the actual
sheet-music PDF on the left → an arrow through the "Audiveris" box → the parsed
note list on the right (`C4 → DO`, `D4 → RE`, …). Showing the OCR of a real
score is strong evidence of a working ingest stage.

**Speaker note:** This is "digitizing the physical world" — the first sentence
of any IIoT definition.

---

## Slide 6 — Compile, Don't Stream (the key engineering decision)
**Owner:** Speaker 2
**Content:**
- The naïve approach: publish one MQTT message per note with `time.sleep`
  between them. Problem: **network jitter, dropped notes break the beat, sender
  must stay alive the whole song.**
- The chosen approach: **compile the entire song into ONE JSON "score packet"**
  and publish it once. Timing math (`offset → delay_ms`) happens at the edge;
  the bridge owns playback timing thereafter.
- Show the `delay_ms` schema and the `quarter_ms = 60000 / bpm` calculation.

**Visualization (REQUIRED):** A **side-by-side timing diagram** —
*"Per-note streaming (jitter accumulates)"* vs *"Single-push + local sequencer
(jitter ≈ event-loop tick)"*. Reuse the t=0/t=505/t=1005 timeline from
`docs/compiled-score-single-push.md`. This is your headline
engineering-trade-off slide; it shows you reasoned about real-time control.

**Speaker note:** This is where you prove *engineering judgment*, not just that
it works. Emphasize: jitter went from *O(network RTT per note)* to *O(1 ms)*.

---

## Slide 7 — The Score Packet (the data contract)
**Owner:** Speaker 2
**Content:**
- The JSON payload format published to `robot/score`:
  `{ title, bpm, notes: [{ note, delay_ms }] }`.
- Note the design choice: timing is in **wall-clock milliseconds**, so the
  bridge needs *zero* musical-theory knowledge — clean separation of concerns.
- Mention QoS 1 so the broker ACKs before the Python process exits.

**Visualization:** A clean JSON code block of a real score packet, annotated
with callouts ("`delay_ms` = wait *before* this strike", "first note always 0",
"~100–200 notes, ~20–40 KB"). A **data contract** between two teams is exactly
what IIoT interoperability is about — say that.

---

# SECTION 3 — Communication Layer: MQTT (Speaker 3)

## Slide 8 — Why a Message Bus? (Pub/Sub & Decoupling)
**Owner:** Speaker 3
**Content:**
- The core IIoT pattern: **publish/subscribe** decouples producers from
  consumers. The note-reader doesn't know the bridge exists; both only know the
  broker and a topic.
- Broker = **Aedes**, running TCP `:1883` (for Node/Python) and WebSocket
  `:8883` (for the browser — browsers can't do raw TCP). This dual-port detail
  is worth a sentence; it's a real IIoT edge/UI integration concern.

**Visualization (REQUIRED):** A **pub/sub hub-and-spoke diagram**: the broker in
the center; publishers (note-reader, bridge, UI) and subscribers (bridge, UI,
logger) as spokes, each labeled with its topic and arrow direction. Contrast it
visually with a "point-to-point spaghetti" anti-pattern on the side to show what
the bus *saves* you.

---

## Slide 9 — Topic Map & QoS Strategy
**Owner:** Speaker 3
**Content:** Walk the real topic table and the *reasoning* behind QoS choices.

| Topic | Direction | QoS | Why |
|---|---|---|---|
| `robot/score` | Python → bridge/UI | 1 | Control msg — must not be lost |
| `robot/nada` | UI → bridge | 0 | Manual key press, latency over reliability |
| `robot/strike` | bridge → UI | 0 | High-rate feedback, a drop is fine |
| `robot/touch` | bridge → world | 0 | High-rate events, latency-sensitive |
| `session/status` | logger → UI | 1 **retained** | Fresh tab must see current state |
| `health/bridge`, `health/server` | → UI | 0 **retained** | Liveness, last value always available |

**Visualization (REQUIRED):** The table above with **two columns highlighted**:
the **QoS** column and the **retained** flag. Add a small legend explaining
*QoS 0 vs 1* and *why `retained` matters* (a late-joining subscriber instantly
gets the last value — that's how a refreshed dashboard shows correct state).

**Speaker note:** Differentiated QoS per traffic class — control vs telemetry —
is a genuine IIoT competency. Don't just list topics; justify each QoS.

---

## Slide 10 — Naming Convention & Extensibility
**Owner:** Speaker 3
**Content:**
- Topic namespacing: `robot/*` (hardware), `session/*` (recording lifecycle),
  `health/*` (liveness), reserved `cloud/*` (future remote bridging).
- Backwards compatibility: adding the compiled-score and touch pipelines
  touched **nothing** in the original `robot/nada`/`strike` flow.

**Visualization:** A **topic namespace tree** (`robot/`, `session/`, `health/`,
`cloud/`) shown as folders, with a "reserved / future" tag on `cloud/`. Shows
you designed an addressing scheme, not ad-hoc strings.

---

# SECTION 4 — Edge Actuation & Sensing (Speaker 4)

## Slide 11 — Driving 2006 Hardware (Actuation)
**Owner:** Speaker 4
**Content:**
- The bridge subscribes to `robot/score`, then schedules every note with a local
  `setTimeout` chain — the **edge node owns real-time timing**.
- Talking to the NXT: hand-built **NXT Direct Command** byte packets over
  **Bluetooth serial @ 9600 baud**. Show the `makeRunPacket` strike → reverse →
  stop sequence with `PRESS_DEGREES` tacho limit and `HOLD_MS` window.
- Note-to-hardware map: 8 notes spread across 3 bricks × motor ports A/B/C.

**Visualization (REQUIRED):** An **annotated byte-packet diagram** of a Direct
Command (`0x0C 0x00 0x80 0x04 <port> <power> …`) with each byte labeled
(length, command type, opcode, port, power, tacho limit). Working at the
**protocol/byte level** is a standout competency — most teams stay in libraries.
Pair it with a small **note → {NXT, port}** mapping grid.

**Speaker note:** "9600 baud Bluetooth from 2006" is your engineering-constraint
story — it motivates the latency discussion on Slide 15.

---

## Slide 12 — Closing the Loop: Touch Sensors (Bidirectional Edge)
**Owner:** Speaker 4
**Content:**
- The same NXT bricks are *also sensors*: touch sensors on the input ports.
- The bridge polls each sensor (`GetInputValues`, 150 ms cadence, staggered),
  reassembles serial frames, detects **rising edges only**, and publishes
  `robot/touch`.
- This is the flagship IIoT point: **one edge device is both actuator and
  sensor** — the bidirectional story.

**Visualization (REQUIRED):** A **bidirectional loop diagram**:
`UI/score → bridge → motor (actuate)` on top, and
`touch sensor → bridge → robot/touch → UI/log (sense)` on the bottom, sharing
the same NXT box in the middle. Add a tiny **"rising-edge" waveform** inset
(press transition 0→1 = one event) to show debounced edge detection, not raw
polling spam.

---

## Slide 13 — Frame Reassembly & Robustness
**Owner:** Speaker 4
**Content:**
- Serial is a byte stream, not messages — the bridge buffers incoming bytes and
  drains complete length-prefixed frames (`rxBuffers` logic).
- Defensive handling: `safeWrite` error callbacks, validity checks on the reply
  telegram (`frame[4] !== 0x01` → ignore), `busyMotors`/sequencer cancellation
  so a new song cleanly replaces the current one.

**Visualization:** A small **state/flow diagram** of the RX path:
`bytes in → concat buffer → length-prefix check → complete frame? → parse →
rising-edge filter → publish`. Demonstrates real embedded-comms robustness, not
a happy-path demo.

**Speaker note:** If short on time, *merge Slide 13 into 12* — keep it as a
backup/appendix slide for a likely Q&A question.

---

# SECTION 5 — Monitoring, Results & Roadmap (Speaker 5)

## Slide 14 — The Industrial Monitor Dashboard
**Owner:** Speaker 5
**Content:**
- Every real IIoT deployment needs a supervisory/ops screen. Ours is the
  **Industrial Monitor** panel in the Web UI, fed *live* off the MQTT bus —
  no extra instrumentation, it just subscribes and draws.
- Built and live: live data-flow view, latency view, per-motor heatmap, and the
  health/connection strip (driven by retained `health/*` heartbeats).

**Visualization (REQUIRED):** A **screenshot (or live screen-share) of the
actual dashboard**. If you show only one visualization in the whole talk, make
it the **live data-flow diagram**: a glowing packet traveling
`score → broker → bridge → NXT → 🎵` in real time as a note plays. It is the
single best artifact for explaining *what IIoT is* to a non-expert.

---

## Slide 15 — Latency & Jitter (the core quality metric)
**Owner:** Speaker 5
**Content:**
- Measure delay between command (`robot/nada` / scheduled note) and confirmation
  (`robot/strike`). Report the distribution + a live "current latency" gauge.
- Tie the numbers back to the design: the 9600-baud Bluetooth serial write and
  `HOLD_MS`/`POLL_INTERVAL_MS` are the visible bottlenecks; single-push removed
  per-note network jitter.

**Visualization (REQUIRED):** A **latency histogram** + a **live gauge**.
Latency and jitter are *the* quality metric for any real-time control loop —
showing a measured distribution (not a vibe) is hard evidence of engineering
rigor. If you can, overlay "per-note streaming" vs "single-push" to quantify the
improvement from Slide 6.

---

## Slide 16 — Telemetry, Historian & Predictive Maintenance
**Owner:** Speaker 5
**Content:**
- **Historian:** every touch press is logged to per-session **JSONL** files
  (`session-*.jsonl`), controlled by `session/begin`/`end`, with a retained
  `session/status` so the UI always shows the true recording state.
- **Predictive maintenance angle:** a **per-NXT / per-motor activity heatmap**
  surfaces which motor fires most — a wear/overheat hotspot. That's a flagship
  IIoT use case, demonstrated on toy hardware.
- **Replay:** logs can be scrubbed/replayed offline without the hardware
  present — the value of time-series logging.

**Visualization (REQUIRED):** Two panels — (a) the **3×3 motor heatmap** (bricks
× ports, color = fire count) with a "hotspot" callout; (b) a **piano-roll
timeline** (notes on Y, time on X) overlaying *commanded* (hollow) vs *struck*
(filled) vs *human touch* (third color). The gap between hollow and filled is a
literal picture of actuation latency and dropped notes.

---

## Slide 17 — Roadmap & Conclusion
**Owner:** Speaker 5
**Content:**
- **Implemented:** compiled single-push playback, 3-robot actuation, touch
  sensing, session logging, live monitor dashboard (data-flow, latency, heatmap,
  health).
- **Next (designed, in `docs/`):** ship session JSONL to a remote/cloud broker
  on `cloud/sessions/*` (the `cloud/*` namespace is already reserved); a
  human-vs-robot "Guitar Hero" accuracy duel using the touch pipeline.
- One sentence on what you'd do differently / what you learned about IIoT.

**Visualization:** A compact **"Done ✅ / Next ⏭️" roadmap board**, plus the
reserved `cloud/*` arrow extending the Slide 3 architecture off-box to a cloud
icon — visually closing the "edge → broker → **cloud**" story the course is built
around.

---

## Slide 18 — Live Demo + Q&A
**Owner:** Whole team
**Content:**
- Run it: drop a PDF → watch the dashboard light up → robots play → keys
  highlight → press a physical touch sensor and watch the UI/log react.
- Have a **30-second pre-recorded video fallback** in case the hardware/Bluetooth
  misbehaves live (it's 2006 Bluetooth — assume it will).

**Visualization:** The **live system itself** + the dashboard projected beside
it. End on the working loop, same as you opened.

---

# Visualizations checklist (what proves competency)

Build these as concrete assets. The **bold** ones are non-negotiable — each maps
to a distinct IIoT competency examiners look for.

| # | Visualization | Slide | Competency it proves |
|---|---------------|-------|----------------------|
| 1 | **End-to-end architecture diagram** | 3 | System thinking / edge-broker-cloud topology |
| 2 | Toy ↔ Factory mapping | 2 | Understanding the *industrial* framing |
| 3 | PDF → parsed-notes before/after | 5 | Edge data ingestion / digitizing the physical |
| 4 | **Streaming-vs-single-push timing diagram** | 6 | Real-time control & engineering trade-offs |
| 5 | Annotated score-packet JSON | 7 | Data contracts / interoperability |
| 6 | **Pub/sub hub-and-spoke diagram** | 8 | Messaging architecture & decoupling |
| 7 | **Topic + QoS table (highlighted)** | 9 | QoS/reliability reasoning per traffic class |
| 8 | **Annotated NXT byte packet** | 11 | Low-level protocol / embedded comms |
| 9 | **Bidirectional actuator+sensor loop** | 12 | Two-way edge devices (core IIoT idea) |
| 10 | **Live data-flow dashboard (animated)** | 14 | Supervisory/ops visualization |
| 11 | **Latency histogram + live gauge** | 15 | Measured real-time quality metrics |
| 12 | **Motor heatmap + piano-roll** | 16 | Historian, telemetry, predictive maintenance |
| 13 | Done/Next roadmap + cloud extension | 17 | Cloud/scaling vision |

Most of #10–12 can be captured live off the MQTT bus or replayed from a
`session-*.jsonl` file — **no extra hardware needed**, just subscribe and draw.

---

# Delivery tips

- **Rehearse the handoffs.** Five speakers means four transitions; each should be
  one sentence pointing at the architecture diagram ("my part is *this* box").
- **Keep Slide 3 visible in spirit.** Every speaker should be able to gesture
  back to where their component sits in the whole.
- **Lead and close with the working rig** (Slides 1 and 18). Demo-bookending
  beats slideware.
- **Numbers over adjectives.** "Jitter dropped from network-RTT-per-note to ~1 ms"
  and a real latency histogram beat "it works well."
- **One backup slide** (Slide 13 detail / raw packet dump / QoS deep-dive) ready
  for Q&A, not in the main flow.
- **Have the fallback video.** 2006 Bluetooth at 9600 baud *will* pick the worst
  moment to disconnect.
