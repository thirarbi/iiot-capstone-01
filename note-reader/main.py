import json
import os
import glob
import subprocess
import sys
import time
import threading
import paho.mqtt.client as mqtt
from music21 import converter, tempo as m21tempo

# Logs carry emoji; force UTF-8 so a cp1252 Windows console (or a piped stdout)
# can't crash a print — important now that playback runs on worker threads,
# where an unhandled print error would silently kill the job.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ============================================================
# 1. KONFIGURASI PATH & NETWORK
# ============================================================
AUDIVERIS_PATH = r"C:\Program Files\Audiveris\Audiveris.exe"
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PDF_FOLDER = os.path.join(PROJECT_ROOT, "scores", "pdf")
MXL_FOLDER = os.path.join(PROJECT_ROOT, "scores", "mxl")

MQTT_BROKER = os.environ.get("MQTT_BROKER", "localhost")
MQTT_TOPIC   = "robot/score"     # single compiled score packet (mode: compiled)
MQTT_TOPIC_NOTE = "robot/nada"   # one note at a time, in real time (mode: stream)
CONVERT_TOPIC = "convert/status" # live progress beacon for the Web UI flow diagram
MODE_TOPIC   = "score/mode"      # retained; the Web UI picks "compiled" or "stream"

# Service control topics — the Web UI drives playback on demand (convert once,
# replay either mode without re-running Audiveris). See docs/score-delivery-modes.md.
STATUS_TOPIC      = "score/status"   # retained; service → UI: idle|converting|ready|playing
PLAY_TOPIC        = "score/play"     # UI → service: play the loaded score (optional {"mode"})
CONVERT_CMD_TOPIC = "score/convert"  # UI → service: (re)run Audiveris on the latest PDF
STOP_TOPIC        = "score/stop"     # UI → service: stop the current playback
ROBOT_STOP_TOPIC  = "robot/stop"     # service → bridge: cancel sequence + halt all motors

# Default delivery mode. The Web UI overrides this live via the retained
# score/mode topic; SCORE_MODE env var sets the fallback when the UI hasn't
# chosen one. See docs/score-delivery-modes.md.
DEFAULT_MODE = os.environ.get("SCORE_MODE", "compiled")

TEMPO_SCALE = 0.9  # fudge factor matching original timing

# Mapping Dasar untuk Robot (NXT-1, NXT-2, NXT-3)
BASE_MAP = {
    'C': 'DO', 'D': 'RE', 'E': 'MI', 
    'F': 'FA', 'G': 'SOL', 'A': 'LA', 'B': 'SI'
}

# ============================================================
# 2. FUNGSI HELPERS
# ============================================================
def get_latest_file(folder, extension):
    files = glob.glob(os.path.join(folder, f"*.{extension}"))
    return max(files, key=os.path.getmtime) if files else None

def publish_stage(client, stage, state="active", detail=""):
    """Tell the Web UI which pipeline stage is running right now.
    stage matches a flow-node id in public/script.js: src | omr | pub.
    state is 'active' while the step runs, or 'done' when the run finishes."""
    if client is None:
        return
    payload = json.dumps({
        "stage": stage,
        "state": state,
        "detail": detail,
        "ts": int(time.time() * 1000),
    })
    client.publish(CONVERT_TOPIC, payload, qos=0)

def process_pdf_to_mxl(pdf_path, progress=None):
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    # Hapus file lama agar tidak ada "ghost" data
    for ext in ['.omr', '.mxl', '.txt']:
        old_f = os.path.join(MXL_FOLDER, base_name + ext)
        if os.path.exists(old_f): os.remove(old_f)

    print(f"🔄 [STEP 1] Mengonversi PDF: {os.path.basename(pdf_path)}...")
    publish_stage(progress, "omr", "active", os.path.basename(pdf_path))
    command = [AUDIVERIS_PATH, "-batch", "-transcribe", "-export", "-output", MXL_FOLDER, pdf_path]
    try:
        subprocess.run(command, check=True)
        print("✅ Audiveris selesai!")
        return True
    except Exception as e:
        print(f"❌ Gagal: {e}")
        return False

