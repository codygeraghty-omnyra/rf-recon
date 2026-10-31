"""
Signal identification: band plan, signal library and classification of
captured / crowdsourced signals into types (P25, DMR, NXDN, TETRA, Wi-Fi,
Bluetooth, LTE, 5G NR, GSM, paging, ADS-B, AIS, ...).

Identification is evidence-based and says how it decided:
  1. the capture itself declares the type (WiGLE "Type" column, Kismet, etc.)
  2. an FCC-licensed emission at that frequency near the point (ULS match)
  3. measured bandwidth (when the capture has it)
  4. the band plan (what normally lives at that frequency)
"""
from urllib.parse import quote

SIGID_SEARCH = "https://www.sigidwiki.com/index.php?search="

# name -> (family, typical bandwidth text, sigidwiki search term, map color)
LIBRARY = {
    "P25 Phase 1":       ("Land mobile digital", "12.5 kHz (C4FM)", "Project 25", "#1f6feb"),
    "P25 Phase 2":       ("Land mobile digital", "12.5 kHz, 2-slot TDMA", "P25 Phase 2", "#0a3069"),
    "DMR":               ("Land mobile digital", "12.5 kHz, 2-slot TDMA", "DMR", "#8250df"),
    "NXDN":              ("Land mobile digital", "6.25 / 12.5 kHz", "NXDN", "#bf3989"),
    "dPMR":              ("Land mobile digital", "6.25 kHz", "dPMR", "#bf3989"),
    "TETRA":             ("Land mobile digital", "25 kHz, 4-slot TDMA", "TETRA", "#953800"),
    "Analog FM":         ("Land mobile analog", "12.5 / 25 kHz", "Narrowband FM", "#57606a"),
    "LTE":               ("Cellular", "1.4-20 MHz OFDMA", "LTE", "#cf222e"),
    "5G NR":             ("Cellular", "5-100 MHz OFDM", "5G NR", "#a40e26"),
    "GSM":               ("Cellular", "200 kHz TDMA", "GSM", "#fa4549"),
    "WCDMA/UMTS":        ("Cellular", "5 MHz", "UMTS", "#ff8182"),
    "CDMA":              ("Cellular", "1.25 MHz", "CDMA", "#ffaba8"),
    "Cellular (unknown tech)": ("Cellular", "varies", "LTE", "#cf222e"),
    "Wi-Fi":             ("WLAN", "20-160 MHz OFDM", "WiFi", "#0b6e4f"),
    "Bluetooth":         ("PAN", "1 MHz FHSS", "Bluetooth", "#1b7c83"),
    "Bluetooth LE":      ("PAN", "2 MHz GFSK", "Bluetooth Low Energy", "#3fb983"),
    "ISM 902-928 (LoRa/FHSS/meters)": ("ISM", "varies", "LoRa", "#bf8700"),
    "Paging (POCSAG/FLEX)": ("Paging", "12.5-25 kHz FSK", "FLEX", "#9a6700"),
    "ADS-B / Mode S":    ("Aviation", "1090 MHz PPM", "ADS-B", "#0969da"),
    "UAT":               ("Aviation", "978 MHz", "UAT", "#0969da"),
    "Aviation voice (AM)": ("Aviation", "8.33 / 25 kHz AM", "Airband", "#54aeff"),
    "AIS":               ("Marine", "25 kHz GMSK", "AIS", "#1b7c83"),
    "Marine VHF":        ("Marine", "25 kHz FM", "Marine VHF", "#1b7c83"),
    "NOAA Weather Radio": ("Broadcast", "25 kHz FM", "NOAA Weather Radio", "#6e7781"),
    "FM broadcast":      ("Broadcast", "200 kHz FM + subcarriers", "FM Broadcast", "#6e7781"),
    "AM broadcast":      ("Broadcast", "10 kHz AM (+ HD Radio)", "AM Broadcast", "#953800"),
    "VOR / ILS":         ("Aviation", "VOR 108-118 MHz, ILS glide slope 329-335 MHz", "VOR", "#0550ae"),
    "NDB":               ("Aviation", "190-535 kHz AM beacon", "NDB", "#7d4e00"),
    "Military air (UHF AM)": ("Aviation", "25 kHz AM, 225-400 MHz", "Military Aviation", "#424a53"),
    "ATSC TV":           ("Broadcast", "6 MHz 8VSB / OFDM", "ATSC", "#6e7781"),
    "GPS / GNSS":        ("Navigation", "2-20 MHz", "GPS", "#6e7781"),
    "Radar":             ("Radar", "pulsed", "Radar", "#6e7781"),
    "Microwave link":    ("Fixed", "varies", "Microwave", "#6e7781"),
    "Amateur":           ("Amateur", "varies", "Amateur", "#6e7781"),
    "GMRS/FRS":          ("Personal", "12.5-20 kHz FM", "GMRS", "#6e7781"),
    "Unknown":           ("Unknown", "", "", "#8c959f"),
}


