"use strict";
/* RF Recon: what any signal's frequency says, for every kind of signal, not only cellular (Cody 11/6: "Show all that metadata for every
   signal you can find"). Shown in each signal's Details: the US band it sits in, its channel number under each published plan that covers
   it, the frequency it pairs with where the band plan fixes one, what only a scan adds for that kind of signal, and every field on file.
   Worked out from the frequency and the published plans, never measured: a channel number says where the plan puts this frequency.
   Plans: 47 CFR 73.201 (FM), 73.603 (TV), 95.1763 (FRS / GMRS), 95.2763 (MURS), NOAA Weather Radio, 3GPP TS 36.101 / 38.104, IEEE 802.11
   (2.4 / 5 / 6 GHz), Bluetooth Core (LE channels), and the GNSS signal specs. */
(() => {
  const near = (a, b, tol = 0.0006) => Math.abs(a - b) <= tol;
  const whole = x => Math.abs(x - Math.round(x)) < 0.01;  // on the plan's grid, allowing for how a decimal frequency is stored
  // broad US allocations, most specific first where they overlap
  const BANDS = [
    [0.53, 1.71, "Medium wave (AM broadcast band, also travelers' information stations)"], [1.8, 30, "HF"], [30, 50, "VHF low band (land mobile)"], [50, 54, "6 m amateur"], [54, 88, "TV VHF low (channels 2 to 6)"],
    [88, 108, "FM broadcast"], [108, 118, "Aviation navigation (VOR, ILS localizer)"], [118, 137, "Aviation voice (airband)"], [137, 138, "Weather satellites"],
    [144, 148, "2 m amateur"], [156, 162.025, "Marine VHF"], [162.4, 162.55, "NOAA Weather Radio"], [148, 174, "VHF high band (land mobile)"],
    [174, 216, "TV VHF high (channels 7 to 13)"], [220, 222, "220 MHz land mobile"], [222, 225, "1.25 m amateur"], [225, 400, "Military aviation UHF"], [406, 406.1, "Distress beacons (EPIRB, PLB, ELT)"], [420, 450, "70 cm amateur"],
    [462.55, 462.725, "FRS / GMRS"], [467.55, 467.725, "FRS / GMRS"], [450, 470, "UHF land mobile"], [470, 512, "T-band land mobile / TV UHF"], [470, 608, "TV UHF (channels 14 to 36)"],
    [617, 652, "600 MHz cellular, downlink"], [663, 698, "600 MHz cellular, uplink"], [698, 758, "700 MHz cellular"], [758, 768, "700 MHz public safety broadband (FirstNet), downlink"],
    [769, 775, "700 MHz public safety narrowband, base"], [788, 798, "700 MHz public safety broadband (FirstNet), uplink"], [799, 805, "700 MHz public safety narrowband, mobile"],
    [806, 824, "800 MHz land mobile, mobile"], [824, 849, "Cellular 850, uplink"], [851, 869, "800 MHz land mobile, base"], [869, 894, "Cellular 850, downlink"],
    [896, 901, "900 MHz land mobile"], [929, 932, "Paging (929 to 932 MHz)"], [902, 928, "900 MHz ISM (LoRa, RFID, meters)"], [935, 940, "900 MHz land mobile"], [960, 1215, "Aeronautical radionavigation (DME, transponders, ADS-B)"],
    [1164, 1300, "GNSS (L2, L5, E5, E6)"], [1215, 1390, "L-band long-range radar"], [1395, 1400, "Medical telemetry (WMTS)"], [1427, 1432, "Medical and utility telemetry (WMTS)"], [1559, 1610, "GNSS (L1, E1, B1, GLONASS)"], [1610, 1626.5, "Mobile satellite (satellite phones)"],
    [1695, 1780, "AWS cellular, uplink"], [1850, 1915, "PCS cellular, uplink"], [1930, 1995, "PCS cellular, downlink"], [2110, 2200, "AWS cellular, downlink"],
    [2305, 2360, "WCS"], [2400, 2483.5, "2.4 GHz ISM (Wi-Fi, Bluetooth)"], [2496, 2690, "2.5 GHz (BRS / EBS, 5G n41)"], [2700, 3000, "S-band radar (airport surveillance, NEXRAD)"], [2900, 3100, "S-band marine radar"], [4200, 4400, "Radar altimeters"], [4940, 4990, "4.9 GHz public safety"],
    [3550, 3700, "CBRS"], [3700, 3980, "C-band 5G"], [3980, 4140, "Upper C-band (in 47 CFR 27.5(m) since FCC 26-46, July 2026; not yet licensed)"], [5600, 5650, "Terminal Doppler weather radar"], [5150, 5925, "5 GHz Wi-Fi (U-NII)"], [5925, 7125, "6 GHz Wi-Fi / microwave"],
    [9300, 9500, "X-band radar (marine, weather)"], [10700, 11700, "11 GHz fixed microwave / Ku-band satellite downlink (shared)"], [11700, 12700, "Ku-band satellite downlink"], [12700, 13250, "Microwave (cable relay, fixed)"], [14000, 14500, "Ku-band satellite uplink"], [15700, 17300, "Radiolocation (radar)"], [17700, 19700, "Microwave fixed (18 GHz)"], [21200, 23600, "Microwave fixed (23 GHz)"], [24250, 40000, "Millimetre wave 5G / microwave"]];
  const bandsAt = f => BANDS.filter(([lo, hi]) => f >= lo && f <= hi).map(b => b[2]);

  const TV = n => n <= 4 ? 54 + 6 * (n - 2) : n <= 6 ? 76 + 6 * (n - 5) : n <= 13 ? 174 + 6 * (n - 7) : 470 + 6 * (n - 14);
  const WX = {162.55: "WX1", 162.4: "WX2", 162.475: "WX3", 162.425: "WX4", 162.45: "WX5", 162.5: "WX6", 162.525: "WX7"};
  const MURS = [151.82, 151.88, 151.94, 154.57, 154.6];
  const FRS = n => n <= 7 ? 462.5625 + 0.025 * (n - 1) : n <= 14 ? 467.5625 + 0.025 * (n - 8) : 462.55 + 0.025 * (n - 15);
  const SPOT = [[1575.42, "GPS L1 / Galileo E1 / BeiDou B1C"], [1227.6, "GPS L2"], [1176.45, "GPS L5 / Galileo E5a"], [1207.14, "Galileo E5b"], [1278.75, "Galileo E6"],
    [1090, "Mode S / ADS-B replies (1090ES)"], [1030, "Transponder interrogations"], [978, "UAT (ADS-B in the US)"], [161.975, "AIS 1 (channel 87B)"], [162.025, "AIS 2 (channel 88B)"],
    [121.5, "Aviation emergency"], [243, "Military aviation emergency"], [406.025, "COSPAS-SARSAT distress beacons"], [156.8, "Marine channel 16 (distress, calling)"]];
  // LTE: band, DL low, N_offs DL, UL low, N_offs UL, DL high, UL high (as cellspec.py)
  const LTE = [["B2", 1930, 600, 1850, 18600, 1990, 1910], ["B4", 2110, 1950, 1710, 19950, 2155, 1755], ["B5", 869, 2400, 824, 20400, 894, 849], ["B12", 729, 5010, 699, 23010, 746, 716],
    ["B13", 746, 5180, 777, 23180, 756, 787], ["B14", 758, 5280, 788, 23280, 768, 798], ["B25", 1930, 8040, 1850, 26040, 1995, 1915], ["B26", 859, 8690, 814, 26690, 894, 849],
    ["B30", 2350, 9770, 2305, 27660, 2360, 2315], ["B41", 2496, 39650, null, null, 2690, null], ["B48", 3550, 55240, null, null, 3700, null],
    ["B66", 2110, 66436, 1710, 131972, 2200, 1780], ["B71", 617, 68586, 663, 133122, 652, 698]];
  const nrArfcn = f => f < 3000 ? Math.round(f / 0.005) : f < 24250 ? 600000 + Math.round((f - 3000) / 0.015) : 2016667 + Math.round((f - 24250) / 0.06);

  function channels(f) {
    const out = [];
    if (f >= 87.9 && f <= 107.9 && whole((f - 87.9) / 0.2)) out.push(["FM broadcast", `channel ${200 + Math.round((f - 87.9) / 0.2)}`]);
    for (let n = 2; n <= 36; n++) { const lo = TV(n); if (f >= lo && f < lo + 6) out.push(["TV", `RF channel ${n} (${lo} to ${lo + 6} MHz)`]); }
    for (const [k, v] of Object.entries(WX)) if (near(f, +k)) out.push(["NOAA Weather Radio", v]);
    MURS.forEach((m, i) => near(f, m) && out.push(["MURS", `channel ${i + 1}`]));
    for (let n = 1; n <= 22; n++) if (near(f, FRS(n))) out.push(["FRS / GMRS", `channel ${n}`]);
    if (f >= 467.55 && f <= 467.725 && whole((f - 467.55) / 0.025)) out.push(["GMRS", "repeater input"]);
    for (const [g, l] of SPOT) if (near(f, g, 0.02)) out.push(["Named signal", l]);
    if (f >= 2412 && f <= 2472 && whole((f - 2407) / 5)) out.push(["Wi-Fi 2.4 GHz", `channel ${Math.round((f - 2407) / 5)}`]);
    if (near(f, 2484)) out.push(["Wi-Fi 2.4 GHz", "channel 14 (not used in the US)"]);
    if (f >= 5160 && f <= 5885 && whole((f - 5000) / 5)) out.push(["Wi-Fi 5 GHz", `channel ${Math.round((f - 5000) / 5)}`]);
    if (f >= 5955 && f <= 7115 && whole((f - 5950) / 5)) out.push(["Wi-Fi 6 GHz", `channel ${Math.round((f - 5950) / 5)}`]);
    if (f >= 2402 && f <= 2480 && whole((f - 2402) / 2)) { const k = Math.round((f - 2402) / 2), adv = {0: 37, 12: 38, 39: 39}[k];
      out.push(["Bluetooth LE", adv != null ? `advertising channel ${adv}` : `data channel ${k <= 11 ? k - 1 : k - 2}`]); }
    for (const [b, dl, nd, ul, nu, dh, uh] of LTE) {
      if (f >= dl && f <= dh) out.push(["LTE", `${b} downlink, EARFCN ${nd + Math.round(10 * (f - dl))}`]);
      if (ul != null && f >= ul && f <= uh) out.push(["LTE", `${b} uplink, EARFCN ${nu + Math.round(10 * (f - ul))}`]);
    }
    if (f >= 410 && f <= 52600 && bandsAt(f).some(b => /cellular|5G|CBRS|BRS|WCS/.test(b))) out.push(["5G NR", `NR-ARFCN ${nrArfcn(f)}`]);
    return out;
  }
  // the frequency this one pairs with, where the band plan fixes the split
  function pair(f) {
    if (f >= 851 && f <= 869) return [f - 45, "its mobile / repeater input, 45 MHz below (800 MHz plan)"];
    if (f >= 806 && f <= 824) return [f + 45, "its base / repeater output, 45 MHz above (800 MHz plan)"];
    if (f >= 769 && f <= 775) return [f + 30, "its mobile / repeater input, 30 MHz above (700 MHz plan)"];
    if (f >= 799 && f <= 805) return [f - 30, "its base / repeater output, 30 MHz below (700 MHz plan)"];
    if (f >= 869 && f <= 894) return [f - 45, "its uplink, 45 MHz below (cellular 850)"];
    if (f >= 824 && f <= 849) return [f + 45, "its downlink, 45 MHz above (cellular 850)"];
    if (f >= 462.55 && f <= 462.725) return [f + 5, "its GMRS repeater input, 5 MHz above"];
    if (f >= 160.625 && f <= 162.0 && !near(f, 161.975)) return [f - 4.6, "the ship side of a duplex marine channel, 4.6 MHz below"];
    if (f >= 450 && f < 465) return [f + 5, "the usual repeater input, 5 MHz above (common practice, not fixed: check the licence's other frequencies)"];
    if (f >= 470 && f < 509) return [f + 3, "the usual repeater input, 3 MHz above (common practice in T-band)"];
    return null;
  }
  // what only receiving it brings, by kind of signal. Nothing that identifies a person
  const ADDS = [
    [/P25/i, "NAC, WACN, system ID, RFSS and site, control channel, talkgroups heard, encryption in use, Phase 1 or 2"],
    [/DMR|TDMA/i, "colour code, timeslots in use, talkgroups heard, Tier II or III, encryption in use"],
    [/NXDN|dPMR/i, "RAN, talkgroups heard, encryption in use"],
    [/Analog|FM 12|FM 25/i, "CTCSS tone or DCS code, deviation, carrier squelch or tone"],
    [/LTE|NR|5G|GSM|UMTS|CDMA|cell/i, "each sector's channel, bandwidth, PCI or PSC, broadcast settings (tracking area, neighbours, paging and access settings), RSRP, RSRQ, SINR, timing"],
    [/Wi-?Fi|802\.11|WIFI/i, "network name, access point address, channel width, standard (n, ac, ax), security"],
    [/Bluetooth|BLE|\bBT\b/i, "beacon IDs (iBeacon, Eddystone) and advertised services"],
    [/broadcast|FM\b|AM\b/i, "RDS station code and name, programme type, HD Radio"],
    [/TV|ATSC/i, "TSID, virtual channel and guide (PSIP), ATSC 1.0 or 3.0"],
    [/AIS|marine/i, "for AIS: each vessel's MMSI, name, position and course as it broadcasts them"],
    [/ADS-B|Mode S|1090|transponder|aviation/i, "for ADS-B: each aircraft's address, flight ID, position and altitude as it broadcasts them"],
    [/GNSS|GPS|Galileo/i, "satellites heard, signal to noise (C/N0), signs of jamming or spoofing"],
    [/radar/i, "pulse repetition, pulse width, rotation period, scan pattern"],
    [/microwave|point-to-point|MW/i, "carrier, modulation and level; the path itself is on the licence"]];
  function adds(r) {
    const s = [r.sig_type, r.mode, r.kind, r.service_name, r.layer, ...bandsAt(+r.freq_mhz || 0)].filter(Boolean).join(" ");
    const hit = ADDS.filter(([re]) => re.test(s)).map(a => a[1]);
    return hit.length ? hit : ["level, bandwidth and modulation as received"];
  }
  const SKIP = new Set(["fid", "details", "extra", "_cell", "_site", "obs_status", "obs_level", "obs_notes"]);
  function allFields(r) {
    const rows = Object.entries(r).filter(([k, v]) => !SKIP.has(k) && !k.startsWith("ov_") && v !== null && v !== "" && typeof v !== "object");
    return rows.length ? `<details class="sec"><summary><b>Every field on file</b> <span class="hint">· ${rows.length}</span></summary>${kvg(rows.map(([k, v]) => [esc(k), `<span class="mono">${esc(String(v))}</span>`]))}</details>` : "";
  }

  window.sigMeta = r => {
    const f = +r.freq_mhz;
    const head = f > 0 ? (() => {
      const ch = channels(f), p = pair(f), bands = bandsAt(f);
      return `<div class="sec" id="sigMeta"><h3>Band and channel</h3>${kvg([
        ["Band", esc(bands.join(" · ") || "Not in RF Recon's band list")],
        ["Wavelength", `${num(299.792458 / f, f > 1000 ? 3 : 2)} m`],
        ...ch.map(([plan, v]) => [esc(plan), `<span class="mono">${esc(v)}</span>`]),
        ...(p ? [["Pairs with", `<span class="mono">${fmtF(p[0])} MHz</span>: ${esc(p[1])}`]] : [])])}
        <p class="hint">Worked out from the frequency and the published plans, not measured.</p></div>`; })() : "";
    return `${head}<div class="sec"><h3>What a scan adds</h3><p>${esc(adds(r).join("; "))}.</p>
      <p class="hint">Not collected: anything that identifies a person, or the contents of a call or message.</p></div>${allFields(r)}`;
  };
  window.sigMetaParts = { channels, pair, bandsAt, adds };  // the sweep checks these
})();
