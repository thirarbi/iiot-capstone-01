# IIoT Capstone — NXT Xylophone Player
<div align="center"> <br>
<img src=https://img.shields.io/badge/NXT-Mindstorm-orange?logo=lego> <img src=https://img.shields.io/badge/Node.js-16+-6DA55F?logo=node.js&logoColor=white> <img src=https://img.shields.io/badge/Audiveris-white?logo=apple%20music&logoColor=red> <br>
<img src=JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000> <img src=https://img.shields.io/badge/HTML-%23E34F26.svg?logo=html5&logoColor=white> <img src=https://img.shields.io/badge/CSS-639?logo=css&logoColor=fff)> <img src=https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=fff>
</div>
<br>

A Capstone Project for TF4017 Industrial Internet of Things (IIoT) that converts **PDF sheet music** into physical xylophone performances using **LEGO NXT robots** (ancient 2006 tech), controlled using **MQTT**.Protocol. Is also able to send data over ITB (Bandung Institute of Technology) Engineering Physics Department's server for temporary data sending.

The system features a **Piano Tiles web UI** for manual play and a **Note Reader** pipeline that automatically reads sheet music via Optical Music Recognition (OMR).

This project is both hand-coded and Claude Code vibe-coded.
Show some love ⭐💕

## Preview
<p align="center">
  <img src="public\images\neon_preview.png" alt="Neon preview"  width=48%/>
  <img src="public\images\classic_preview.png" alt="classic preview" width=34%/>
</p>
<p align="center">
  <img src="public\images\xylophone_preview.png" alt="Xylophone preview" width = 50%/>
</p>


## Project Structure

```
iiot-capstone-01/
├── src/                    # Node.js backend
│   ├── server.js           # HTTP server + starts MQTT broker
│   ├── broker.js           # Aedes MQTT broker (TCP 1883 + WS 8883)
│   └── nxt_bridge.js       # Bluetooth serial bridge to NXT robots
├── public/                 # Frontend (Piano Tiles UI)
│   ├── index.html          # Piano tiles interface
│   └── script.js           # Browser-side MQTT client
├── note-reader/            # OMR + music parsing pipeline
│   ├── main.py             # PDF → MXL → MQTT note publisher
│   └── requirements.txt    # Python dependencies
├── firmware/               # NXT brick firmware
│   └── NXT_Subscriber.nxc  # Motor control program for NXT
├── scores/                 # Music score files
│   ├── pdf/                # Input PDF sheet music
│   └── mxl/                # Audiveris output (MusicXML + OMR)
├── demo/                   # Archived Week 2 lab demo files
├── package.json            # Node.js dependencies & scripts
└── README.md
```

## Architecture

```
┌──────────────┐   Audiveris   ┌──────────┐   music21    ┌────────────┐
│  PDF Sheet   │ ────(OMR)────>│   .mxl   │ ──(parse)──> │  main.py   │
│  Music       │               │(MusicXML)│              │ (Publisher)│
└──────────────┘               └──────────┘              └─────┬──────┘
                                                               │
                                               MQTT publish "robot/nada"
                                                               │
┌──────────────┐                                         ┌─────▼──────┐
│  Piano Tiles │ ── MQTT WebSocket (8883) ──────────────>│  broker.js │
│  Web UI      │<── subscribe (visual feedback) ─────────│  (Aedes)   │
└──────────────┘                                         └─────┬──────┘
                                                               │
                                                       MQTT TCP (1883)
                                                               │
                                                        ┌──────▼──────┐
                                                        │ nxt_bridge  │
                                                        │(Serial BT)  │
                                                        └──────┬──────┘
                                                               │
                                              Bluetooth Serial (COM ports)
                                    ┌──────────────┬───────────┴──────────┐
                                    ▼              ▼                      ▼
                               ┌─────────┐   ┌─────────┐           ┌─────────┐
                               │  NXT-1  │   │  NXT-2  │           │  NXT-3  │
                               │DO RE MI │   │FA SOL LA│           │SI DO'   │
                               └─────────┘   └─────────┘           └─────────┘
```