def sigid_url(sig_type):
    term = LIBRARY.get(sig_type, LIBRARY["Unknown"])[2] or sig_type
    return SIGID_SEARCH + quote(term)


def color_for(sig_type):
    return LIBRARY.get(sig_type, LIBRARY["Unknown"])[3]


# US band plan, coarse (MHz). First match wins, so narrow entries come first.
# (lo, hi, label, likely signal types)
BAND_PLAN = [
    (162.400, 162.5501, "NOAA Weather Radio", ["NOAA Weather Radio"]),
    (161.9625, 162.0375, "AIS", ["AIS"]),
    (156.0, 162.0375, "Marine VHF", ["Marine VHF", "Analog FM"]),
    (1089.0, 1091.0, "ADS-B 1090", ["ADS-B / Mode S"]),
    (977.0, 979.0, "UAT 978", ["UAT"]),
    (1574.0, 1577.0, "GPS L1", ["GPS / GNSS"]),
    (1226.0, 1229.0, "GPS L2", ["GPS / GNSS"]),
    (1175.0, 1178.0, "GPS L5", ["GPS / GNSS"]),
    (462.5, 467.75, "GMRS/FRS", ["GMRS/FRS", "Analog FM"]),
    (929.0, 932.0, "Paging 929-932", ["Paging (POCSAG/FLEX)"]),
    (152.0, 152.25, "VHF paging", ["Paging (POCSAG/FLEX)", "Analog FM"]),
    (87.5, 108.0, "FM broadcast", ["FM broadcast"]),
    (108.0, 137.0, "Aviation VHF", ["Aviation voice (AM)"]),
    (144.0, 148.0, "2 m amateur", ["Amateur", "Analog FM", "DMR"]),
    (222.0, 225.0, "1.25 m amateur", ["Amateur"]),
    (420.0, 450.0, "70 cm amateur", ["Amateur", "Analog FM", "DMR"]),
    (902.0, 928.0, "ISM 900", ["ISM 902-928 (LoRa/FHSS/meters)", "Amateur"]),
    (2400.0, 2483.5, "ISM 2.4 GHz", ["Wi-Fi", "Bluetooth", "Bluetooth LE"]),
    (5150.0, 5895.0, "U-NII 5 GHz", ["Wi-Fi"]),
    (5925.0, 7125.0, "6 GHz", ["Wi-Fi", "Microwave link"]),
    (2700.0, 3100.0, "S-band radar", ["Radar"]),
    (617.0, 652.0, "600 MHz (B71 DL)", ["LTE", "5G NR"]),
    (663.0, 698.0, "600 MHz (B71 UL)", ["LTE", "5G NR"]),
    (698.0, 758.0, "700 MHz lower/upper C", ["LTE"]),
    (758.0, 768.0, "700 MHz FirstNet B14", ["LTE"]),
    (768.0, 776.0, "700 MHz public safety narrowband", ["P25 Phase 1", "P25 Phase 2", "Analog FM"]),
    (776.0, 788.0, "700 MHz B13/B14 UL", ["LTE"]),
    (788.0, 806.0, "700 MHz public safety narrowband", ["P25 Phase 1", "P25 Phase 2", "Analog FM"]),
    (806.0, 824.0, "800 MHz land mobile (mobile tx)", ["P25 Phase 1", "P25 Phase 2", "Analog FM", "TETRA"]),
    (824.0, 849.0, "850 cellular UL", ["LTE", "5G NR", "WCDMA/UMTS", "GSM"]),
    (851.0, 869.0, "800 MHz land mobile (base tx)", ["P25 Phase 1", "P25 Phase 2", "Analog FM", "DMR", "TETRA"]),
    (869.0, 894.0, "850 cellular DL", ["LTE", "5G NR", "WCDMA/UMTS", "GSM"]),
    (896.0, 901.0, "900 MHz land mobile", ["DMR", "NXDN", "Analog FM"]),
    (935.0, 940.0, "900 MHz land mobile", ["DMR", "NXDN", "Analog FM"]),
    (1710.0, 1780.0, "AWS UL", ["LTE", "5G NR"]),
    (1850.0, 1915.0, "PCS UL", ["LTE", "5G NR", "GSM"]),
    (1930.0, 1995.0, "PCS DL", ["LTE", "5G NR", "GSM"]),
    (2110.0, 2200.0, "AWS DL", ["LTE", "5G NR"]),
    (2305.0, 2360.0, "WCS", ["LTE"]),
    (2496.0, 2690.0, "2.5 GHz (B41/n41)", ["LTE", "5G NR"]),
    (3450.0, 3550.0, "3.45 GHz", ["5G NR"]),
    (3550.0, 3700.0, "CBRS", ["LTE", "5G NR"]),
    (3700.0, 3980.0, "C-band", ["5G NR"]),
    (24250.0, 47000.0, "mmWave", ["5G NR", "Microwave link"]),
    (470.0, 512.0, "UHF T-band / TV", ["P25 Phase 1", "DMR", "Analog FM", "ATSC TV"]),
    (512.0, 608.0, "UHF TV", ["ATSC TV"]),
    (54.0, 88.0, "VHF TV / low-band", ["ATSC TV", "Analog FM"]),
    (174.0, 216.0, "VHF TV", ["ATSC TV"]),
    (450.0, 470.0, "UHF land mobile", ["Analog FM", "DMR", "P25 Phase 1", "NXDN", "TETRA"]),
    (380.0, 400.0, "Federal UHF (380-400)", ["P25 Phase 1", "TETRA"]),
    (136.0, 174.0, "VHF high land mobile", ["Analog FM", "P25 Phase 1", "DMR", "NXDN"]),
    (25.0, 54.0, "VHF low", ["Analog FM"]),
    (220.0, 222.0, "220 MHz land mobile", ["Analog FM"]),
    (6000.0, 100000.0, "Microwave", ["Microwave link"]),
]


