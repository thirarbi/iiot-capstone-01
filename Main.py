import os
import glob
import subprocess
import time
import paho.mqtt.client as mqtt
from music21 import converter, interval

# ============================================================
# 1. KONFIGURASI PATH & NETWORK
# ============================================================
AUDIVERIS_PATH = r"C:\Program Files\Audiveris\Audiveris.exe"
BASE_DIR = r"C:\Users\user\Documents\praktikum-iot"
PDF_FOLDER = os.path.join(BASE_DIR, "PDF BARU")
MXL_FOLDER = os.path.join(BASE_DIR, "MXL")

MQTT_BROKER = "10.6.100.80" 
MQTT_TOPIC = "robot/nada"

# --- SETTING TRANSPOSE MANUAL JULIAN ---
# Ubah angka ini untuk geser nada (Contoh: -12 turun 1 oktaf, 12 naik 1 oktaf, 0 asli)
TRANSPOSE_AMOUNT = 0 

# Target Mapping Dasar (Abaikan oktaf asli PDF)
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
    print(f"🔄 [STEP 1] Mengonversi PDF: {os.path.basename(pdf_path)}...")
    command = [AUDIVERIS_PATH, "-batch", "-transcribe", "-export", "-output", MXL_FOLDER, pdf_path]
    try:
        subprocess.run(command, check=True)
        print("✅ Konversi Audiveris Selesai!")
        return True
    except Exception as e:
        print(f"❌ Gagal menjalankan Audiveris: {e}")
        return False

def play_concert(mxl_path):
    print(f"🎹 [STEP 3] Memulai Konser: {os.path.basename(mxl_path)}")
    client = mqtt.Client()
    try:
        client.connect(MQTT_BROKER, 1883, 60)
    except Exception as e:
        print(f"❌ Gagal konek ke Broker ({MQTT_BROKER}): {e}")
        return

    # Parsing XML
    score = converter.parse(mxl_path)
    
    # --- PROSES TRANSPOSE MANUAL ---
    if TRANSPOSE_AMOUNT != 0:
        print(f"🎼 Mentranspose lagu sebesar {TRANSPOSE_AMOUNT} semitone...")
        score = score.transpose(TRANSPOSE_AMOUNT)

    notes = score.parts[0].flatten().notes

    print("🚀 --- STATUS PENGIRIMAN NADA ---")
    last_offset = 0.0
    for n in notes:
        # Filter Chord (ambil nada tertinggi)
        note_obj = n.sortAscending()[-1] if n.isChord else n
        
        step = note_obj.pitch.step
        octave = note_obj.pitch.octave
        
        # LOGIKA NORMALISASI (X ke Y): 
        # Memaksa semua nada masuk ke range 8 keys Julian
        if step == 'C' and octave >= 5:
            cmd = 'DO_TINGGI'
        else:
            cmd = BASE_MAP.get(step)

        # Timing Control
        wait_time = (n.offset - last_offset) * 0.9
        if wait_time > 0: time.sleep(wait_time)

        if cmd:
            client.publish(MQTT_TOPIC, cmd)
            print(f"🚀 [SENT] {step}{octave} -> {cmd}")
        else:
            print(f"⚠️ [SKIP] {step}{octave} tidak terpetakan.")
        
        last_offset = n.offset

    print("🏁 Konser Selesai!")
    client.disconnect()

# ============================================================
# 3. ALUR UTAMA
# ============================================================
if __name__ == "__main__":
    pdf_terbaru = get_latest_file(PDF_FOLDER, "pdf")
    if pdf_terbaru:
        if process_pdf_to_mxl(pdf_terbaru):
            time.sleep(2)
            mxl_terbaru = get_latest_file(MXL_FOLDER, "mxl")
            if mxl_terbaru:
                play_concert(mxl_terbaru)