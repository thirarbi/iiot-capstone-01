import subprocess
import os
import glob
from music21 import converter

# ==========================================
# KONFIGURASI PATH & FOLDER
# ==========================================
# Path executable Audiveris
AUDIVERIS_PATH = r"C:\Program Files\Audiveris\Audiveris.exe"

# Folder direktori absolut
PDF_FOLDER = "C:/Users/user/Documents/praktikum-iot/PDF BARU"
MXL_FOLDER = "C:/Users/user/Documents/praktikum-iot/MXL"

# ==========================================
# FUNGSI 1: CARI PDF TERBARU
# ==========================================
def get_latest_pdf(folder_path):
    search_pattern = os.path.join(folder_path, '*.pdf')
    list_of_pdfs = glob.glob(search_pattern)
    
    if not list_of_pdfs:
        print(f"[WARNING] Tidak ada file PDF ditemukan di folder:\n{folder_path}")
        return None
        
    latest_pdf = max(list_of_pdfs, key=os.path.getmtime)
    return latest_pdf

# ==========================================
# FUNGSI 2: JALANKAN AUDIVERIS
# ==========================================
def process_pdf_with_audiveris(pdf_path):
    print(f"[INFO] Memproses PDF terbaru: {os.path.basename(pdf_path)}")
    
    if not os.path.exists(MXL_FOLDER):
        os.makedirs(MXL_FOLDER)

    command = [
        AUDIVERIS_PATH,
        "-batch",
        "-export",
        "-output", MXL_FOLDER,
        pdf_path
    ]

    try:
        print("[INFO] Audiveris sedang berjalan, mohon tunggu...")
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        print("[INFO] Audiveris selesai!")
        
        base_name = os.path.splitext(os.path.basename(pdf_path))[0]
        
        # Cari file .mxl langsung di dalam MXL_FOLDER
        mxl_file_path = os.path.join(MXL_FOLDER, f"{base_name}.mxl")
        
        if os.path.exists(mxl_file_path):
            print(f"[INFO] File berhasil ditemukan di: {mxl_file_path}")
            return mxl_file_path
        else:
            print(f"[ERROR] File MXL tidak ditemukan di {mxl_file_path}.")
            return None

    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Audiveris gagal.\nLog:\n{e.stderr.decode('utf-8')}")
        return None
# ==========================================
# FUNGSI 3: PARSING MELODI ATAS (ANTI-TUMPUK & FILTER NOISE)
# ==========================================
def parse_and_print_notes(mxl_file_path):
    print(f"[INFO] Mulai membaca file XML: {os.path.basename(mxl_file_path)}")
    score = converter.parse(mxl_file_path)

    print(f"\n[HASIL PARSING - V3 FINAL (ANTI-NOISE)]")
    print("-" * 60)
    
    if len(score.parts) > 0:
        melody_part = score.parts[0]
        print("[INFO] Mengekstrak baris atas (Tangan Kanan) saja...")
    else:
        melody_part = score 

    notes_by_offset = {}
    
    for element in melody_part.flatten().notes:
        offset_rounded = round(float(element.offset), 1)
        
        if element.isNote:
            current_note = element
        elif element.isChord:
            current_note = element.sortAscending()[-1]
        else:
            continue
            
        if offset_rounded in notes_by_offset:
            existing_note = notes_by_offset[offset_rounded]
            if current_note.pitch > existing_note.pitch:
                notes_by_offset[offset_rounded] = current_note
        else:
            notes_by_offset[offset_rounded] = current_note

    note_count = 0
    
    for offset in sorted(notes_by_offset.keys()):
        note = notes_by_offset[offset]
        
        step = note.pitch.step 
        original_octave = note.pitch.octave
        duration = note.duration.quarterLength
        
        # LOGIKA BARU: FILTER NOISE DURASI
        # Buang nada "debu" atau artifak OMR yang durasinya di bawah 0.5 ketuk
        if duration < 0.5:
            continue
            
        note_count += 1
        
        final_octave = 4 
        if step == 'C' and original_octave >= 5:
            final_octave = 5
        elif step == 'D' and original_octave >= 5:
            final_octave = 5
            
        final_note = f"{step}{final_octave}"
        print(f"Asli: {note.pitch.nameWithOctave: <4} -> \tDigeser ke: {final_note} \t| Durasi: {duration} ketuk")

    print("-" * 60)
    print(f"[INFO] Total nada melodi yang siap dikirim: {note_count} nada")

# ==========================================
# BLOK EKSEKUSI UTAMA
# ==========================================
if __name__ == "__main__":
    if not os.path.exists(PDF_FOLDER):
        os.makedirs(PDF_FOLDER)
        print(f"[INFO] Folder '{PDF_FOLDER}' berhasil dibuat.")
        print("[INFO] Silakan masukkan file PDF ke folder tersebut, lalu jalankan ulang script ini.")
    else:
        latest_pdf_file = get_latest_pdf(PDF_FOLDER)
        
        if latest_pdf_file:
            hasil_mxl = process_pdf_with_audiveris(latest_pdf_file)
            
            if hasil_mxl:
                # PERBAIKAN: Hanya 1 argumen, fungsi yang baru tidak butuh parameter transpose
                parse_and_print_notes(hasil_mxl)