def band_info(mhz):
    if mhz is None:
        return None, []
    for lo, hi, label, types in BAND_PLAN:
        if lo <= mhz < hi:
            return label, types
    return None, []


# Who allows transmitting in a band when no site license matches (US, 47 CFR and NTIA). First match wins,
# so narrow allocations sit above the wide ones they fall inside. Used to find signals nothing explains.
AUTHORITY = [
    (162.400, 162.5501, "NOAA Weather Radio", "NOAA's own transmitters"),
    (161.9625, 162.0375, "Maritime (by rule)", "AIS"),
    (156.0, 162.0375, "Maritime (by rule)", "Marine VHF: ship stations are licensed by rule"),
    (462.5375, 462.7375, "Personal radio (Part 95)", "FRS / GMRS"),
    (467.5375, 467.7375, "Personal radio (Part 95)", "FRS / GMRS"),
    (151.815, 151.945, "Personal radio (Part 95)", "MURS"),
    (154.565, 154.605, "Personal radio (Part 95)", "MURS"),
    (26.96, 27.41, "Personal radio (Part 95)", "CB"),
    (433.05, 434.79, "Unlicensed (Part 15)", "433 MHz devices (key fobs, sensors)"),
    (314.5, 315.5, "Unlicensed (Part 15)", "315 MHz devices (tyre-pressure sensors, key fobs)"),
    (902.0, 928.0, "Unlicensed (Part 15)", "ISM 902-928 (meters, LoRa, FHSS)"),
    (2400.0, 2483.5, "Unlicensed (Part 15)", "ISM 2.4 GHz (Wi-Fi, Bluetooth, drones)"),
    (5150.0, 5895.0, "Unlicensed (Part 15)", "U-NII 5 GHz (Wi-Fi, drone video)"),
    (5925.0, 7125.0, "Unlicensed (Part 15)", "6 GHz Wi-Fi"),
    (24000.0, 24250.0, "Unlicensed (Part 15)", "24 GHz ISM"),
    (57000.0, 71000.0, "Unlicensed (Part 15)", "60 GHz"),
    (1.8, 2.0, "Amateur (individual licence)", "160 m"), (3.5, 4.0, "Amateur (individual licence)", "80 m"),
    (7.0, 7.3, "Amateur (individual licence)", "40 m"), (14.0, 14.35, "Amateur (individual licence)", "20 m"),
    (21.0, 21.45, "Amateur (individual licence)", "15 m"), (28.0, 29.7, "Amateur (individual licence)", "10 m"),
    (50.0, 54.0, "Amateur (individual licence)", "6 m"), (144.0, 148.0, "Amateur (individual licence)", "2 m"),
    (222.0, 225.0, "Amateur (individual licence)", "1.25 m"), (420.0, 450.0, "Amateur (individual licence)", "70 cm"),
    (1240.0, 1300.0, "Amateur (individual licence)", "23 cm"),
    (0.53, 1.71, "Broadcast (licensed; AM)", "AM broadcast"),
    (87.5, 108.0, "Broadcast (licensed; FM)", "FM broadcast"),
    (54.0, 88.0, "Broadcast (licensed; TV)", "VHF TV"), (174.0, 216.0, "Broadcast (licensed; TV)", "VHF TV"),
    (470.0, 608.0, "Broadcast (licensed; TV)", "UHF TV (also T-band land mobile in 11 metros)"),
    (108.0, 137.0, "Aviation (FAA / by rule)", "VOR / ILS / airband voice"),
    (960.0, 1215.0, "Aviation (FAA / by rule)", "DME / transponders / ADS-B / UAT"),
    (1574.0, 1577.0, "Satellite (GNSS)", "GPS L1"), (1226.0, 1229.0, "Satellite (GNSS)", "GPS L2"),
    (1175.0, 1178.0, "Satellite (GNSS)", "GPS L5"),
    (617.0, 698.0, "Cellular (market licence)", "600 MHz"), (698.0, 768.0, "Cellular (market licence)", "700 MHz"),
    (776.0, 788.0, "Cellular (market licence)", "700 MHz"), (824.0, 849.0, "Cellular (market licence)", "850 MHz"),
    (869.0, 894.0, "Cellular (market licence)", "850 MHz"), (1710.0, 1780.0, "Cellular (market licence)", "AWS"),
    (1850.0, 1995.0, "Cellular (market licence)", "PCS"), (2110.0, 2200.0, "Cellular (market licence)", "AWS"),
    (2305.0, 2360.0, "Cellular (market licence)", "WCS"), (2496.0, 2690.0, "Cellular (market licence)", "2.5 GHz"),
    (3450.0, 3980.0, "Cellular (market licence)", "3.45 GHz / CBRS / C-band"),
    (162.0375, 174.0, "Federal (NTIA; not in FCC data)", "Federal VHF land mobile"),
    (225.0, 400.0, "Federal (NTIA; not in FCC data)", "Military aeronautical / federal UHF"),
    (406.1, 420.0, "Federal (NTIA; not in FCC data)", "Federal UHF land mobile"),
]
CELL_TYPES = {"LTE", "5G NR", "GSM", "WCDMA/UMTS", "CDMA"}
PART15_TYPES = {"Wi-Fi", "Bluetooth", "Bluetooth LE"}