def compile_score(mxl_path):
    """Parse MXL and return (bpm, list of {note, delay_ms} dicts).
    All timing is computed mathematically — no time.sleep needed."""
    score = converter.parse(mxl_path)

    # Read tempo from the score; default to 120 BPM if none marked
    marks = score.flatten().getElementsByClass(m21tempo.MetronomeMark)
    bpm = float(marks[0].number) if marks else 120.0
    quarter_ms = (60.0 / bpm) * 1000.0

    notes = score.parts[0].flatten().notes

    print(f"\n🚀 --- KOMPILASI SCORE ({bpm} BPM) ---")
    sequence = []
    last_offset = 0.0

    for n in notes:
        # Anti-Chord: ambil nada tertinggi
        note_obj = n.sortAscending()[-1] if n.isChord else n

        step     = note_obj.pitch.step
        oct_asli = note_obj.pitch.octave

        # --- LOGIKA "PAKSA" JULIAN (HARD CLAMPING) ---
        if step == 'C':
            # Threshold kita naikkan ke 6.
            # Jadi kalau Audiveris baca C4 atau C5, TETAP masuk ke DO rendah.
            if oct_asli >= 6:
                cmd     = 'DO_TINGGI'
                f_pitch = "C5"
            else:
                cmd     = 'DO'
                f_pitch = "C4"
        else:
            # Selain C, paksa semua ke Oktaf 4
            cmd     = BASE_MAP.get(step)
            f_pitch = f"{step}4"

        if not cmd:
            last_offset = n.offset
            continue

        gap_quarters = n.offset - last_offset
        delay_ms     = int(gap_quarters * quarter_ms * TEMPO_SCALE)
        sequence.append({"note": cmd, "delay_ms": max(delay_ms, 0)})
        print(f"  {step}{oct_asli} -> FORCED to: {f_pitch} -> {cmd}  (+{max(delay_ms, 0)} ms)")
        last_offset = n.offset

    print("-" * 40)
    return bpm, sequence

def get_play_mode(default=DEFAULT_MODE):
    """Read the delivery mode the Web UI selected, from the retained score/mode
    topic. Returns 'compiled' or 'stream'. Falls back to `default` if the broker
    is down or no mode has been chosen yet."""
    state = {"mode": default, "got": False}

    def on_connect(c, u, f, rc):
        c.subscribe(MODE_TOPIC)

    def on_message(c, u, msg):
        val = msg.payload.decode(errors="ignore").strip().strip('"')
        if val in ("compiled", "stream"):
            state["mode"] = val
        state["got"] = True

    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect(MQTT_BROKER, 1883, 60)
        client.loop_start()
        # Retained messages arrive right after subscribe; wait briefly for one.
        deadline = time.time() + 1.5
        while not state["got"] and time.time() < deadline:
            time.sleep(0.05)
    except Exception as e:
        print(f"⚠️  Tidak bisa membaca mode dari UI ({e}); pakai '{default}'")
    finally:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass
    return state["mode"]

def _interruptible_sleep(seconds, stop_event=None):
    """Sleep up to `seconds`, but bail out early if stop_event is set."""
    if seconds <= 0:
        return
    end = time.time() + seconds
    while time.time() < end:
        if stop_event is not None and stop_event.is_set():
            return
        time.sleep(min(0.05, max(0.0, end - time.time())))

def push_score(client, bpm, sequence, title="Untitled"):
    """MODE 'compiled': publish the entire score as one MQTT message (QoS 1).
    The NXT bridge schedules every note locally — no further network round trips."""
    payload = json.dumps({"title": title, "bpm": bpm, "notes": sequence})
    client.publish(MQTT_TOPIC, payload, qos=1)
    print(f"✅ Score terkirim (compiled): '{title}' — {len(sequence)} nada @ {bpm} BPM")

def stream_score(client, bpm, sequence, title="Untitled", stop_event=None):
    """MODE 'stream': send one note at a time, in real time, honouring each
    note's delay. Every note makes its own round trip PC → broker → bridge →
    motor, so the command→strike latency panel in the Web UI fills up — that's
    the per-note response time we want to compare against 'compiled'. Stops
    early if stop_event fires."""
    print(f"\n📡 --- STREAMING SCORE ({bpm} BPM, {len(sequence)} nada) ---")
    for item in sequence:
        if stop_event is not None and stop_event.is_set():
            print("⏹️  Streaming dihentikan")
            return
        # delay_ms is the gap BEFORE this note (same field the bridge schedules
        # against in compiled mode), so sleeping it here reproduces the rhythm.
        _interruptible_sleep(item["delay_ms"] / 1000.0, stop_event)
        if stop_event is not None and stop_event.is_set():
            print("⏹️  Streaming dihentikan")
            return
        client.publish(MQTT_TOPIC_NOTE, item["note"], qos=0)
        print(f"  → {item['note']}")
    print(f"✅ Streaming selesai: '{title}' — {len(sequence)} nada @ {bpm} BPM")

# ============================================================
# 3. LAYANAN / SERVICE — dikontrol dari Web UI
#    Convert sekali, lalu putar berulang (stream / compiled) sesuka hati,
#    tanpa menjalankan Audiveris lagi. Lihat docs/score-delivery-modes.md.
# ============================================================
score_lock     = threading.Lock()
SCORE          = {"title": None, "bpm": None, "sequence": None}  # the compiled, cached song
STATE          = {"value": "idle"}                               # idle|converting|ready|playing
current_mode   = {"value": DEFAULT_MODE}
stop_event     = threading.Event()
worker         = {"thread": None}    # at most one convert/play job at a time
service_client = None

def publish_status(state, extra=None):
    """Broadcast the service state to the Web UI (retained, so a fresh tab
    immediately knows whether a score is loaded / playing)."""
    STATE["value"] = state
    payload = {
        "state": state,
        "title": SCORE["title"],
        "notes": len(SCORE["sequence"]) if SCORE["sequence"] else 0,
        "mode":  current_mode["value"],
        "ts":    int(time.time() * 1000),
    }
    if extra:
        payload.update(extra)
    if service_client is not None:
        service_client.publish(STATUS_TOPIC, json.dumps(payload), qos=1, retain=True)

