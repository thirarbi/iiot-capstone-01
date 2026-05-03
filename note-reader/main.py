import json
import os
import glob
import subprocess
import time
import paho.mqtt.client as mqtt
from music21 import converter, tempo as m21tempo

# ============================================================
# 1. KONFIGURASI PATH & NETWORK
# ============================================================
AUDIVERIS_PATH = r"C:\Program Files\Audiveris\Audiveris.exe"
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PDF_FOLDER = os.path.join(PROJECT_ROOT, "scores", "pdf")
MXL_FOLDER = os.path.join(PROJECT_ROOT, "scores", "mxl")

MQTT_BROKER = os.environ.get("MQTT_BROKER", "localhost")
MQTT_TOPIC  = "robot/score"   # single compiled score packet

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

def process_pdf_to_mxl(pdf_path):
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    # Hapus file lama agar tidak ada "ghost" data
    for ext in ['.omr', '.mxl', '.txt']:
        old_f = os.path.join(MXL_FOLDER, base_name + ext)
        if os.path.exists(old_f): os.remove(old_f)

    print(f"🔄 [STEP 1] Mengonversi PDF: {os.path.basename(pdf_path)}...")
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

def push_score(bpm, sequence, title="Untitled"):
    """Publish the entire compiled score as a single MQTT message (QoS 1)."""
    client = mqtt.Client()
    try:
        client.connect(MQTT_BROKER, 1883, 60)
    except Exception as e:
        print(f"❌ Gagal konek Broker MQTT: {e}")
        return

    payload = json.dumps({"title": title, "bpm": bpm, "notes": sequence})
    client.publish(MQTT_TOPIC, payload, qos=1)
    # Wait for QoS-1 PUBACK before disconnecting
    client.loop(timeout=1.0)
    print(f"✅ Score terkirim: '{title}' — {len(sequence)} nada @ {bpm} BPM")
    client.disconnect()

# ============================================================
# 3. ALUR UTAMA
# ============================================================
if __name__ == "__main__":
    pdf = get_latest_file(PDF_FOLDER, "pdf")
    if pdf:
        if process_pdf_to_mxl(pdf):
            time.sleep(2)
            mxl = get_latest_file(MXL_FOLDER, "mxl")
            if mxl:
                title = os.path.splitext(os.path.basename(mxl))[0]
                bpm, sequence = compile_score(mxl)
                push_score(bpm, sequence, title=title)