def authority(mhz, sig_type=None):
    """(category, note) for a signal no site licence explains, or (None, None) when nothing allows it."""
    if sig_type in PART15_TYPES:
        return "Unlicensed (Part 15)", sig_type
    if sig_type in CELL_TYPES:
        return "Cellular (market licence)", sig_type
    if mhz is None:
        return None, None
    for lo, hi, cat, note in AUTHORITY:
        if lo <= mhz < hi:
            return cat, note
    return None, None


# Capture-declared types -> library names
DECLARED = {
    "WIFI": "Wi-Fi", "WI-FI": "Wi-Fi", "WLAN": "Wi-Fi", "BT": "Bluetooth", "BLE": "Bluetooth LE",
    "LTE": "LTE", "NR": "5G NR", "5G": "5G NR", "GSM": "GSM", "WCDMA": "WCDMA/UMTS", "UMTS": "WCDMA/UMTS",
    "CDMA": "CDMA", "NBIOT": "LTE", "P25": "P25 Phase 1", "P25P1": "P25 Phase 1", "P25P2": "P25 Phase 2",
    "DMR": "DMR", "NXDN": "NXDN", "DPMR": "dPMR", "TETRA": "TETRA", "FM": "Analog FM", "NFM": "Analog FM",
    "ANALOG": "Analog FM", "ADSB": "ADS-B / Mode S", "ADS-B": "ADS-B / Mode S", "AIS": "AIS",
    "POCSAG": "Paging (POCSAG/FLEX)", "FLEX": "Paging (POCSAG/FLEX)", "LORA": "ISM 902-928 (LoRa/FHSS/meters)",
}


def from_uls_mode(mode):
    """Map RF Recon's ULS-derived mode label to a library name."""
    m = (mode or "")
    if "P25 Phase 1" in m:
        return "P25 Phase 1"  # Phase 2 systems also license Phase 1 (control channel); details note both
    if "P25 Phase 2" in m:
        return "P25 Phase 2"
    if "P25" in m:
        return "P25 Phase 1"
    if "DMR" in m:
        return "DMR"
    if "NXDN" in m:
        return "NXDN"
    if "TETRA" in m:
        return "TETRA"
    if "Analog" in m:
        return "Analog FM"
    if m.startswith("AM"):
        return "Aviation voice (AM)"
    return None


