/* Gas sensor core: CSV parsing, segmentation, calibration, features, Random Forest model.
 * Mirrors analysis/features.py and analysis/rf.py exactly (checked by analysis/check_js_parity.py).
 * Works in the browser (window.GasCore) and in Node (module.exports).
 */
(function (root) {
  "use strict";
  const SENSORS = ["Sensor1", "Sensor2", "Sensor3", "Sensor4"];
  const GAP_SECONDS = 2, MIN_ROWS = 100, HALF_WIN = 5;
  const GRID = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0];
  const N_TREES = 100, RF_SEED = 7;
  const CONFIGS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  const pad3 = (g) => String(Math.round(g * 100)).padStart(3, "0");
  const SHAPE = [];
  SENSORS.forEach((c) => {
    GRID.forEach((g) => SHAPE.push(`${c}_r${pad3(g)}`));
    ["rmax", "rmin", "tpeak", "tailslope"].forEach((k) => SHAPE.push(`${c}_${k}`));
  });
  const RATIOS = ["ratio_S2_S3", "ratio_S1_S4", "ratio_S2_S4", "ratio_S1_S3"];
  const LEVELS = SENSORS.map((c) => `${c}_level`);
  const ENV = ["temp_mean", "hum_mean", "temp_delta", "hum_delta"];
  const FEATS = SHAPE.concat(RATIOS, LEVELS, ENV);

  const mean = (a, s = 0, e = a.length) => { let t = 0; for (let i = s; i < e; i++) t += a[i]; return t / (e - s); };

  function parseCSV(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
    const header = lines[0].split(",").map((h) => h.trim());
    const cols = {};
    header.forEach((h) => (cols[h] = []));
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(",");
      if (p.length < header.length) continue;
      header.forEach((h, j) => cols[h].push(parseFloat(p[j])));
    }
    const need = SENSORS.concat(["Temperature", "Humidity", "Hour", "Minute", "second"]);
    const miss = need.filter((h) => !(h in cols));
    if (miss.length) throw new Error("Missing columns: " + miss.join(", "));
    cols.t = cols.Hour.map((h, i) => h * 3600 + cols.Minute[i] * 60 + cols.second[i]);
    cols.n = cols.t.length;
    return cols;
  }

  const hms = (d, i) => [d.Hour[i], d.Minute[i], d.second[i]].map((v) => String(v).padStart(2, "0")).join(":");

  function segment(d) {
    const t = d.t, br = [0];
    for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - t[i - 1]) > GAP_SECONDS) br.push(i);
    br.push(t.length);
    const segs = [];
    let prevEnd = null;
    for (let k = 0; k < br.length - 1; k++) {
      const a = br[k], b = br[k + 1];
      if (b - a < MIN_ROWS) continue;
      const s = {};
      SENSORS.concat(["Temperature", "Humidity", "t"]).forEach((c) => (s[c] = d[c].slice(a, b)));
      s.n = b - a;
      const gap = prevEnd === null ? null : t[a] - prevEnd;
      prevEnd = t[b - 1];
      segs.push({ data: s, start_row: a, end_row: b - 1, gap, start: hms(d, a), end: hms(d, b - 1) });
    }
    return segs;
  }

  function winMean(y, c) { const a = Math.max(0, c - HALF_WIN), b = Math.min(y.length, c + HALF_WIN + 1); return mean(y, a, b); }

  function segmentFeatures(s) {
    const f = {}, n = s.n;
    SENSORS.forEach((c) => {
      const y = s[c], y0 = mean(y, 0, 3), r = y.map((v) => (v - y0) / y0);
      GRID.forEach((g) => { const idx = Math.min(n - 1, Math.round(g * (n - 1))); f[`${c}_r${pad3(g)}`] = winMean(r, idx); });
      let mx = -Infinity, mn = Infinity, amx = 0;
      for (let i = 0; i < n; i++) { if (r[i] > mx) { mx = r[i]; amx = i; } if (r[i] < mn) mn = r[i]; }
      f[`${c}_rmax`] = mx; f[`${c}_rmin`] = mn;
      if (c !== "Sensor4") f[`${c}_tpeak`] = amx / (n - 1);
      else { let m4 = Infinity, a4 = 0; const q = Math.floor(n / 4); for (let i = 0; i < q; i++) if (r[i] < m4) { m4 = r[i]; a4 = i; } f[`${c}_tpeak`] = a4 / (n - 1); }
      const st = Math.floor(0.6 * n), m = n - st;
      const xs = Array.from({ length: m }, (_, i) => (m === 1 ? 0 : i / (m - 1)));
      const xm = mean(xs), ym = mean(r, st, n);
      let sxy = 0, sxx = 0;
      for (let i = 0; i < m; i++) { sxy += (xs[i] - xm) * (r[st + i] - ym); sxx += (xs[i] - xm) ** 2; }
      f[`${c}_tailslope`] = sxy / sxx;
      f[`${c}_level`] = mean(y, n - 30, n);
    });
    f.ratio_S2_S3 = f.Sensor2_level / f.Sensor3_level;
    f.ratio_S1_S4 = f.Sensor1_level / f.Sensor4_level;
    f.ratio_S2_S4 = f.Sensor2_level / f.Sensor4_level;
    f.ratio_S1_S3 = f.Sensor1_level / f.Sensor3_level;
    const T = s.Temperature, H = s.Humidity;
    f.temp_mean = mean(T); f.hum_mean = mean(H);
    f.temp_delta = mean(T, n - 30, n) - mean(T, 0, 3);
    f.hum_delta = mean(H, n - 30, n) - mean(H, 0, 3);
    return f;
  }

  /** recordings: [{file, phase, rosin_pct, f:{...}}] -> data recordings with (data - mean air of same file) features */
  function airReference(recs) {
    const byFile = {};
    recs.forEach((r) => (byFile[r.file] = byFile[r.file] || []).push(r));
    const out = [];
    Object.keys(byFile).forEach((fn) => {
      const g = byFile[fn], air = g.filter((r) => r.phase === "A");
      if (!air.length) return;
      const ref = {};
      FEATS.forEach((k) => (ref[k] = mean(air.map((r) => r.f[k]))));
      g.filter((r) => r.phase === "D").forEach((r) => {
        const f = {}; FEATS.forEach((k) => (f[k] = r.f[k] - ref[k]));
        out.push(Object.assign({}, r, { f, calibrated: true }));
      });
    });
    return out;
  }

  const toX = (recs) => recs.map((r) => FEATS.map((k) => r.f[k]));

  /** Mulberry32 seeded RNG (identical to analysis/rf.py) */
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function gini(counts, n) { let g = 1.0; for (const c of counts) { const q = c / n; g -= q * q; } return g; }

  /** Deterministic Random Forest (CART, Gini, bootstrap, sqrt(d) features per split). Same algorithm as analysis/rf.py. */
  class RandomForest {
    constructor(nTrees = N_TREES, seed = RF_SEED) { this.nTrees = nTrees; this.seed = seed; }
    fit(X, y) {
      this.classes = Array.from(new Set(y)).sort((a, b) => (typeof a === "number" ? a - b : String(a).localeCompare(String(b))));
      const Y = y.map((v) => this.classes.indexOf(v)), n = X.length, d = X[0].length;
      this.d = d; this.mtry = Math.max(1, Math.floor(Math.sqrt(d)));
      this.importance = Array(d).fill(0);
      const r = rng(this.seed);
      this.trees = [];
      for (let t = 0; t < this.nTrees; t++) {
        const idx = []; for (let i = 0; i < n; i++) idx.push(Math.floor(r() * n));
        this.trees.push(this._build(X, Y, idx, r, idx.length));
      }
      const tot = this.importance.reduce((p, q) => p + q, 0) || 1;
      this.importance = this.importance.map((v) => v / tot);
      return this;
    }
    _leaf(Y, idx) { const c = Array(this.classes.length).fill(0); idx.forEach((i) => c[Y[i]]++); return { p: c.map((v) => v / idx.length) }; }
    _build(X, Y, idx, r, nRoot) {
      const k = this.classes.length, n = idx.length, counts = Array(k).fill(0);
      idx.forEach((i) => counts[Y[i]]++);
      if (n < 2 || Math.max(...counts) === n) return this._leaf(Y, idx);
      const feats = Array.from({ length: this.d }, (_, i) => i);
      for (let i = 0; i < this.mtry; i++) { const j = i + Math.floor(r() * (this.d - i)); [feats[i], feats[j]] = [feats[j], feats[i]]; }
      const parent = gini(counts, n);
      let best = null;
      for (const f of feats.slice(0, this.mtry)) {
        const order = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
        const left = Array(k).fill(0);
        for (let p = 0; p < n - 1; p++) {
          left[Y[order[p]]]++;
          const a = X[order[p]][f], b = X[order[p + 1]][f];
          if (!(a < b)) continue;
          const nl = p + 1, nr = n - nl, right = counts.map((c, ci) => c - left[ci]);
          const score = (nl * gini(left, nl) + nr * gini(right, nr)) / n;
          if (best === null || score < best[0]) best = [score, f, (a + b) / 2];
        }
      }
      if (best === null) return this._leaf(Y, idx);
      const [score, f, thr] = best;
      this.importance[f] += (n / nRoot) * (parent - score);
      const L = idx.filter((i) => X[i][f] <= thr), R = idx.filter((i) => X[i][f] > thr);
      return { f, t: thr, l: this._build(X, Y, L, r, nRoot), r: this._build(X, Y, R, r, nRoot) };
    }
    predictProba(X) {
      return X.map((x) => {
        const out = Array(this.classes.length).fill(0);
        for (const t of this.trees) { let node = t; while (!node.p) node = x[node.f] <= node.t ? node.l : node.r; node.p.forEach((v, i) => (out[i] += v)); }
        return out.map((v) => v / this.trees.length);
      });
    }
    predict(X) { return this.predictProba(X).map((p) => this.classes[p.indexOf(Math.max(...p))]); }
  }

  /** stratified split -> {train, test} index arrays */
  function stratifiedSplit(y, testSize, seed) {
    const r = rng(seed), groups = {};
    y.forEach((v, i) => (groups[v] = groups[v] || []).push(i));
    const train = [], test = [];
    Object.values(groups).forEach((ix) => {
      for (let i = ix.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ix[i], ix[j]] = [ix[j], ix[i]]; }
      const nt = ix.length > 1 ? Math.max(1, Math.round(ix.length * testSize)) : 0;
      test.push(...ix.slice(0, nt)); train.push(...ix.slice(nt));
    });
    return { train, test };
  }

  const api = { SENSORS, FEATS, SHAPE, RATIOS, LEVELS, ENV, CONFIGS, parseCSV, segment, segmentFeatures, airReference, toX, RandomForest, stratifiedSplit, rng, mean };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GasCore = api;
})(typeof window !== "undefined" ? window : globalThis);
