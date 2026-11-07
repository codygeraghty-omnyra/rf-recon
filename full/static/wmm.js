"use strict";
/* RF Recon — magnetic declination from NOAA's World Magnetic Model 2025 (WMM2025, valid 2025.0 to 2030.0; NOAA NCEI
   and the British Geological Survey; a US government work, public domain). A phone's compass points to magnetic
   north; a bearing on the map needs true north: true = magnetic + declination (east positive). Up to about 15 degrees
   across the US, about 80 m sideways at 300 m, so Find a signal corrects every compass bearing with it.
   Coefficients: WMM.COF from NOAA's wmm2025_Linux.zip (epoch 2025.0, released 11/13/2024). Checked against NOAA's
   published test values (tests/wmm_check.mjs). */
(() => {
const EPOCH = 2025.0, NMAX = 12, A = 6371.2;  // geomagnetic reference radius, km
const COF = [
  [1,0,-29351.8,0.0,12.0,0.0],
  [1,1,-1410.8,4545.4,9.7,-21.5],
  [2,0,-2556.6,0.0,-11.6,0.0],
  [2,1,2951.1,-3133.6,-5.2,-27.7],
  [2,2,1649.3,-815.1,-8.0,-12.1],
  [3,0,1361.0,0.0,-1.3,0.0],
  [3,1,-2404.1,-56.6,-4.2,4.0],
  [3,2,1243.8,237.5,0.4,-0.3],
  [3,3,453.6,-549.5,-15.6,-4.1],
  [4,0,895.0,0.0,-1.6,0.0],
  [4,1,799.5,278.6,-2.4,-1.1],
  [4,2,55.7,-133.9,-6.0,4.1],
  [4,3,-281.1,212.0,5.6,1.6],
  [4,4,12.1,-375.6,-7.0,-4.4],
  [5,0,-233.2,0.0,0.6,0.0],
  [5,1,368.9,45.4,1.4,-0.5],
  [5,2,187.2,220.2,0.0,2.2],
  [5,3,-138.7,-122.9,0.6,0.4],
  [5,4,-142.0,43.0,2.2,1.7],
  [5,5,20.9,106.1,0.9,1.9],
  [6,0,64.4,0.0,-0.2,0.0],
  [6,1,63.8,-18.4,-0.4,0.3],
  [6,2,76.9,16.8,0.9,-1.6],
  [6,3,-115.7,48.8,1.2,-0.4],
  [6,4,-40.9,-59.8,-0.9,0.9],
  [6,5,14.9,10.9,0.3,0.7],
  [6,6,-60.7,72.7,0.9,0.9],
  [7,0,79.5,0.0,-0.0,0.0],
  [7,1,-77.0,-48.9,-0.1,0.6],
  [7,2,-8.8,-14.4,-0.1,0.5],
  [7,3,59.3,-1.0,0.5,-0.8],
  [7,4,15.8,23.4,-0.1,0.0],
  [7,5,2.5,-7.4,-0.8,-1.0],
  [7,6,-11.1,-25.1,-0.8,0.6],
  [7,7,14.2,-2.3,0.8,-0.2],
  [8,0,23.2,0.0,-0.1,0.0],
  [8,1,10.8,7.1,0.2,-0.2],
  [8,2,-17.5,-12.6,0.0,0.5],
  [8,3,2.0,11.4,0.5,-0.4],
  [8,4,-21.7,-9.7,-0.1,0.4],
  [8,5,16.9,12.7,0.3,-0.5],
  [8,6,15.0,0.7,0.2,-0.6],
  [8,7,-16.8,-5.2,-0.0,0.3],
  [8,8,0.9,3.9,0.2,0.2],
  [9,0,4.6,0.0,-0.0,0.0],
  [9,1,7.8,-24.8,-0.1,-0.3],
  [9,2,3.0,12.2,0.1,0.3],
  [9,3,-0.2,8.3,0.3,-0.3],
  [9,4,-2.5,-3.3,-0.3,0.3],
  [9,5,-13.1,-5.2,0.0,0.2],
  [9,6,2.4,7.2,0.3,-0.1],
  [9,7,8.6,-0.6,-0.1,-0.2],
  [9,8,-8.7,0.8,0.1,0.4],
  [9,9,-12.9,10.0,-0.1,0.1],
  [10,0,-1.3,0.0,0.1,0.0],
  [10,1,-6.4,3.3,0.0,0.0],
  [10,2,0.2,0.0,0.1,-0.0],
  [10,3,2.0,2.4,0.1,-0.2],
  [10,4,-1.0,5.3,-0.0,0.1],
  [10,5,-0.6,-9.1,-0.3,-0.1],
  [10,6,-0.9,0.4,0.0,0.1],
  [10,7,1.5,-4.2,-0.1,0.0],
  [10,8,0.9,-3.8,-0.1,-0.1],
  [10,9,-2.7,0.9,-0.0,0.2],
  [10,10,-3.9,-9.1,-0.0,-0.0],
  [11,0,2.9,0.0,0.0,0.0],
  [11,1,-1.5,0.0,-0.0,-0.0],
  [11,2,-2.5,2.9,0.0,0.1],
  [11,3,2.4,-0.6,0.0,-0.0],
  [11,4,-0.6,0.2,0.0,0.1],
  [11,5,-0.1,0.5,-0.1,-0.0],
  [11,6,-0.6,-0.3,0.0,-0.0],
  [11,7,-0.1,-1.2,-0.0,0.1],
  [11,8,1.1,-1.7,-0.1,-0.0],
  [11,9,-1.0,-2.9,-0.1,0.0],
  [11,10,-0.2,-1.8,-0.1,0.0],
  [11,11,2.6,-2.3,-0.1,0.0],
  [12,0,-2.0,0.0,0.0,0.0],
  [12,1,-0.2,-1.3,0.0,-0.0],
  [12,2,0.3,0.7,-0.0,0.0],
  [12,3,1.2,1.0,-0.0,-0.1],
  [12,4,-1.3,-1.4,-0.0,0.1],
  [12,5,0.6,-0.0,-0.0,-0.0],
  [12,6,0.6,0.6,0.1,-0.0],
  [12,7,0.5,-0.1,-0.0,-0.0],
  [12,8,-0.1,0.8,0.0,0.0],
  [12,9,-0.4,0.1,0.0,-0.0],
  [12,10,-0.2,-1.0,-0.1,-0.0],
  [12,11,-1.3,0.1,-0.0,0.0],
  [12,12,-0.7,0.2,-0.1,-0.1]
];
const G = [], H = [], GD = [], HD = [];
for (let n = 0; n <= NMAX; n++) { G.push(new Array(n + 1).fill(0)); H.push(new Array(n + 1).fill(0)); GD.push(new Array(n + 1).fill(0)); HD.push(new Array(n + 1).fill(0)); }
for (const [n, m, g, h, gd, hd] of COF) { G[n][m] = g; H[n][m] = h; GD[n][m] = gd; HD[n][m] = hd; }
const fact = k => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
const S = [];  // Schmidt semi-normalization
for (let n = 0; n <= NMAX; n++) { S.push([]); for (let m = 0; m <= n; m++) S[n].push(m === 0 ? 1 : Math.sqrt(2 * fact(n - m) / fact(n + m))); }

// geodetic latitude, longitude (deg), height above the WGS84 ellipsoid (km), decimal year -> X, Y, Z (nT), D, I (deg)
function field(lat, lon, hKm = 0, year = decimalYear()) {
  const d2r = Math.PI / 180, a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const phi = lat * d2r, lam = lon * d2r, sp = Math.sin(phi), cp = Math.cos(phi);
  const Rc = a / Math.sqrt(1 - e2 * sp * sp), p = (Rc + hKm) * cp, z = (Rc * (1 - e2) + hKm) * sp;
  const r = Math.hypot(p, z), phic = Math.asin(z / r);
  const x = Math.sin(phic), cpc = Math.cos(phic), dt = year - EPOCH;
  // unnormalized associated Legendre P[n][m](x), no Condon-Shortley phase
  const P = [];
  for (let n = 0; n <= NMAX; n++) P.push(new Array(n + 2).fill(0));
  for (let m = 0; m <= NMAX; m++) {
    let pmm = 1; for (let i = 1; i <= m; i++) pmm *= (2 * i - 1) * cpc;
    P[m][m] = pmm;
    if (m + 1 <= NMAX) P[m + 1][m] = x * (2 * m + 1) * pmm;
    for (let n = m + 2; n <= NMAX; n++) P[n][m] = ((2 * n - 1) * x * P[n - 1][m] - (n + m - 1) * P[n - 2][m]) / (n - m);
  }
  let Xp = 0, Yp = 0, Zp = 0;
  for (let n = 1; n <= NMAX; n++) {
    const ar = Math.pow(A / r, n + 2);
    for (let m = 0; m <= n; m++) {
      const g = G[n][m] + GD[n][m] * dt, h = H[n][m] + HD[n][m] * dt, cm = Math.cos(m * lam), sm = Math.sin(m * lam);
      const Pn = S[n][m] * P[n][m], Pn1 = m <= n - 1 ? S[n][m] * P[n - 1][m] : 0;
      const dP = -(n * x * Pn - (n + m) * Pn1) / cpc;  // dP/dphi' from (x^2-1) dP/dx = n x P_n - (n+m) P_(n-1)
      Xp += -ar * (g * cm + h * sm) * dP;
      Yp += ar * m * (g * sm - h * cm) * Pn / cpc;
      Zp += -(n + 1) * ar * (g * cm + h * sm) * Pn;
    }
  }
  const psi = phic - phi;  // back to the ellipsoid's frame
  const X = Xp * Math.cos(psi) - Zp * Math.sin(psi), Y = Yp, Z = Xp * Math.sin(psi) + Zp * Math.cos(psi);
  const Hh = Math.hypot(X, Y);
  return { X, Y, Z, H: Hh, F: Math.hypot(Hh, Z), D: Math.atan2(Y, X) / d2r, I: Math.atan2(Z, Hh) / d2r };
}
function decimalYear(t = new Date()) {
  const y = t.getUTCFullYear(), s = Date.UTC(y, 0, 1), e = Date.UTC(y + 1, 0, 1);
  return y + (t.getTime() - s) / (e - s);
}
// true = magnetic + declination; null when the model can't say (outside 2025-2030, or at a pole)
function declination(lat, lon, t = new Date()) {
  const yr = decimalYear(t);
  if (!(yr >= 2025 && yr < 2030.0001) || Math.abs(lat) > 89.9) return null;
  return field(lat, lon, 0, yr).D;
}
const api = { field, declination, decimalYear, EPOCH };
if (typeof window !== "undefined") window.WMM = api;
if (typeof module !== "undefined") module.exports = api;
})();