def from_bandwidth(bw_khz, mhz):
    if not bw_khz:
        return None
    if 5.5 <= bw_khz <= 6.5:
        return "NXDN"
    if 7.0 <= bw_khz <= 8.6:
        return "P25 Phase 1"
    if 9.5 <= bw_khz <= 10.0:
        return "P25 Phase 2"
    if 10.5 <= bw_khz <= 16.5:
        return "Analog FM"
    if 20.0 <= bw_khz <= 27.0 and mhz and 380 <= mhz <= 870:
        return "TETRA"
    if 150 <= bw_khz <= 250 and mhz and 800 <= mhz <= 2000:
        return "GSM"
    if 1300 <= bw_khz <= 20500 and mhz and mhz > 600:
        return "LTE"
    return None


def classify(declared=None, freq_mhz=None, bw_khz=None, uls_match=None):
    """Return dict(sig_type, confidence, basis, band, candidates)."""
    band, cands = band_info(freq_mhz)
    if declared:
        key = str(declared).strip().upper().replace(" ", "")
        if key in DECLARED:
            return {"sig_type": DECLARED[key], "confidence": "high", "basis": "declared by capture",
                    "band": band, "candidates": cands}
    if uls_match:
        t = from_uls_mode(uls_match.get("mode"))
        if t:
            return {"sig_type": t, "confidence": "medium",
                    "basis": f"FCC license {uls_match.get('call_sign')} ({uls_match.get('licensee')}) "
                             f"{uls_match.get('dist_mi', '?')} mi away",
                    "band": band, "candidates": cands}
    t = from_bandwidth(bw_khz, freq_mhz)
    if t and (not cands or t in cands or t in ("LTE", "GSM")):
        return {"sig_type": t, "confidence": "medium", "basis": f"measured bandwidth {bw_khz:g} kHz",
                "band": band, "candidates": cands}
    if len(cands) == 1:
        return {"sig_type": cands[0], "confidence": "medium", "basis": f"band plan: {band}",
                "band": band, "candidates": cands}
    if cands:
        return {"sig_type": cands[0], "confidence": "low",
                "basis": f"band plan: {band} (could be {', '.join(cands)})", "band": band, "candidates": cands}
    return {"sig_type": "Unknown", "confidence": "none", "basis": "no match", "band": band, "candidates": []}


# ---- WiGLE / cellular helpers --------------------------------------------

def wifi_channel_to_mhz(ch, freq=None):
    try:
        if freq and float(freq) > 1000:
            return float(freq)
        ch = int(ch)
    except (TypeError, ValueError):
        return None
    if 1 <= ch <= 13:
        return 2407 + 5 * ch
    if ch == 14:
        return 2484
    if 32 <= ch <= 177:
        return 5000 + 5 * ch
    return None


def earfcn_to_dl_mhz(n):
    """LTE EARFCN -> downlink MHz for common US bands (approximate band table)."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    table = [  # (band, f_dl_low, n_offs_dl, n_low, n_high)
        (2, 1930.0, 600, 600, 1199), (4, 2110.0, 1950, 1950, 2399), (5, 869.0, 2400, 2400, 2649),
        (7, 2620.0, 2750, 2750, 3449), (12, 729.0, 5010, 5010, 5179), (13, 746.0, 5180, 5180, 5279),
        (14, 758.0, 5280, 5280, 5379), (17, 734.0, 5730, 5730, 5849), (25, 1930.0, 8040, 8040, 8689),
        (26, 859.0, 8690, 8690, 9039), (29, 717.0, 9660, 9660, 9769), (30, 2350.0, 9770, 9770, 9869),
        (41, 2496.0, 39650, 39650, 41589), (48, 3550.0, 55240, 55240, 56739), (66, 2110.0, 66436, 66436, 67335),
        (71, 617.0, 68586, 68586, 68935),
    ]
    for band, f, offs, lo, hi in table:
        if lo <= n <= hi:
            return round(f + 0.1 * (n - offs), 3)
    return None


def nrarfcn_to_mhz(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    if 0 <= n < 600000:
        return round(0.005 * n, 3)
    if 600000 <= n < 2016667:
        return round(3000 + 0.015 * (n - 600000), 3)
    if 2016667 <= n <= 3279165:
        return round(24250.08 + 0.06 * (n - 2016667), 3)
    return None