## Prerequisites

- **Node.js** (v16+)
- **Python 3** with `pip`
- **Audiveris** — [Github Repo](https://github.com/audiveris/audiveris) (configurable in `note-reader/main.py`)
- **LEGO NXT bricks** paired via Bluetooth (COM ports configured in `src/nxt_bridge.js`)

## Setup

### 1. Install Node.js dependencies

```bash
npm install
```

### 2. Install Python dependencies

```bash
pip install -r note-reader/requirements.txt
```

### 3. Configure COM ports

Edit `src/nxt_bridge.js` and update the `NXT_DEVICES` array with your Bluetooth COM port assignments.

### 4. Configure MQTT broker address (optional)

By default, all components connect to `localhost`. To use a remote broker:

- **NXT Bridge:** set the `MQTT_BROKER` environment variable, e.g. `set MQTT_BROKER=mqtt://192.168.1.100:1883`
- **Note Reader:** set the `MQTT_BROKER` environment variable, e.g. `set MQTT_BROKER=192.168.1.100`

## Usage

### Start everything (recommended)

```bash
npm run all
```

One command launches the whole stack — broker, web server, NXT bridge, and the
note-reader service — with labelled, colour-coded output. Press **Ctrl+C** to
stop them all. (Each piece can still be run on its own in a separate terminal;
see below.)

This brings up:
- MQTT broker on port **1883** (TCP) and **8883** (WebSocket) — `npm run broker`
- Web UI + session logger at **http://localhost:8080** — `npm start`
- NXT bridge (motors + touch sensors) — `npm run bridge`
- Note-reader service — `npm run note-reader`

### The Note Reader (now a service)

Place a PDF score in `scores/pdf/`. The note-reader starts as a **service**: on
launch it runs Audiveris on the latest PDF, compiles the notes, and then waits
for commands from the Web UI. You control playback from the page:

- **▶ Play** — play the compiled score
- **■ Stop** — halt playback immediately
- **↻ Re-convert PDF** — re-run Audiveris (only needed when you change the PDF)
- **Score send mode** — choose **Streaming** (one note at a time, real time) or
  **Compiled** (send the whole song once, the bridge plays it locally) and
  compare their response time in the Industrial Monitor's latency panel. See
  [docs/score-delivery-modes.md](docs/score-delivery-modes.md).

### Manual play

Open **http://localhost:8080** and press the piano keys (mouse or A–K on the
keyboard) to drive individual motors. Holding a key holds the note; motor
behaviour is tunable per-motor in [config/motors.json](config/motors.json) —
see [docs/motor-tuning.md](docs/motor-tuning.md).

## How It Works

| Component | Role |
|---|---|
| `src/broker.js` | Aedes MQTT broker — central message hub |
| `src/server.js` | HTTP server for the Piano Tiles UI; also starts the broker |
| `src/nxt_bridge.js` | Subscribes to `robot/nada`, sends NXT Direct Commands over Bluetooth serial |
| `public/index.html` | Piano Tiles UI with 8 colored keys (DO–DO') |
| `public/script.js` | Browser MQTT client — sends notes on click, highlights keys on incoming messages |
| `note-reader/main.py` | Full pipeline: PDF → Audiveris OMR → MusicXML → music21 parsing → MQTT publish |
| `firmware/NXT_Subscriber.nxc` | NXC firmware for the NXT brick — reads Bluetooth mailbox and strikes motors |

## Integration

The **Piano Tiles UI** and **Note Reader** are integrated through MQTT:

- Both publish to the same topic (`robot/nada`)
- The web UI **subscribes** to `robot/nada`, so when the Note Reader plays a song, each note is visually highlighted on the piano in real time
- Manual key presses from the UI are also published and trigger the NXT robots
- The activity log shows all sent and received notes with timestamps
