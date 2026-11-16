/* Отчёт в PDF без внешних библиотек: страницы рисуются на canvas (кириллица — шрифтами системы),
   каждая страница кладётся в PDF как JPEG. Блоки: title, h, h4, note, table, svg, legend. */
(function (root) {
  "use strict";
  const PW = 842, PH = 595, M = 28, K = 2;            // A4 альбомная, пт; масштаб растра
  const FB = '"PT Sans","Segoe UI",Arial,sans-serif';
  const FH = '"Roboto Condensed","Arial Narrow",Arial,sans-serif';
  const C = { fg: "#1d2430", muted: "#5f6b78", line: "#d5dae1", zebra: "#f3f5f8", head: "#e8ecf1", good: "#1a7f45", bad: "#c23b32", foot: "#eef1f5" };

  function wrap(ctx, text, w) {
    const out = []; String(text).split("\n").forEach((para) => {
      const words = para.split(/\s+/); let line = "";
      words.forEach((wd) => {
        const t = line ? line + " " + wd : wd;
        if (ctx.measureText(t).width <= w || !line) line = t; else { out.push(line); line = wd; }
        while (ctx.measureText(line).width > w && line.length > 1) {  // очень длинное слово
          let k = line.length - 1; while (k > 1 && ctx.measureText(line.slice(0, k)).width > w) k--;
          out.push(line.slice(0, k)); line = line.slice(k);
        }
      });
      out.push(line);
    });
    return out;
  }
  function jpegOf(canvas) { return new Promise((res) => canvas.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), "image/jpeg", 0.9)); }
  function svgImage(svg) {
    return new Promise((res, rej) => {
      const xml = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
      const im = new Image(); im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = (e) => { URL.revokeObjectURL(url); rej(new Error("не удалось нарисовать график")); }; im.src = url;
    });
  }

  async function build(blocks, meta) {
    meta = meta || {};
    // графики — заранее в картинки
    for (const b of blocks) if (b.t === "svg") { b.img = await svgImage(b.el); b.w = +b.el.getAttribute("width"); b.h = +b.el.getAttribute("height"); }
    const pages = [];
    let cv, ctx, y, pageNo = 0;
    const AW = PW - 2 * M, BOT = PH - M - 14;
    function newPage() {
      cv = document.createElement("canvas"); cv.width = PW * K; cv.height = PH * K;
      ctx = cv.getContext("2d"); ctx.scale(K, K); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, PW, PH);
      ctx.textBaseline = "alphabetic"; pageNo++; y = M;
    }
    async function endPage() {
      ctx.font = "7.5px " + FB; ctx.fillStyle = C.muted; ctx.textAlign = "left";
      ctx.fillText(meta.footer || "", M, PH - M + 6);
      ctx.textAlign = "right"; ctx.fillText("стр. " + pageNo, PW - M, PH - M + 6); ctx.textAlign = "left";
      pages.push(await jpegOf(cv));
    }
    async function need(h) { if (y + h > BOT) { await endPage(); newPage(); return true; } return false; }
    function text(t, x, yy, font, color, align) { ctx.font = font; ctx.fillStyle = color || C.fg; ctx.textAlign = align || "left"; ctx.fillText(t, x, yy); ctx.textAlign = "left"; }

    async function drawTable(b) {
      // подбор шрифта и ширины столбцов
      const n = b.head.length; let fs = 8, widths, split = null;
      const pad = 3.5, CAPL = 250;
      const measure = (f) => {
        ctx.font = f + "px " + FB;
        const w = new Array(n).fill(0);
        b.rows.concat(b.foot || []).forEach((r) => r.forEach((c, i) => { w[i] = Math.max(w[i], Math.min(CAPL, ctx.measureText(String(c)).width)); }));
        ctx.font = "bold " + f + "px " + FB;
        b.head.forEach((h, i) => { const longest = String(h).split(/\s+/).reduce((a, wd) => Math.max(a, ctx.measureText(wd).width), 0); w[i] = Math.max(w[i], longest, Math.min(ctx.measureText(h).width, 60)); });
        return w.map((x) => Math.ceil(x + 2 * pad));
      };
      for (fs of [8, 7.5, 7, 6.5, 6]) { widths = measure(fs); if (widths.reduce((a, x) => a + x, 0) <= AW) break; }
      const total = widths.reduce((a, x) => a + x, 0);
      let groups = [Array.from({ length: n }, (_, i) => i)];
      if (total > AW) {   // делим столбцы на части, повторяя ключевые (№, имя)
        fs = 7.5; widths = measure(fs);
        const key = b.key || (String(b.head[0]).trim() === "№" ? (String(b.head[1]).match(/Имя/) ? [0, 1] : [0]) : [0]);
        const kw = key.reduce((a, i) => a + widths[i], 0);
        const rest = []; for (let i = 0; i < n; i++) if (key.indexOf(i) < 0) rest.push(i);
        const restW = rest.reduce((a, i) => a + widths[i], 0);
        let parts = Math.ceil(restW / (AW - kw));
        for (;;) {   // делим поровну по ширине
          const target = restW / parts; groups = []; let g = key.slice(), w = 0, ok = true;
          rest.forEach((i) => { if (w + widths[i] > target * 1.08 && g.length > key.length && groups.length < parts - 1) { groups.push(g); g = key.slice(); w = 0; } g.push(i); w += widths[i]; });
          groups.push(g);
          groups.forEach((gg) => { if (gg.reduce((a, i) => a + widths[i], 0) > AW) ok = false; });
          if (ok || parts > n) break; parts++;
        }
        split = true;
      }
      const lh = fs * 1.25;
      for (let gi = 0; gi < groups.length; gi++) {
        const cols = groups[gi];
        let ws = cols.map((i) => widths[i]); const sum = ws.reduce((a, x) => a + x, 0);
        if (b.stretch !== false && sum < AW * 0.6 && cols.length > 3) { /* узкие таблицы не растягиваем */ }
        if (split && gi > 0) { await need(lh * 3); text("(продолжение)", M, y + fs, "italic " + fs + "px " + FB, C.muted); y += lh + 2; }
        ctx.font = "bold " + fs + "px " + FB;
        const headLines = cols.map((i, k) => wrap(ctx, b.head[i], ws[k] - 2 * pad));
        const hh = Math.max(...headLines.map((l) => l.length)) * lh + 2 * pad;
        const drawHead = () => {
          ctx.fillStyle = C.head; ctx.fillRect(M, y, sum, hh);
          let x = M; cols.forEach((i, k) => { headLines[k].forEach((ln, j) => text(ln, b.align[i] === "l" ? x + pad : x + ws[k] - pad, y + pad + fs + j * lh - 1, "bold " + fs + "px " + FB, C.fg, b.align[i] === "l" ? "left" : "right")); x += ws[k]; });
          y += hh;
        };
        await need(hh + lh * 2 + 4); drawHead();
        const all = b.rows.map((r) => ({ r, foot: false })).concat((b.foot || []).map((r) => ({ r, foot: true })));
        for (let ri = 0; ri < all.length; ri++) {
          const { r, foot } = all[ri];
          ctx.font = (foot ? "bold " : "") + fs + "px " + FB;
          const lines = cols.map((i, k) => wrap(ctx, r[i] == null ? "" : String(r[i]), ws[k] - 2 * pad));
          const rh = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad - 1;
          if (await need(rh)) drawHead();
          if (foot) { ctx.fillStyle = C.foot; ctx.fillRect(M, y, sum, rh); } else if (ri % 2) { ctx.fillStyle = C.zebra; ctx.fillRect(M, y, sum, rh); }
          let x = M;
          cols.forEach((i, k) => {
            const cl = b.cls && b.cls[ri] && b.cls[ri][i];
            const col = cl === "good" ? C.good : cl === "bad" ? C.bad : C.fg;
            const f = (foot || cl ? "bold " : "") + fs + "px " + FB;
            lines[k].forEach((ln, j) => text(ln, b.align[i] === "l" ? x + pad : x + ws[k] - pad, y + pad + fs + j * lh - 1, f, col, b.align[i] === "l" ? "left" : "right"));
            x += ws[k];
          });
          ctx.strokeStyle = C.line; ctx.lineWidth = 0.4; ctx.beginPath(); ctx.moveTo(M, y + rh); ctx.lineTo(M + sum, y + rh); ctx.stroke();
          y += rh;
        }
        y += 8;
      }
    }

    const sizeOf = (b) => !b ? 0 : b.t === "svg" ? b.h * Math.min(1, AW / b.w) + 6 : b.t === "table" ? 48 : b.t === "legend" ? 14 : 0;
    newPage();
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.t === "h4") await need(18 + sizeOf(blocks[bi + 1]));
      if (b.t === "title") {
        text(b.text, M, y + 18, "bold 20px " + FH, C.fg); y += 26;
        if (b.sub) { ctx.font = "10px " + FB; for (const ln of wrap(ctx, b.sub, AW)) { text(ln, M, y + 11, "10px " + FB, C.muted); y += 13; } }
        y += 8;
      } else if (b.t === "h") {
        if (b.page && y > M + 1) { await endPage(); newPage(); }
        await need(60); y += 6; text(b.text, M, y + 13, "bold 13.5px " + FH, C.fg); y += 18;
        ctx.strokeStyle = C.line; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(PW - M, y); ctx.stroke(); y += 5;
      } else if (b.t === "h4") {
        await need(40); y += 3; text(b.text, M, y + 10, "bold 10px " + FH, C.fg); y += 14;
      } else if (b.t === "note") {
        ctx.font = "8px " + FB; const ls = wrap(ctx, b.text, AW);
        for (const ln of ls) { await need(11); text(ln, M, y + 8, "8px " + FB, C.muted); y += 10.5; }
        y += 4;
      } else if (b.t === "legend") {
        await need(14); let x = M; ctx.font = "7.5px " + FB;
        b.items.forEach(([col, lab]) => { ctx.fillStyle = col; ctx.fillRect(x, y + 1, 7, 8); if (col === "#ffffff" || col.indexOf("rgba") === 0) { ctx.strokeStyle = C.line; ctx.strokeRect(x, y + 1, 7, 8); } text(lab, x + 10, y + 8, "7.5px " + FB, C.muted); x += 14 + ctx.measureText(lab).width + 10; });
        y += 14;
      } else if (b.t === "page") {
        if (y > M + 1) { await endPage(); newPage(); }
      } else if (b.t === "table") {
        await drawTable(b);
      } else if (b.t === "svg") {
        const s = Math.min(1, AW / b.w), w = b.w * s, h = b.h * s;
        await need(h + 4); ctx.drawImage(b.img, M, y, w, h); y += h + 6;
      }
    }
    await endPage();
    return writePdf(pages);
  }

  /* Минимальный PDF: по одной JPEG-картинке на страницу. */
  function writePdf(pages) {
    const enc = new TextEncoder(); const parts = []; let len = 0; const offs = [];
    const push = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (id, body) => { offs[id] = len; push(id + " 0 obj\n"); body.forEach(push); push("\nendobj\n"); };
    const n = pages.length; const W = PW * K, H = PH * K;
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const kids = pages.map((_, i) => (3 + i * 3) + " 0 R").join(" ");
    obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    obj(2, ["<< /Type /Pages /Kids [" + kids + "] /Count " + n + " >>"]);
    pages.forEach((jpg, i) => {
      const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
      obj(pid, ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PW + " " + PH + "] /Resources << /XObject << /Im" + i + " " + iid + " 0 R >> >> /Contents " + cid + " 0 R >>"]);
      const cs = "q " + PW + " 0 0 " + PH + " 0 0 cm /Im" + i + " Do Q";
      obj(cid, ["<< /Length " + cs.length + " >>\nstream\n" + cs + "\nendstream"]);
      obj(iid, ["<< /Type /XObject /Subtype /Image /Width " + W + " /Height " + H + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpg.length + " >>\nstream\n", jpg, "\nendstream"]);
    });
    const total = 3 + n * 3;
    const xref = len;
    let x = "xref\n0 " + total + "\n0000000000 65535 f \n";
    for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n";
    push(x + "trailer\n<< /Size " + total + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    const out = new Uint8Array(len); let p = 0; parts.forEach((b) => { out.set(b, p); p += b.length; }); return out;
  }

  root.VPdf = { build, writePdf };
})(window);
