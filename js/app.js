/* Gas Sensor Analysis web app. All computation happens in the browser via GasCore (core.js). */
(function () {
  "use strict";
  const C = window.GasCore;
  const PARAMS = ["Sensor1", "Sensor2", "Sensor3", "Sensor4", "Temperature", "Humidity"];
  const STORE_KEY = "gasSensor.userRecs.v1";
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); if (html) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cfgName = (p) => `Rosin ${p} – Salak ${100 - p}`;
  const pct = (v) => (v * 100).toFixed(0) + "%";
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const S = { labels: {}, builtin: {}, builtinRecs: [], repoRecs: [], userRecs: [], models: {} };

  // ---------------------------------------------------------------- storage
  function loadUser() { try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function saveUser() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S.userRecs)); } catch (e) { alert("Could not save to browser storage; use Export to keep your data."); } }

  // ---------------------------------------------------------------- helpers
  function guessRosin(name) {
    const n = name.toLowerCase();
    let m = n.match(/rosin[^0-9]{0,4}(\d{1,3})\s*%/);
    if (m) return +m[1];
    m = n.match(/salak[^0-9]{0,4}(\d{1,3})\s*%/);
    if (m) return 100 - +m[1];
    if (n.includes("rosin") && !n.includes("salak")) return 100;
    if (n.includes("salak") && !n.includes("rosin")) return 0;
    return null;
  }
  function plotLayout(extra = {}) {
    const ink = css("--ink"), line = css("--line");
    return Object.assign({
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: ink, size: 12 },
      margin: { l: 56, r: 12, t: 36, b: 80 }, legend: { orientation: "h", y: -0.32 },
      xaxis: { gridcolor: line, zerolinecolor: line }, yaxis: { gridcolor: line, zerolinecolor: line },
    }, extra);
  }
  const PCFG = { responsive: true, displaylogo: false };

  function makeFile(name, text) {
    const d = C.parseCSV(text);
    const segs = C.segment(d);
    if (!segs.length) throw new Error("No recordings found (each recording needs at least 100 rows).");
    const lab = S.labels[name];
    const phases = lab && lab.phases && lab.phases.length === segs.length ? lab.phases.split("") : segs.map(() => "D");
    segs.forEach((s) => (s.f = C.segmentFeatures(s.data)));
    return { name, d, segs, phases, rosin_pct: lab ? lab.rosin_pct : guessRosin(name), fromLabels: !!(lab && lab.phases) };
  }

  // ---------------------------------------------------------------- loader widget
  function createLoader(container, title, onChange) {
    const box = el("div", { class: "loader" });
    box.innerHTML = `<h4>${esc(title)}</h4>
      <label class="drop">Drop a CSV here or click to choose<input type="file" accept=".csv,text/csv" hidden></label>
      <div class="or">or use a file from the repository:
        <select class="pick"><option value="">— choose —</option></select></div>
      <div class="fileinfo"></div>
      <div class="patterns hidden">
        <span class="small muted">Set phases:</span>
        <button class="btn sm" data-p="D">All data</button>
        <button class="btn sm" data-p="DA">Data/Air alternating</button>
        <button class="btn sm" data-p="AD">Air/Data alternating</button>
        <span class="small muted">first</span><input type="number" class="firstN" min="0" value="5"><button class="btn sm" data-p="firstN">data, then air</button>
      </div>
      <div class="tablewrap"><table class="tbl segtbl"></table></div>`;
    container.appendChild(box);
    const state = { file: null };
    const pick = box.querySelector(".pick");
    Object.keys(S.builtin).forEach((fn) => pick.appendChild(el("option", { value: fn }, esc(fn))));
    const input = box.querySelector("input[type=file]"), drop = box.querySelector(".drop");
    const set = (file) => { state.file = file; render(); onChange(state.file); };
    const readFile = (f) => {
      const r = new FileReader();
      r.onload = () => { try { set(makeFile(f.name, r.result)); pick.value = ""; } catch (e) { alert(f.name + ": " + e.message); } };
      r.readAsText(f);
    };
    input.addEventListener("change", () => input.files[0] && readFile(input.files[0]));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]); });
    pick.addEventListener("change", () => { if (pick.value) set(makeFile(pick.value, S.builtin[pick.value].text)); });
    box.querySelector(".patterns").addEventListener("click", (e) => {
      const p = e.target.dataset && e.target.dataset.p; if (!p || !state.file) return;
      const n = state.file.segs.length, N = +box.querySelector(".firstN").value || 0;
      state.file.phases = Array.from({ length: n }, (_, i) => p === "D" ? "D" : p === "DA" ? (i % 2 ? "A" : "D") : p === "AD" ? (i % 2 ? "D" : "A") : (i < N ? "D" : "A"));
      render(); onChange(state.file);
    });
    function render() {
      const f = state.file, info = box.querySelector(".fileinfo"), tbl = box.querySelector(".segtbl");
      box.querySelector(".patterns").classList.toggle("hidden", !f);
      if (!f) { info.innerHTML = ""; tbl.innerHTML = ""; return; }
      info.innerHTML = `<b>${esc(f.name)}</b> · ${f.d.n} rows · ${f.segs.length} recordings` +
        (f.rosin_pct != null ? ` · label: ${cfgName(f.rosin_pct)}` : "") +
        (f.fromLabels ? ` · <span class="badge good">data/air layout from labels</span>` : ` · <span class="badge warn">check the data/air layout</span>`);
      tbl.innerHTML = `<tr><th>#</th><th>Start</th><th>End</th><th class="num">Rows</th><th class="num">Gap before (s)</th><th>Phase</th></tr>` +
        f.segs.map((s, i) => `<tr><td>${i + 1}</td><td>${s.start}</td><td>${s.end}</td><td class="num">${s.data.n}</td><td class="num">${s.gap == null ? "—" : s.gap}</td>
          <td><select data-i="${i}" class="ph-${f.phases[i]}"><option value="D"${f.phases[i] === "D" ? " selected" : ""}>data</option><option value="A"${f.phases[i] === "A" ? " selected" : ""}>air</option><option value="X"${f.phases[i] === "X" ? " selected" : ""}>skip</option></select></td></tr>`).join("");
      tbl.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => { f.phases[+s.dataset.i] = s.value; s.className = "ph-" + s.value; onChange(f); }));
    }
    state.render = render;
    return state;
  }

  // ---------------------------------------------------------------- models
  function trainingRecs() {
    return ($("#useBuiltin").checked ? S.builtinRecs : []).concat(S.repoRecs, S.userRecs).filter((r) => r.phase === "D" || r.phase === "A");
  }
  function trainModels() {
    const recs = trainingRecs();
    const dat = recs.filter((r) => r.phase === "D");
    const cal = C.airReference(recs);
    S.models = {
      raw: dat.length >= 2 && new Set(dat.map((r) => r.rosin_pct)).size >= 2 ? new C.RandomForest().fit(C.toX(dat), dat.map((r) => r.rosin_pct)) : null,
      cal: cal.length >= 2 && new Set(cal.map((r) => r.rosin_pct)).size >= 2 ? new C.RandomForest().fit(C.toX(cal), cal.map((r) => r.rosin_pct)) : null,
      air: new Set(recs.map((r) => r.phase)).size === 2 ? new C.RandomForest().fit(C.toX(recs), recs.map((r) => r.phase)) : null,
      n: { dat: dat.length, cal: cal.length, all: recs.length },
    };
    renderTrainTable();
  }

  function evaluate() {
    const recs = trainingRecs();
    const out = [];
    const run = (name, R) => {
      const y = R.map((r) => r.rosin_pct);
      const classes = Array.from(new Set(y)).sort((a, b) => a - b);
      if (classes.length < 2) { out.push(`<p class="muted">${name}: needs at least 2 configurations.</p>`); return; }
      const { train, test } = C.stratifiedSplit(y, 0.3, 42);
      if (!test.length) { out.push(`<p class="muted">${name}: not enough recordings for a test split.</p>`); return; }
      const m = new C.RandomForest().fit(train.map((i) => C.toX([R[i]])[0]), train.map((i) => y[i]));
      const pred = m.predict(test.map((i) => C.toX([R[i]])[0]));
      const acc = pred.filter((p, k) => p === y[test[k]]).length / test.length;
      const counts = {}; y.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
      const base = Math.max(...Object.values(counts)) / y.length;
      const cm = classes.map((t) => classes.map((p) => test.filter((i, k) => y[i] === t && pred[k] === p).length));
      out.push(`<h3>${name}</h3><p class="kv">Train ${train.length} · test ${test.length} recordings ·
        test accuracy <b>${pct(acc)}</b> <span class="badge ${acc > base + 0.1 ? "good" : acc > base ? "warn" : "bad"}">majority baseline ${pct(base)}</span></p>
        <div class="tablewrap"><table class="tbl"><tr><th>true ↓ / predicted →</th>${classes.map((c) => `<th class="num">${c}%</th>`).join("")}</tr>
        ${cm.map((row, i) => `<tr><th>${classes[i]}%</th>${row.map((v) => `<td class="num">${v}</td>`).join("")}</tr>`).join("")}</table></div>`);
    };
    run("Air-calibrated model (data − air)", C.airReference(recs));
    run("Raw model (no air reference)", recs.filter((r) => r.phase === "D"));
    $("#evalOut").innerHTML = out.join("") + `<p class="muted small">Stratified 70/30 split, seed 42, Random Forest with 100 trees. With few recordings per configuration, one recording moves the accuracy a lot.</p>`;
  }

  function renderTrainTable() {
    const all = ($("#useBuiltin").checked ? S.builtinRecs.map((r) => Object.assign({ src: "built-in" }, r)) : [])
      .concat(S.repoRecs.map((r) => Object.assign({ src: "repo extra" }, r)), S.userRecs.map((r) => Object.assign({ src: "added here" }, r)));
    const rows = C.CONFIGS.map((p) => {
      const g = all.filter((r) => r.rosin_pct === p);
      const files = Array.from(new Set(g.map((r) => r.file)));
      return `<tr><td>${cfgName(p)}</td><td class="num">${g.filter((r) => r.phase === "D").length}</td><td class="num">${g.filter((r) => r.phase === "A").length}</td>
        <td class="small">${files.map((f) => esc(f) + ` <span class="badge">${esc(g.find((r) => r.file === f).src)}</span>`).join("<br>") || '<span class="muted">no data yet</span>'}</td></tr>`;
    });
    const m = S.models;
    $("#trainTable").innerHTML = `<tr><th>Configuration</th><th class="num">Data rec.</th><th class="num">Air rec.</th><th>Files</th></tr>` + rows.join("") +
      `<tr><td colspan="4" class="muted small">Model: Random Forest (100 trees). Trained on ${m.n ? m.n.dat : 0} data recordings (raw) and ${m.n ? m.n.cal : 0} air-calibrated recordings.
      Configurations with no data cannot be predicted until you add them.</td></tr>`;
  }

  // ---------------------------------------------------------------- predict
  function predict(f) {
    const D = f.segs.map((s, i) => ({ s, i })).filter((o) => f.phases[o.i] === "D");
    const A = f.segs.map((s, i) => ({ s, i })).filter((o) => f.phases[o.i] === "A");
    if (!D.length) return { error: "Mark at least one recording as data." };
    let model, X, mode;
    if (A.length && S.models.cal) {
      const ref = {}; C.FEATS.forEach((k) => (ref[k] = C.mean(A.map((o) => o.s.f[k]))));
      X = D.map((o) => C.FEATS.map((k) => o.s.f[k] - ref[k])); model = S.models.cal; mode = "air-calibrated (data − air)";
    } else if (S.models.raw) {
      X = D.map((o) => C.FEATS.map((k) => o.s.f[k])); model = S.models.raw; mode = A.length ? "raw (air-calibrated model unavailable)" : "raw (no air recordings in file)";
    } else return { error: "No trained model — add training data first." };
    const P = model.predictProba(X);
    const avg = model.classes.map((_, c) => C.mean(P.map((p) => p[c])));
    const best = avg.indexOf(Math.max(...avg));
    return { mode, classes: model.classes, avg, best: model.classes[best], conf: avg[best], est: avg.reduce((s, p, c) => s + p * model.classes[c], 0),
      per: D.map((o, k) => ({ rec: o.i + 1, start: o.s.start, cls: model.classes[P[k].indexOf(Math.max(...P[k]))], conf: Math.max(...P[k]), est: P[k].reduce((s, p, c) => s + p * model.classes[c], 0) })), nAir: A.length };
  }

  function renderPrediction(f) {
    const r = predict(f), out = $("#predOut");
    if (r.error) { out.innerHTML = `<div class="notice warn">${esc(r.error)}</div>`; return; }
    const trained = r.classes.map((c) => c + "%").join(", ");
    const truth = f.rosin_pct != null ? `<p class="kv">File name / label suggests: <b>${cfgName(f.rosin_pct)}</b> ${f.rosin_pct === r.best ? '<span class="badge good">match</span>' : '<span class="badge bad">different</span>'}</p>` : "";
    out.innerHTML = `<div class="result"><div>
        <div class="muted small">Predicted configuration</div>
        <div class="big">${cfgName(r.best)}</div>
        <p class="kv">Confidence <b>${pct(r.conf)}</b> · estimated rosin ≈ <b>${r.est.toFixed(0)}%</b></p>
        <p class="kv">Model: <span class="badge">${esc(r.mode)}</span></p>
        <p class="kv small muted">${r.per.length} data and ${r.nAir} air recordings used. The model knows these configurations: ${trained}.</p>
        ${truth}
        ${trainingRecs().some((t) => t.file === f.name) ? '<p class="kv small"><span class="badge warn">note</span> This file is already in the training set, so this is not an independent test.</p>' : ""}
      </div><div id="plotProb" class="plot"></div></div>
      <h3>Per recording</h3><div class="tablewrap"><table class="tbl"><tr><th>#</th><th>Start</th><th>Predicted</th><th class="num">Confidence</th><th class="num">Est. rosin %</th></tr>
      ${r.per.map((p) => `<tr><td>${p.rec}</td><td>${p.start}</td><td>${cfgName(p.cls)}</td><td class="num">${pct(p.conf)}</td><td class="num">${p.est.toFixed(0)}</td></tr>`).join("")}</table></div>`;
    const y = C.CONFIGS.map((c) => { const i = r.classes.indexOf(c); return i < 0 ? 0 : r.avg[i]; });
    Plotly.newPlot("plotProb", [{ type: "bar", x: C.CONFIGS.map((c) => `R${c}/S${100 - c}`), y,
      marker: { color: C.CONFIGS.map((c) => (c === r.best ? css("--accent") : r.classes.includes(c) ? css("--air") : css("--line"))) },
      hovertemplate: "%{x}: %{y:.0%}<extra></extra>" }],
    plotLayout({ title: { text: "Probability per configuration (grey = not trained yet)", font: { size: 13 } }, yaxis: { tickformat: ".0%", range: [0, 1], gridcolor: css("--line") }, showlegend: false }), PCFG);
    $("#trainLabel").value = String(f.rosin_pct != null ? f.rosin_pct : r.best);
  }

  // ---------------------------------------------------------------- compare
  function resampleMean(segs, param, norm) {
    const G = 200;
    const curves = segs.map((s) => {
      const y = s.data[param], n = y.length, y0 = norm ? C.mean(y, 0, 3) : 0;
      return Array.from({ length: G }, (_, g) => y[Math.min(n - 1, Math.round((g / (G - 1)) * (n - 1)))] - y0);
    });
    const dur = segs.length ? C.mean(segs.map((s) => s.data.t[s.data.n - 1] - s.data.t[0] + 1)) : 60;
    const x = Array.from({ length: G }, (_, g) => (g / (G - 1)) * dur);
    const m = x.map((_, g) => C.mean(curves.map((c) => c[g])));
    const sd = x.map((_, g) => Math.sqrt(C.mean(curves.map((c) => (c[g] - m[g]) ** 2))));
    return { x, m, sd, n: curves.length };
  }
  function groupStats(segs, param) {
    if (!segs.length) return null;
    const lv = segs.map((s) => C.mean(s.data[param])), rs = segs.map((s) => { const y = s.data[param]; return C.mean(y, y.length - 30) - C.mean(y, 0, 3); });
    return { level: C.mean(lv), resp: C.mean(rs) };
  }

  function renderCompare() {
    const mode = document.querySelector("input[name=cmpMode]:checked").value;
    const fa = S.loadA.file, fb = S.loadB.file, param = $("#cmpParam").value, norm = $("#cmpNorm").checked;
    $("#loaderB").classList.toggle("hidden", mode !== "two");
    $("#loaderA").parentElement.classList.toggle("grid2", mode === "two");
    const has = fa && (mode === "air" || fb);
    $("#cmpEmpty").classList.toggle("hidden", !!has);
    ["#plotTrace", "#plotMean", "#plotDiff"].forEach((id) => { if (!has) Plotly.purge($(id)); });
    if (!has) { $("#cmpTable").innerHTML = ""; return; }
    const pick = (f, ph) => f.segs.filter((_, i) => f.phases[i] === ph);
    let g1, g2, n1, n2;
    if (mode === "air") { g1 = pick(fa, "D"); g2 = pick(fa, "A"); n1 = "Data"; n2 = "Air"; }
    else { g1 = pick(fa, "D"); g2 = pick(fb, "D"); n1 = "A: " + fa.name; n2 = "B: " + fb.name; }
    const c1 = css("--data"), c2 = mode === "air" ? css("--air") : css("--b");

    // full trace
    const traces = [];
    const addFile = (f, label, colD, colA) => {
      let x0 = 0;
      f.segs.forEach((s, i) => {
        const ph = f.phases[i]; if (ph === "X") { x0 += s.data.n + 40; return; }
        const y = s.data[param], y0 = norm ? C.mean(y, 0, 3) : 0;
        traces.push({ x: y.map((_, k) => x0 + k), y: y.map((v) => v - y0), mode: "lines", line: { width: 1.2, color: ph === "D" ? colD : colA },
          name: `${label}${ph === "D" ? "data" : "air"}`, legendgroup: label + ph, showlegend: !traces.some((t) => t.legendgroup === label + ph),
          hovertemplate: `#${i + 1} ${s.start} ${ph === "D" ? "data" : "air"}<br>%{y:.2f}<extra></extra>` });
        x0 += s.data.n + 40;
      });
    };
    addFile(fa, mode === "two" ? "A " : "", c1, css("--air"));
    if (mode === "two") addFile(fb, "B ", c2, css("--muted"));
    Plotly.newPlot("plotTrace", traces, plotLayout({ title: { text: `${param} — all recordings in order${norm ? " (start subtracted)" : ""}`, font: { size: 13 } }, xaxis: { title: "sample (recordings placed side by side)", gridcolor: css("--line") } }), PCFG);

    const band = (r, color, name) => [
      { x: r.x.concat(r.x.slice().reverse()), y: r.m.map((v, i) => v + r.sd[i]).concat(r.m.map((v, i) => v - r.sd[i]).reverse()), fill: "toself", fillcolor: color + "33", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
      { x: r.x, y: r.m, mode: "lines", line: { color, width: 2 }, name: `${name} (n=${r.n})` }];
    const r1 = resampleMean(g1, param, norm), r2 = resampleMean(g2, param, norm);
    const mt = []; if (r1.n) mt.push(...band(r1, c1, n1)); if (r2.n) mt.push(...band(r2, c2, n2));
    Plotly.newPlot("plotMean", mt, plotLayout({ title: { text: `Average recording ± 1 sd`, font: { size: 13 } }, xaxis: { title: "seconds into recording", gridcolor: css("--line") } }), PCFG);
    if (r1.n && r2.n) {
      Plotly.newPlot("plotDiff", [{ x: r1.x, y: r1.m.map((v, i) => v - r2.m[i]), mode: "lines", line: { color: css("--accent"), width: 2 }, name: "difference" }],
        plotLayout({ title: { text: `Difference: ${mode === "air" ? "data − air" : "A − B"}`, font: { size: 13 } }, xaxis: { title: "seconds into recording", gridcolor: css("--line") }, showlegend: false }), PCFG);
    } else { Plotly.purge($("#plotDiff")); $("#plotDiff").innerHTML = `<p class="muted">Need recordings in both groups for a difference (${esc(n1)}: ${r1.n}, ${esc(n2)}: ${r2.n}). Set the phases in the table above.</p>`; }

    const f2 = (v) => (v == null ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    $("#cmpTable").innerHTML = `<tr><th>Parameter</th><th class="num">${esc(n1)} level</th><th class="num">${esc(n2)} level</th><th class="num">Δ level</th><th class="num">Δ %</th>
      <th class="num">${esc(n1)} response</th><th class="num">${esc(n2)} response</th><th class="num">Δ response</th></tr>` +
      PARAMS.map((p) => {
        const a = groupStats(g1, p), b = groupStats(g2, p), dl = a && b ? a.level - b.level : null;
        return `<tr><td>${p}</td><td class="num">${f2(a && a.level)}</td><td class="num">${f2(b && b.level)}</td><td class="num">${f2(dl)}</td><td class="num">${dl == null ? "—" : ((dl / b.level) * 100).toFixed(2) + "%"}</td>
          <td class="num">${f2(a && a.resp)}</td><td class="num">${f2(b && b.resp)}</td><td class="num">${f2(a && b ? a.resp - b.resp : null)}</td></tr>`;
      }).join("") + `<tr><td colspan="8" class="muted small">Level = mean over the recording. Response = end (last 30 rows) − start (first 3 rows).</td></tr>`;
  }

  // ---------------------------------------------------------------- results + samples
  async function renderResults() {
    try {
      const m = await (await fetch("results/metrics.json")).json();
      const rows = [["mixture_air_calibrated", "Mixture — air-calibrated"], ["mixture_raw", "Mixture — raw"], ["data_vs_air", "Data vs air"]].map(([k, t]) => {
        const r = m[k], v = r.models["Random forest"];
        return `<tr><td>${t}</td><td class="num">${r.n}</td><td class="num">${pct(v.holdout_acc)} <span class="muted">(n=${v.holdout_n_test})</span></td><td class="num">${pct(v.repeated_mean)} ± ${pct(v.repeated_std)}</td>
          <td class="num">${v.lofo_acc == null ? "—" : pct(v.lofo_acc)}</td><td class="num">${pct(r.majority_baseline)}</td></tr>`;
      });
      const unk = Object.entries(m.unseen_mixtures_raw_model || {}).map(([f, v]) => `<tr><td>${esc(f)}</td><td class="num">${v.true_rosin_pct}%</td><td class="num">${v.estimated_rosin_pct_mean.toFixed(0)}%</td></tr>`).join("");
      $("#resMetrics").innerHTML = `<div class="tablewrap"><table class="tbl"><tr><th>Task</th><th class="num">Recordings</th><th class="num">Hold-out test (70/30)</th><th class="num">Mean of ${m.repeats} random splits</th><th class="num">Leave-one-file-out</th><th class="num">Majority baseline</th></tr>${rows.join("")}</table></div>
        <h3>Unseen mixtures (not in training)</h3><div class="tablewrap"><table class="tbl"><tr><th>File</th><th class="num">True rosin</th><th class="num">Estimated</th></tr>${unk}</table></div>
        <p class="muted small">Trained on ${(m.trained_configs || []).length} of 11 configurations (${(m.trained_configs || []).map((c) => c + "%").join(", ")} rosin), 1–2 sessions each. Leave-one-file-out accuracy is low, so the model does not yet generalise to new sessions.
        Accuracy should improve as the remaining configurations are recorded with paired air recordings.</p>`;
    } catch (e) { $("#resMetrics").textContent = "Could not load metrics.json"; }
    $("#rawFigs").innerHTML = Object.keys(S.labels).map((fn) => {
      const img = "results/raw_" + fn.replace(".csv", "").replaceAll("%", "pct").replaceAll("(", "_").replaceAll(")", "").replaceAll("+", "_") + ".png";
      return `<figure><img loading="lazy" src="${encodeURI(img)}" alt="${esc(fn)}"><figcaption>${esc(fn)}</figcaption></figure>`;
    }).join("");
  }
  function renderGallery() {
    const have = new Set(S.builtinRecs.concat(S.repoRecs, S.userRecs).map((r) => r.rosin_pct));
    const pending = new Set(Object.values(S.labels).filter((l) => !l.phases).map((l) => l.rosin_pct));
    $("#gallery").innerHTML = C.CONFIGS.map((p) => {
      const f = `images/rosin${String(p).padStart(3, "0")}_salak${String(100 - p).padStart(3, "0")}.webp`;
      return `<figure><img loading="lazy" src="${f}" alt="${cfgName(p)}"><figcaption>Rosin ${p}% + Salak ${100 - p}%<span class="has">${have.has(p) ? "✔ sensor data in training" : pending.has(p) ? "recorded · data/air layout pending" : "sensor data pending"}</span></figcaption></figure>`;
    }).join("");
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
      window.dispatchEvent(new Event("resize"));
    }));
    S.labels = (await (await fetch("data/labels.json")).json()).files;
    await Promise.all(Object.keys(S.labels).map(async (fn) => {
      const text = await (await fetch("data/" + encodeURIComponent(fn))).text();
      S.builtin[fn] = { text };
      const f = makeFile(fn, text);
      if (S.labels[fn].phases) f.segs.forEach((s, i) => S.builtinRecs.push({ file: fn, seg: i + 1, phase: f.phases[i], rosin_pct: f.rosin_pct, f: s.f }));
    }));
    try { const x = await fetch("data/extra_training.json"); if (x.ok) S.repoRecs = (await x.json()).recs || []; } catch (e) { /* optional */ }
    S.userRecs = loadUser();

    $("#trainLabel").innerHTML = C.CONFIGS.map((p) => `<option value="${p}">${cfgName(p)}</option>`).join("");
    S.loadA = createLoader($("#loaderA"), "Dataset A", renderCompare);
    S.loadB = createLoader($("#loaderB"), "Dataset B", renderCompare);
    document.querySelectorAll("input[name=cmpMode]").forEach((r) => r.addEventListener("change", renderCompare));
    $("#cmpParam").addEventListener("change", renderCompare);
    $("#cmpNorm").addEventListener("change", renderCompare);

    S.loadP = createLoader($("#loaderP"), "File to predict", (f) => {
      ["#btnPredict", "#btnSuggest", "#btnAdd"].forEach((b) => ($(b).disabled = !f));
      $("#predOut").innerHTML = "";
      if (f && f.rosin_pct != null) $("#trainLabel").value = String(f.rosin_pct);
    });
    $("#btnPredict").addEventListener("click", () => S.loadP.file && renderPrediction(S.loadP.file));
    $("#btnSuggest").addEventListener("click", () => {
      const f = S.loadP.file; if (!f || !S.models.air) return;
      const p = S.models.air.predict(f.segs.map((s) => C.FEATS.map((k) => s.f[k])));
      f.phases = p.slice(); S.loadP.render();
      $("#predOut").innerHTML = `<div class="notice warn">Phases suggested by the data-vs-air model. It is only slightly better than chance on the current data, so please check them against your lab notes.</div>`;
    });
    $("#btnAdd").addEventListener("click", () => {
      const f = S.loadP.file; if (!f) return;
      const label = +$("#trainLabel").value;
      const recs = f.segs.map((s, i) => ({ file: f.name, seg: i + 1, phase: f.phases[i], rosin_pct: label, f: s.f })).filter((r) => r.phase !== "X");
      if (!recs.some((r) => r.phase === "D")) { alert("Mark at least one recording as data."); return; }
      if (S.userRecs.some((r) => r.file === f.name) && !confirm(`${f.name} is already in your training data. Replace it?`)) return;
      S.userRecs = S.userRecs.filter((r) => r.file !== f.name).concat(recs);
      saveUser(); trainModels(); renderGallery();
      $("#predOut").insertAdjacentHTML("afterbegin", `<div class="notice">Added ${recs.length} recordings from <b>${esc(f.name)}</b> as ${cfgName(label)}. Model retrained.</div>`);
    });
    $("#useBuiltin").addEventListener("change", trainModels);
    $("#btnRetrain").addEventListener("click", () => { trainModels(); evaluate(); });
    $("#btnExport").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ version: 1, features: C.FEATS, recs: S.userRecs.concat(S.repoRecs) }, null, 1)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: "extra_training.json" }); document.body.appendChild(a); a.click(); a.remove();
    });
    $("#importFile").addEventListener("change", (e) => {
      const file = e.target.files[0]; if (!file) return;
      file.text().then((t) => {
        try {
          const recs = JSON.parse(t).recs || [];
          const files = new Set(recs.map((r) => r.file));
          S.userRecs = S.userRecs.filter((r) => !files.has(r.file)).concat(recs.filter((r) => r.f && r.phase && r.rosin_pct != null));
          saveUser(); trainModels(); renderGallery(); alert(`Imported ${recs.length} recordings.`);
        } catch (err) { alert("Not a valid training-set file."); }
      });
      e.target.value = "";
    });
    $("#btnReset").addEventListener("click", () => {
      if (!S.userRecs.length) return;
      if (!confirm(`Remove ${S.userRecs.length} recordings added in this browser?`)) return;
      S.userRecs = []; saveUser(); trainModels(); renderGallery();
    });

    trainModels();
    evaluate();
    renderCompare();
    renderResults();
    renderGallery();
    $("#boot").remove();
  }
  boot().catch((e) => { $("#boot").className = "notice warn"; $("#boot").textContent = "Failed to start: " + e.message; console.error(e); });
})();