def busy():
    return worker["thread"] is not None and worker["thread"].is_alive()

def start_worker(target, *args):
    """Run a convert/play job on a background thread so the MQTT network loop
    stays responsive (e.g. can still receive Stop). Ignores the request if a
    job is already running."""
    if busy():
        print("⚠️  Sibuk — perintah diabaikan")
        return False
    stop_event.clear()
    t = threading.Thread(target=target, args=args, daemon=True)
    worker["thread"] = t
    t.start()
    return True

def do_convert():
    """Run Audiveris on the latest PDF, compile it, and cache the result."""
    pdf = get_latest_file(PDF_FOLDER, "pdf")
    if not pdf:
        print("⚠️  Tidak ada PDF di scores/pdf")
        publish_status("idle", {"error": "no pdf"})
        return

    publish_status("converting")
    publish_stage(service_client, "src", "active", os.path.basename(pdf))
    if not process_pdf_to_mxl(pdf, service_client):   # emits the "omr" stage
        publish_stage(service_client, "pub", "done")
        publish_status("idle", {"error": "convert failed"})
        return

    time.sleep(2)
    mxl = get_latest_file(MXL_FOLDER, "mxl")
    if not mxl:
        publish_stage(service_client, "pub", "done")
        publish_status("idle", {"error": "no mxl"})
        return

    title = os.path.splitext(os.path.basename(mxl))[0]
    publish_stage(service_client, "pub", "active", title)
    bpm, sequence = compile_score(mxl)
    with score_lock:
        SCORE.update({"title": title, "bpm": bpm, "sequence": sequence})
    publish_stage(service_client, "pub", "done")
    publish_status("ready")
    print(f"✅ Siap diputar: '{title}' — {len(sequence)} nada")

def do_play(mode):
    """Play the cached score in the requested mode. Runs on a worker thread."""
    with score_lock:
        title    = SCORE["title"]
        bpm      = SCORE["bpm"]
        sequence = list(SCORE["sequence"]) if SCORE["sequence"] else None
    if not sequence:
        print("⚠️  Belum ada score — convert dulu")
        publish_status("idle", {"error": "no score"})
        return

    publish_status("playing", {"playing_mode": mode})
    print(f"▶️  Memutar '{title}' mode {mode.upper()} ({len(sequence)} nada)")

    if mode == "stream":
        stream_score(service_client, bpm, sequence, title=title, stop_event=stop_event)
    else:
        push_score(service_client, bpm, sequence, title=title)
        # Compiled plays on the bridge; mirror its duration here so the UI shows
        # "playing" for the right length and Stop still works mid-song.
        total_s = sum(it["delay_ms"] for it in sequence) / 1000.0 + 0.8
        _interruptible_sleep(total_s, stop_event)

    if stop_event.is_set():
        service_client.publish(ROBOT_STOP_TOPIC, "", qos=0)  # halt motors / cancel sequence
        print("⏹️  Playback dihentikan")
    publish_status("ready")

def on_connect(c, u, f, rc):
    c.subscribe([(PLAY_TOPIC, 1), (CONVERT_CMD_TOPIC, 1), (STOP_TOPIC, 1), (MODE_TOPIC, 1)])
    print("🎧 Note-reader service connected — menunggu perintah dari Web UI")

def on_message(c, u, msg):
    topic = msg.topic
    if topic == MODE_TOPIC:
        v = msg.payload.decode(errors="ignore").strip().strip('"')
        if v in ("compiled", "stream"):
            current_mode["value"] = v
            publish_status(STATE["value"])   # keep the UI's mode field in sync
    elif topic == PLAY_TOPIC:
        mode = current_mode["value"]
        try:
            d = json.loads(msg.payload.decode() or "{}")
            if isinstance(d, dict) and d.get("mode") in ("stream", "compiled"):
                mode = d["mode"]
        except Exception:
            pass
        start_worker(do_play, mode)
    elif topic == CONVERT_CMD_TOPIC:
        start_worker(do_convert)
    elif topic == STOP_TOPIC:
        stop_event.set()
        c.publish(ROBOT_STOP_TOPIC, "", qos=0)

if __name__ == "__main__":
    current_mode["value"] = get_play_mode()
    print(f"🎚️  Mode awal: {current_mode['value'].upper()}")

    service_client = mqtt.Client()
    service_client.on_connect = on_connect
    service_client.on_message = on_message
    try:
        service_client.connect(MQTT_BROKER, 1883, 60)
    except Exception as e:
        print(f"❌ Tidak bisa konek broker: {e}")
        raise SystemExit(1)
    service_client.loop_start()
    publish_status("idle")

    # Convert the latest PDF once on startup so a score is ready to play.
    start_worker(do_convert)

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n👋 Menutup note-reader service")
        stop_event.set()
        publish_status("idle")
        time.sleep(0.2)
        service_client.loop_stop()
        service_client.disconnect()