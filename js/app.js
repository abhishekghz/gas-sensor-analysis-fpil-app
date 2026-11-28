/* Gas Sensor Analysis — simple app: Predict (upload raw CSV → top matches) and Visualize (salak → rosin). */
(function () {
  "use strict";
  const C = window.GasCore;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v) => (v * 100).toFixed(0) + "%";
  const cfgName = (p) => `Rosin ${p}% – Salak ${100 - p}%`;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  const PCFG = { responsive: true, displaylogo: false };
  function layout(extra = {}) {
    const ink = css("--ink"), line = css("--line");
    return Object.assign({ paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: ink, size: 12 },
      margin: { l: 56, r: 12, t: 40, b: 48 }, showlegend: false,
      xaxis: { gridcolor: line, zerolinecolor: line }, yaxis: { gridcolor: line, zerolinecolor: line } }, extra);
  }

  const S = { labels: {}, files: {}, recs: [], model: null, mu: null, sd: null, fileMeans: [], dRef: 1 };

  // ------------------------------------------------------------- known data + model
  function dateOf(d, i) { return d.day ? `${String(d.day[i]).padStart(2, "0")}/${String(d.month[i]).padStart(2, "0")}` : "?"; }
  const zvec = (f) => C.FEATS.map((k, j) => (f[k] - S.mu[j]) / S.sd[j]);
  const dist = (a, b) => Math.sqrt(a.reduce((s, v, j) => s + (v - b[j]) ** 2, 0));

  async function loadKnown() {
    S.labels = (await (await fetch("data/labels.json", { cache: "no-cache" })).json()).files;
    await Promise.all(Object.entries(S.labels).map(async ([fn, lab]) => {
      const d = C.parseCSV(await (await fetch("data/" + encodeURIComponent(fn), { cache: "no-cache" })).text());
      const segs = C.segment(d);
      segs.forEach((s) => (s.f = C.segmentFeatures(s.data)));
      S.files[fn] = { d, segs, lab, date: dateOf(d, 0) };
      if (lab.phases && lab.phases.length === segs.length)
        segs.forEach((s, i) => { if (lab.phases[i] === "D") S.recs.push({ file: fn, rec: i + 1, rosin: lab.rosin_pct, date: S.files[fn].date, f: s.f, s }); });
    }));
    S.recs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.rec - b.rec));
    const X = C.toX(S.recs);
    S.model = new C.RandomForest().fit(X, S.recs.map((r) => r.rosin));
    S.mu = C.FEATS.map((_, j) => C.mean(X.map((x) => x[j])));
    S.sd = C.FEATS.map((_, j) => { const v = Math.sqrt(C.mean(X.map((x) => (x[j] - S.mu[j]) ** 2))); return v < 1e-12 ? 1 : v; });
    const byFile = {};
    S.recs.forEach((r) => (byFile[r.file] = byFile[r.file] || []).push(r));
    S.fileMeans = Object.entries(byFile).map(([file, rs]) => {
      const z = rs.map((r) => zvec(r.f));
      return { file, rosin: rs[0].rosin, date: rs[0].date, n: rs.length, z: C.FEATS.map((_, j) => C.mean(z.map((v) => v[j]))) };
    });
    const ds = [];
    S.fileMeans.forEach((a, i) => S.fileMeans.slice(i + 1).forEach((b) => ds.push(dist(a.z, b.z))));
    ds.sort((a, b) => a - b);
    S.dRef = ds[Math.floor(ds.length / 2)] || 1;
  }

  // ------------------------------------------------------------- predict
  function analyze(name, text) {
    const steps = [];
    const d = C.parseCSV(text);
    steps.push(`Read ${fmt(d.n + d.dropped)} rows${d.dropped ? `, removed ${d.dropped} broken or empty rows` : ", no broken rows"}`);
    const all = C.segment(d);
    if (!all.length) throw new Error("No 1-minute recording found (a recording needs at least 100 rows without a time jump).");
    steps.push(`Split into ${all.length} recording${all.length > 1 ? "s" : ""} wherever the clock jumps by more than 2 s`);
    const mode = $("#airMode").value;
    const phase = (i) => (mode === "none" ? "D" : mode === "DA" ? (i % 2 ? "A" : "D") : (i % 2 ? "D" : "A"));
    const segs = all.map((s, i) => ({ s, i, ph: phase(i) }));
    const D = segs.filter((o) => o.ph === "D");
    if (!D.length) throw new Error("No sample recordings left after removing air.");
    if (mode !== "none") steps.push(`Set aside ${segs.length - D.length} air recording${segs.length - D.length === 1 ? "" : "s"}, kept ${D.length} sample recording${D.length === 1 ? "" : "s"}`);
    D.forEach((o) => (o.f = C.segmentFeatures(o.s.data)));
    steps.push("Normalized each recording to its own starting value (removes slow drift between recordings)");
    steps.push(`Measured ${C.FEATS.length} numbers per recording: response shape of each sensor, sensor-to-sensor ratios, temperature, humidity`);
    steps.push(`Compared with ${S.recs.length} known recordings (${new Set(S.recs.map((r) => r.rosin)).size} mixtures) using a Random Forest of 100 trees`);

    const X = D.map((o) => C.FEATS.map((k) => o.f[k]));
    const P = S.model.predictProba(X);
    const cls = S.model.classes;
    const avg = cls.map((_, c) => C.mean(P.map((p) => p[c])));
    const ranking = cls.map((c, i) => ({ rosin: c, p: avg[i] })).sort((a, b) => b.p - a.p);
    const est = avg.reduce((s, p, i) => s + p * cls[i], 0);
    const zu = C.FEATS.map((_, j) => C.mean(D.map((o) => zvec(o.f)[j])));
    const files = S.fileMeans.map((m) => ({ ...m, sim: Math.exp(-dist(zu, m.z) / S.dRef) })).sort((a, b) => b.sim - a.sim);
    const per = D.map((o, k) => {
      const best = P[k].indexOf(Math.max(...P[k]));
      const zr = zvec(o.f);
      let near = null;
      S.recs.forEach((r) => { const dd = dist(zr, zvec(r.f)); if (!near || dd < near.d) near = { d: dd, r }; });
      return { rec: o.i + 1, start: o.s.start, rosin: cls[best], p: P[k][best], near: near.r };
    });
    return { name, steps, ranking, est, files, per, nRec: D.length, known: !!S.labels[name] };
  }

  function renderPrediction(r) {
    const N = +$("#topN").value;
    const top = r.ranking.slice(0, N), best = top[0];
    const missing = C.CONFIGS.filter((c) => !r.ranking.some((x) => x.rosin === c));
    $("#predOut").innerHTML = `
      <div class="card">
        <h2>Result for <span class="fname">${esc(r.name)}</span></h2>
        ${r.known ? '<p class="notice warn small">This file is one of the known recordings, so it will naturally match itself. Upload a new file for a real test.</p>' : ""}
        <div class="result">
          <div class="bestbox">
            <div class="muted small">Best match</div>
            <div class="big">${cfgName(best.rosin)}</div>
            <p class="kv">Likelihood <b>${pct(best.p)}</b> · estimated rosin ≈ <b>${r.est.toFixed(0)}%</b></p>
            <p class="kv small muted">From ${r.nRec} sample recording${r.nRec > 1 ? "s" : ""} in your file.</p>
          </div>
          <div>
            <h3>Top ${N} mixtures</h3>
            <ol class="toplist">${top.map((t, i) => `<li><span class="rank">${i + 1}</span><span class="tname">${cfgName(t.rosin)}</span>
              <span class="bar"><span style="width:${(t.p * 100).toFixed(1)}%"></span></span><span class="tval">${pct(t.p)}</span></li>`).join("")}</ol>
            ${missing.length ? `<p class="muted small">Not possible yet (no known recordings): ${missing.map((c) => c + "%").join(", ")} rosin.</p>` : ""}
          </div>
        </div>
      </div>
      <div class="card">
        <h2>Top ${N} closest known recordings</h2>
        <p class="muted small">How similar your file is to each recorded file (100% = identical after normalization).</p>
        <div class="tablewrap"><table class="tbl"><tr><th>#</th><th>Known file</th><th>Mixture</th><th>Recorded</th><th class="num">Similarity</th></tr>
        ${r.files.slice(0, N).map((f, i) => `<tr><td>${i + 1}</td><td class="small">${esc(f.file)}</td><td>${cfgName(f.rosin)}</td><td>${esc(f.date)}</td><td class="num"><b>${pct(f.sim)}</b></td></tr>`).join("")}</table></div>
      </div>
      <div class="card">
        <h2>What the page did with your raw file</h2>
        <ol class="steps">${r.steps.map((s) => `<li>✓ ${esc(s)}</li>`).join("")}</ol>
        <details><summary>Result per recording</summary>
          <div class="tablewrap"><table class="tbl"><tr><th>Recording</th><th>Start</th><th>Best match</th><th class="num">Likelihood</th><th>Closest known recording</th></tr>
          ${r.per.map((p) => `<tr><td>${p.rec}</td><td>${p.start}</td><td>${cfgName(p.rosin)}</td><td class="num">${pct(p.p)}</td><td class="small">${esc(p.near.file)} #${p.near.rec} (${p.near.rosin}%)</td></tr>`).join("")}</table></div>
        </details>
        <p class="muted small">How reliable: for recordings from days already seen, the right mixture is in the top 3 about 8 times out of 10 and is the best match about 5–6 times out of 10. On a brand-new day it is less reliable, so recording lab air in the same session helps.</p>
      </div>`;
  }

  let last = null;
  function runPredict(name, text) {
    try { last = analyze(name, text); renderPrediction(last); }
    catch (e) { $("#predOut").innerHTML = `<div class="card"><div class="notice warn">${esc(name)}: ${esc(e.message)}</div></div>`; }
  }

  // ------------------------------------------------------------- visualize
  function value(s, p, m) { const y = s.data[p]; return m === "level" ? C.mean(y) : C.mean(y, y.length - 30) - C.mean(y, 0, 3); }
  function fit(xs, ys) {
    const mx = C.mean(xs), my = C.mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
    const b = sxx ? sxy / sxx : 0, a = my - b * mx;
    return { a, b, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
  }
  const strength = (r2) => (r2 < 0.1 ? "no clear straight-line link" : r2 < 0.3 ? "weak link" : r2 < 0.6 ? "moderate link" : "strong link");
  function visRecs() { const d = $("#vDay").value; return S.recs.filter((r) => d === "all" || r.date === d); }

  function renderVisual() {
    const p = +$("#mix").value, m = $("#vMeasure").value, R = visRecs();
    $("#mixLabel").innerHTML = `<b>Rosin ${p}%</b> · Salak ${100 - p}%`;
    const xs = R.map((r) => r.rosin);
    const mixes = Array.from(new Set(xs)).sort((a, b) => a - b);
    const lines = [];
    C.SENSORS.forEach((sn, k) => {
      const ys = R.map((r) => value(r.s, sn, m)), F = fit(xs, ys), at = F.a + F.b * p;
      const means = mixes.map((c) => C.mean(ys.filter((_, i) => xs[i] === c)));
      const change100 = F.b * 100, base = Math.abs(F.a) > 1e-9 ? (change100 / Math.abs(F.a)) * 100 : null;
      lines.push({ sn, F, at, change100, base });
      Plotly.react(`lin${k + 1}`, [
        { x: xs, y: ys, mode: "markers", name: "one recording", marker: { size: 7, color: css("--air"), opacity: 0.5 }, hovertemplate: "rosin %{x}%<br>%{y:.0f}<extra></extra>" },
        { x: mixes, y: means, mode: "lines+markers", name: "average of each mixture", line: { color: css("--ink"), width: 2.5 }, marker: { size: 10, color: css("--ink"), symbol: "diamond" }, hovertemplate: "average at %{x}%: %{y:.0f}<extra></extra>" },
        { x: [0, 100], y: [F.a, F.a + F.b * 100], mode: "lines", name: "straight-line fit", line: { color: css("--accent"), width: 2, dash: "dash" }, hoverinfo: "skip" },
        { x: [p], y: [at], mode: "markers", name: "expected at slider", showlegend: false, marker: { size: 16, color: css("--accent"), symbol: "x-thin", line: { width: 3, color: css("--accent") } }, hovertemplate: `expected at ${p}%: %{y:.0f}<extra></extra>` },
      ], layout({
        title: { text: `${sn.replace("Sensor", "Sensor ")} — R² = ${F.r2.toFixed(2)} (${strength(F.r2)})`, font: { size: 13 } },
        xaxis: { title: "rosin %", range: [-5, 105], dtick: 10, gridcolor: css("--line") },
        yaxis: { title: m === "level" ? "average reading" : "change in reading", gridcolor: css("--line") },
        shapes: [{ type: "line", x0: p, x1: p, yref: "paper", y0: 0, y1: 1, line: { color: css("--accent"), width: 1, dash: "dot" } }],
        showlegend: true, legend: { orientation: "h", y: -0.28, font: { size: 11 } },
        margin: { l: 60, r: 10, t: 40, b: 70 },
      }), PCFG);
    });
    const best = lines.slice().sort((a, b) => b.F.r2 - a.F.r2)[0];
    const what = m === "level" ? "average reading" : "change during the minute";
    $("#vSummary").innerHTML = `<div class="headline">
        <div class="hl">At Rosin ${p}%, the straight lines expect: ${lines.map((l) => `${l.sn.replace("Sensor", "S")} ≈ <b>${fmt(l.at)}</b>`).join(" · ")}</div>
        <p class="kv">Going from pure salak to pure rosin, the ${what} of <b>${best.sn.replace("Sensor", "Sensor ")}</b> changes by <b>${best.change100 >= 0 ? "+" : ""}${fmt(best.change100)}</b>${best.base != null && m === "level" ? ` (${best.base >= 0 ? "+" : ""}${best.base.toFixed(1)}%)` : ""}.
        This is the clearest of the 4 sensors, and its straight line explains <b>${pct(best.F.r2)}</b> of the variation between recordings (${strength(best.F.r2)}).</p>
        <p class="muted small">${R.length} recordings · mixtures ${mixes.map((c) => c + "%").join(", ")}. R² goes from 0 (no straight-line link) to 1 (all dots on the line).</p></div>`;
    renderCurve(p, R, mixes);
    if (!renderVisual.sliderOnly) renderRelation();
  }

  function meanCurve(R, sn, G = 120) {
    const cs = R.map((r) => { const y = r.s.data[sn], n = y.length, y0 = C.mean(y, 0, 3); return Array.from({ length: G }, (_, g) => y[Math.min(n - 1, Math.round((g / (G - 1)) * (n - 1)))] - y0); });
    return Array.from({ length: G }, (_, g) => C.mean(cs.map((c) => c[g])));
  }
  function renderCurve(p, R, mixes) {
    const sn = $("#vSensor").value, G = 120, x = Array.from({ length: G }, (_, g) => (g / (G - 1)) * 60);
    let lo = mixes.filter((c) => c <= p).pop(), hi = mixes.find((c) => c >= p);
    if (lo == null) lo = hi; if (hi == null) hi = lo;
    const cLo = meanCurve(R.filter((r) => r.rosin === lo), sn), cHi = meanCurve(R.filter((r) => r.rosin === hi), sn);
    const w = hi === lo ? 0 : (p - lo) / (hi - lo);
    const blend = cLo.map((v, i) => v * (1 - w) + cHi[i] * w);
    const traces = [{ x, y: cLo, mode: "lines", line: { color: css("--muted"), width: 1, dash: "dot" }, name: `rosin ${lo}%` }];
    if (hi !== lo) traces.push({ x, y: cHi, mode: "lines", line: { color: css("--muted"), width: 1, dash: "dash" }, name: `rosin ${hi}%` });
    traces.push({ x, y: blend, mode: "lines", line: { color: css("--accent"), width: 3 }, name: `expected at ${p}%` });
    Plotly.react("curve", traces, layout({ showlegend: true, legend: { orientation: "h", y: -0.25 },
      title: { text: `${sn.replace("Sensor", "Sensor ")}: expected change from start at Rosin ${p}%${hi === lo ? "" : ` (blend of ${lo}% and ${hi}%)`}`, font: { size: 13 } },
      xaxis: { title: "seconds into the recording", gridcolor: css("--line") }, yaxis: { title: "change from start", gridcolor: css("--line") },
      margin: { l: 60, r: 12, t: 40, b: 80 } }), PCFG);
  }

  // ------------------------------------------------------------- sensor-to-sensor relationship
  const PNAME = { Sensor1: "Sensor 1", Sensor2: "Sensor 2", Sensor3: "Sensor 3", Sensor4: "Sensor 4", Temperature: "Temperature", Humidity: "Humidity" };
  const PUNIT = { Temperature: " °C", Humidity: " % RH" };
  const PARAMS6 = ["Sensor1", "Sensor2", "Sensor3", "Sensor4", "Temperature", "Humidity"];
  const avgOf = (r, p) => C.mean(r.s.data[p]);
  const num = (v, p) => (p === "Temperature" || p === "Humidity" ? v.toFixed(1) : fmt(v));
  function corr(a, b) { const F = fit(a, b); return Math.sign(F.b) * Math.sqrt(F.r2); }
  function renderRelation() {
    const R = visRecs(), px = $("#rX").value, py = $("#rY").value;
    const xs = R.map((r) => avgOf(r, px)), ys = R.map((r) => avgOf(r, py));
    if (px === py) { $("#relSummary").innerHTML = '<div class="notice">Pick two different measurements.</div>'; }
    else {
      const F = fit(xs, ys), lo = Math.min(...xs), hi = Math.max(...xs);
      const step = px === "Temperature" || px === "Humidity" ? 1 : hi - lo > 1000 ? 100 : 10;
      const dir = F.b >= 0 ? "up" : "down";
      $("#relSummary").innerHTML = `<div class="headline"><div class="hl">${PNAME[py]} ≈ ${Math.abs(F.b) >= 10 ? fmt(F.b) : F.b.toFixed(2)} × ${PNAME[px]} ${F.a >= 0 ? "+" : "−"} ${num(Math.abs(F.a), py)}</div>
        <p class="kv">When ${PNAME[px]} goes up by ${step}${PUNIT[px] || ""}, ${PNAME[py]} goes ${dir} by about <b>${num(Math.abs(F.b * step), py)}</b>${PUNIT[py] || ""}.
        The straight line explains <b>${pct(F.r2)}</b> of the variation (${strength(F.r2).replace(" straight-line", "")}).</p>
        <p class="muted small">${R.length} recordings. R² from 0 (no straight-line link) to 1 (all dots on the line).</p></div>`;
      Plotly.react("relScatter", [
        { x: xs, y: ys, mode: "markers", marker: { size: 7, color: css("--air"), opacity: 0.6 }, text: R.map((r) => `rosin ${r.rosin}% · ${r.date}`), hovertemplate: `%{text}<br>${PNAME[px]} %{x:.1f}<br>${PNAME[py]} %{y:.1f}<extra></extra>` },
        { x: [lo, hi], y: [F.a + F.b * lo, F.a + F.b * hi], mode: "lines", line: { color: css("--accent"), width: 3 }, hoverinfo: "skip" },
      ], layout({ title: { text: `${PNAME[py]} vs ${PNAME[px]} — R² = ${F.r2.toFixed(2)}`, font: { size: 13 } },
        xaxis: { title: PNAME[px] + (PUNIT[px] || ""), gridcolor: css("--line") }, yaxis: { title: PNAME[py] + (PUNIT[py] || ""), gridcolor: css("--line") } }), PCFG);
    }
    const vals = PARAMS6.map((p) => R.map((r) => avgOf(r, p)));
    const Z = PARAMS6.map((_, i) => PARAMS6.map((__, j) => (i === j ? 1 : corr(vals[j], vals[i]))));
    const lab = ["S1", "S2", "S3", "S4", "Temp", "RH"];
    Plotly.react("relHeat", [{ type: "heatmap", z: Z, x: lab, y: lab, zmin: -1, zmax: 1,
      colorscale: [[0, "#2E86AB"], [0.5, "#F4F5F7"], [1, "#C8641E"]], showscale: false, hovertemplate: "%{y} vs %{x}: %{z:.2f}<extra></extra>" }],
    layout({ title: { text: "How strongly each pair moves together (−1 to 1)", font: { size: 13 } }, yaxis: { autorange: "reversed" },
      annotations: Z.flatMap((row, i) => row.map((v, j) => ({ x: lab[j], y: lab[i], text: v.toFixed(2), showarrow: false, font: { size: 11, color: Math.abs(v) > 0.65 ? "#fff" : css("--ink") } }))),
      margin: { l: 50, r: 10, t: 40, b: 40 } }), PCFG);
    const el = $("#relHeat");
    if (!el.dataset.bound) { el.dataset.bound = "1"; el.on("plotly_click", (e) => { const pt = e.points[0]; $("#rX").value = PARAMS6[lab.indexOf(pt.x)]; $("#rY").value = PARAMS6[lab.indexOf(pt.y)]; renderRelation(); }); }
  }

  let raf = 0, playing = null;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderVisual); };

  // ------------------------------------------------------------- boot
  async function boot() {
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
      if (b.dataset.tab === "visual") { renderVisual.sliderOnly = false; renderVisual(); }
      window.dispatchEvent(new Event("resize"));
    }));
    await loadKnown();

    const read = (file) => { const r = new FileReader(); r.onload = () => { $("#demo").value = ""; runPredict(file.name, r.result); }; r.readAsText(file); };
    const fi = $("#fileIn"), drop = $("#drop");
    fi.addEventListener("change", () => { if (fi.files[0]) read(fi.files[0]); fi.value = ""; });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) read(e.dataTransfer.files[0]); });
    Object.keys(S.files).sort().forEach((fn) => $("#demo").insertAdjacentHTML("beforeend", `<option value="${esc(fn)}">${esc(fn)}</option>`));
    const rawText = async (fn) => (await fetch("data/" + encodeURIComponent(fn), { cache: "no-cache" })).text();
    $("#demo").addEventListener("change", async () => { const fn = $("#demo").value; if (fn) runPredict(fn, await rawText(fn)); });
    $("#topN").addEventListener("change", () => last && renderPrediction(last));
    $("#airMode").addEventListener("change", async () => { const fn = $("#demo").value; if (fn) runPredict(fn, await rawText(fn)); else if (last) $("#predOut").insertAdjacentHTML("afterbegin", '<div class="notice warn">Air setting changed: upload the file again to apply it.</div>'); });

    const days = Array.from(new Set(S.recs.map((r) => r.date))).sort();
    const nMix = (d) => new Set(S.recs.filter((r) => r.date === d).map((r) => r.rosin)).size;
    const full = days.slice().sort((a, b) => nMix(b) - nMix(a))[0];
    $("#vDay").innerHTML = days.map((d) => `<option value="${d}"${d === full ? " selected" : ""}>${d} only (${nMix(d)} mixtures, same session)</option>`).join("") + `<option value="all">All days together</option>`;
    $("#mix").addEventListener("input", () => { renderVisual.sliderOnly = true; schedule(); });
    ["#vDay", "#vMeasure", "#vSensor"].forEach((id) => $(id).addEventListener("change", () => { renderVisual.sliderOnly = false; renderVisual(); }));
    ["#rX", "#rY"].forEach((id) => $(id).addEventListener("change", renderRelation));
    $("#play").addEventListener("click", () => {
      if (playing) { clearInterval(playing); playing = null; $("#play").textContent = "▶ Play 0 → 100%"; return; }
      $("#mix").value = 0; $("#play").textContent = "■ Stop";
      playing = setInterval(() => { const v = +$("#mix").value + 2; if (v > 100) { clearInterval(playing); playing = null; $("#play").textContent = "▶ Play 0 → 100%"; return; } $("#mix").value = v; renderVisual(); }, 120);
    });
    $("#boot").remove();
  }
  boot().catch((e) => { $("#boot").className = "notice warn"; $("#boot").textContent = "Failed to start: " + e.message; console.error(e); });
})();
