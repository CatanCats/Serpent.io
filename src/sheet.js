/* ============================================================================
   Death information sheet (both pages; inlined by build.sh).
   On the frame where a death is noticed the page draws the moment of death once more
   (offline: the sim's deathPose(); online: everyone as at the server's crash step, from the
   DEATH message) and copies that frame right after drawing it, while the canvas still holds
   it (WebGPU and WebGL keep a frame until the end of the task that drew it), scaled to at
   most 960 px wide. Nothing is copied while you play. "Download information sheet" then
   draws a PNG card with the run's numbers and that picture on a 2D canvas: nothing is sent
   anywhere.
   ========================================================================== */
const deathShot = { img: null };
function grabDeathShot(cv) {
  try {
    const w = Math.min(960, cv.width), h = Math.max(1, Math.round(cv.height * w / cv.width));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(cv, 0, 0, w, h); deathShot.img = c;
  } catch (e) { deathShot.img = null; }
}
// d: { name, mode, length, peak, best, kills, rankNow, rankBest, total, killer, seconds, colour }
function downloadDeathSheet(d) {
  const W = 1000, pad = 40, pic = deathShot.img;
  const pw = W - pad * 2, ph = pic ? Math.round(pic.height * pw / pic.width) : 0;
  const cells = [
    ["Length when you died", d.length.toLocaleString()],
    ["Longest this run", d.peak.toLocaleString()],
    ["Your best ever (this device)", d.best.toLocaleString()],
    ["Highest place this run", d.rankBest ? `#${d.rankBest}` : "–"],
    ["Place when you died", d.rankNow ? `#${d.rankNow} of ${d.total}` : "–"],
    ["Kills", String(d.kills)],
    ["Time alive", d.seconds >= 60 ? `${Math.floor(d.seconds / 60)} min ${Math.round(d.seconds % 60)} s` : `${Math.round(d.seconds)} s`],
    ["Killed by", d.killer],
    ["Mode", d.mode],
  ];
  const cols = 3, cw = (pw - (cols - 1) * 14) / cols, chh = 84, rows = Math.ceil(cells.length / cols);
  const H = 170 + rows * (chh + 14) + (pic ? ph + 60 : 0) + 50;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"), font = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  g.fillStyle = "#070a12"; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(pad, 0, pad + 300, 0); grad.addColorStop(0, "#34d399"); grad.addColorStop(1, "#38bdf8");
  g.fillStyle = grad; g.font = `800 44px ${font}`; g.textBaseline = "alphabetic"; g.fillText("serpent.io", pad, 74);
  g.fillStyle = "#93a0bd"; g.font = `500 18px ${font}`;
  g.fillText(`Run report · ${new Date().toLocaleString()}`, pad, 104);
  g.fillStyle = d.colour || "#34d399"; g.beginPath(); g.arc(pad + 9, 137, 9, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#e8edf8"; g.font = `700 24px ${font}`; g.fillText(d.name, pad + 28, 145);
  let y = 170;
  cells.forEach(([k, v], i) => {
    const x = pad + (i % cols) * (cw + 14), yy = y + Math.floor(i / cols) * (chh + 14);
    g.fillStyle = "rgba(255,255,255,.05)"; g.strokeStyle = "rgba(255,255,255,.10)";
    g.beginPath(); g.roundRect(x, yy, cw, chh, 12); g.fill(); g.stroke();
    let fs = 28; g.font = `700 ${fs}px ${font}`;
    while (g.measureText(v).width > cw - 32 && fs > 18) g.font = `700 ${--fs}px ${font}`; // long values: smaller first
    g.fillStyle = "#e8edf8";
    let t = v; while (g.measureText(t).width > cw - 32 && t.length > 2) t = t.slice(0, -2) + "…";
    g.fillText(t, x + 16, yy + 40);
    g.fillStyle = "#93a0bd"; g.font = `600 13px ${font}`; g.fillText(k.toUpperCase(), x + 16, yy + 66);
  });
  y += rows * (chh + 14) + 10;
  if (pic) {
    g.fillStyle = "#93a0bd"; g.font = `600 14px ${font}`; g.fillText("THE MOMENT OF DEATH", pad, y + 22);
    g.save(); g.beginPath(); g.roundRect(pad, y + 34, pw, ph, 14); g.clip(); g.drawImage(pic, pad, y + 34, pw, ph); g.restore();
    g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.roundRect(pad, y + 34, pw, ph, 14); g.stroke();
    y += ph + 60;
  }
  g.fillStyle = "#5d6a86"; g.font = `500 13px ${font}`; g.fillText("Play at br8t.com/slither.io", pad, H - 22);
  c.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a"), stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = URL.createObjectURL(b); a.download = `serpent-run-${stamp}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, "image/png");
}
