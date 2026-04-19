import os
import glob
import subprocess
import time
import paho.mqtt.client as mqtt
from music21 import converter

# ============================================================
# 1. KONFIGURASI PATH & NETWORK
# ============================================================
AUDIVERIS_PATH = r"C:\Program Files\Audiveris\Audiveris.exe"
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PDF_FOLDER = os.path.join(PROJECT_ROOT, "scores", "pdf")
MXL_FOLDER = os.path.join(PROJECT_ROOT, "scores", "mxl")

MQTT_BROKER = os.environ.get("MQTT_BROKER", "localhost")
MQTT_TOPIC = "robot/nada"

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

def play_concert(mxl_path):
    print(f"🎹 [STEP 3] Memulai Konser: {os.path.basename(mxl_path)}")
    client = mqtt.Client()
    try:
        client.connect(MQTT_BROKER, 1883, 60)
    except:
        print("❌ Gagal konek Broker MQTT!")
        return

    score = converter.parse(mxl_path)
    notes = score.parts[0].flatten().notes

    print("\n🚀 --- STATUS PUKULAN ROBOT ---")
    last_offset = 0.0
    for n in notes:
        # Anti-Chord: Ambil nada tertinggi
        note_obj = n.sortAscending()[-1] if n.isChord else n
        
        step = note_obj.pitch.step
        oct_asli = note_obj.pitch.octave
        
        # --- LOGIKA "PAKSA" JULIAN (HARD CLAMPING) ---
        if step == 'C':
            # Threshold kita naikkan ke 6. 
            # Jadi kalau Audiveris baca C4 atau C5, TETAP masuk ke DO rendah.
            if oct_asli >= 6:
                cmd = 'DO_TINGGI'
                f_pitch = "C5"
            else:
                cmd = 'DO'
                f_pitch = "C4"
        else:
            # Selain C, paksa semua ke Oktaf 4
            cmd = BASE_MAP.get(step)
            f_pitch = f"{step}4"

        # Timing Control
        wait_time = (n.offset - last_offset) * 0.9
        if wait_time > 0: time.sleep(wait_time)

        if cmd:
            client.publish(MQTT_TOPIC, cmd)
            print(f"🔨 [HIT] {step}{oct_asli} -> FORCED to: {f_pitch} -> {cmd}")
        
        last_offset = n.offset

    print("-" * 40)
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
                play_concert(mxl)