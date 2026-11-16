/* Статистический движок волейбольной разметки. Чистые функции, без DOM.
   Используется страницей (window.VStats) и в node для проверки. */
(function (root) {
  "use strict";

  const DEFAULT_RULES = {
    // состояния розыгрыша после касания (балл касания = состояние после − состояние до)
    state: { "R#": 0.2, "R+": 0.05, "R-": -0.2, "D#": 0.2, "D+": 0.05, "D-": -0.2, "E#": 0.4, "E+": 0.05, "E-": -0.3 },
    digMissOwn: 0.5,        // не поднятая атака: доля защитника
    overPen: { R: 0.3, D: 0.1, E: 0.3 },   // штраф «на сторону соперника»: берётся взаймы у следующего владения
    threshold: 60,          // порог розыгрышей на площадке для места
    thresholdSet: 15,       // тот же порог при статистике одной партии
    // веса индекса полезности и PCR
    w: { r3: 0.5, r2: 0.25, e3: 0.5, e2: 0.25, dig: 0.5, btouch: 0.25 },
    setsDenominator: null,  // партий для «за партию»; null = число партий матча
    clipPre: 4, clipPost: 3, clipMax: 20   // видео по фильтру: до/после точного времени, после очка, максимум клипа, с
  };

  // какое действие с каким результатом даёт очко
  const WIN = { "S#": "M", "S=": "N", "R=": "N", "A#": "M", "A/": "N", "A=": "N", "C#": "M", "C/": "N", "C=": "N", "B#": "M", "B=": "N",
    "D=": "N", "E=": "N", "X=": "N", "F#": "M", "F=": "N" };

  const code = (e) => e.a + e.r;
  const winOf = (e) => e.k === "pt" ? e.w : (e.k === "act" ? (WIN[code(e)] || "") : "");

  function mergeRules(r) {
    const d = JSON.parse(JSON.stringify(DEFAULT_RULES));
    if (!r) return d;
    if (r.state) Object.assign(d.state, r.state);
    if (r.w) Object.assign(d.w, r.w);
    if (r.overPen) Object.assign(d.overPen, r.overPen);
    ["digMissOwn", "threshold", "thresholdSet", "setsDenominator", "clipPre", "clipPost", "clipMax"].forEach((k) => { if (r[k] != null) d[k] = r[k]; });
    return d;
  }

  /* Разбивает события на розыгрыши и отслеживает состав на площадке. */
  function buildRallies(match) {
    const ev = match.events || [];
    const sets = Array.from(new Set(ev.filter((e) => e.k === "act" || e.k === "pt").map((e) => e.s))).sort((a, b) => a - b);
    const rallies = [];
    const warnings = [];
    const breaks = [];
    sets.forEach((s) => {
      // court[0..5] = зоны I..VI; пустые места — ""
      let court = ((match.lineups || {})[s] || (match.lineups || {})[String(s)] || []).map((x) => x == null ? "" : String(x));
      let cur = [], prevW = null, rot = 0, idx = 0, sm = 0, sn = 0;
      ev.filter((e) => e.s === s).forEach((e) => {
        if (e.k === "sub") {
          const i = court.indexOf(String(e.out));
          if (i >= 0) court[i] = String(e.in); else warnings.push({ t: e.t, s, text: "Замена: №" + e.out + " не на площадке" });
          return;
        }
        if (e.k === "lineup") { court = (e.court || []).map(String); return; }
        if (e.k === "brk") { breaks.push({ id: e.id, s, t: e.t, kind: e.kind, at: rallies.length, score: [sm, sn] }); return; }
        cur.push(e);
        const w = winOf(e);
        if (w) {
          const hasS = cur.some((x) => x.k === "act" && x.a === "S");
          const srv = prevW == null ? (hasS ? "M" : "N") : prevW;
          idx++;
          rallies.push({ set: s, ev: cur, w, end: e, t: e.t, court: court.filter(Boolean), zones: court.slice(), srv, rot, idx, before: [sm, sn] });
          if (w === "M") sm++; else sn++;
          if (w === "M" && srv === "N" && court.length === 6) { court = court.slice(1).concat(court[0]); rot++; }
          prevW = w;
          cur = [];
        }
      });
    });
    rallies.forEach((r) => {
      r.acts = r.ev.filter((e) => e.k === "act");
      r.part = new Set(r.acts.map((e) => e.p));
      r.acts.forEach((e) => {
        if (r.court.length && r.court.indexOf(e.p) < 0) warnings.push({ t: e.t, s: r.set, text: "№" + e.p + " отмечена, но по составу не на площадке" });
      });
    });
    // что было после перерыва
    breaks.forEach((b) => {
      const prev = rallies.slice(0, b.at).filter((r) => r.set === b.s);
      const next = rallies.slice(b.at).filter((r) => r.set === b.s);
      let run = 0, who = null;
      for (let i = prev.length - 1; i >= 0; i--) { if (who == null) who = prev[i].w; if (prev[i].w !== who) break; run++; }
      b.runBefore = who ? { w: who, n: run } : null;
      b.next1 = next[0] ? next[0].w : null;
      b.next3 = next.slice(0, 3).filter((r) => r.w === "M").length; b.next3n = Math.min(3, next.length);
      if (next[0]) next[0].afterBreak = b.kind;
    });
    return { rallies, sets, warnings, breaks };
  }

  function possessions(evs) {
    const P = [];
    let brk = false;
    evs.forEach((e) => {
      if (e.k === "opp") { brk = true; return; }
      if (e.k !== "act") return;
      if (!P.length || "SRDB".indexOf(e.a) >= 0 || brk) P.push([e]); else P[P.length - 1].push(e);
      brk = e.r === ">" || e.r === "<";   // мяч ушёл на сторону соперника — владение закончено; «от блока к себе» — новое владение с нуля
    });
    return P;
  }

  function possValues(poss, terminal, R, start) {
    let st = start || 0; const out = [];
    poss.forEach((e, k) => {
      if (k === poss.length - 1) out.push([e.p, terminal - st, e]);
      else {
        const c = code(e);
        const ns = Object.prototype.hasOwnProperty.call(R.state, c) ? R.state[c] : (c === "S0" || c === "B+" ? 0 : st);
        out.push([e.p, ns - st, e]); st = ns;
      }
    });
    return out;
  }

  function onCourt(r) {
    const oc = r.court.filter(Boolean).slice(0, 6);
    r.part.forEach((p) => { if (oc.indexOf(p) < 0) oc.push(p); });
    return oc;
  }

  function rallyShares(r, R) {
    const sh = {}, tv = [];   // tv — вклад каждого касания отдельно (без долей «на всех»)
    const add = (p, v, e) => { sh[p] = (sh[p] || 0) + v; if (e) tv.push({ e, v }); };
    const P = possessions(r.ev);
    const end = r.end;
    let final = P.length ? P[P.length - 1] : [];
    let nonfinal = end.k === "act" ? P.slice(0, -1) : P.slice();
    const overEnd = P.length && P[P.length - 1][P[P.length - 1].length - 1].r === ">";   // наш мяч ушёл к сопернику, ошибся уже он
    if (end.k === "pt" && r.w === "M" && P.length && !overEnd && !(P[P.length - 1].length === 1 && P[P.length - 1][0].a === "S")) {
      nonfinal = P.slice(0, -1); final = P[P.length - 1];
    } else if (end.k === "pt") final = [];
    // «на сторону соперника»: владение кончается на −p, следующее наше владение начинается с −p (долг)
    const lastOf = (poss) => poss[poss.length - 1];
    const penOf = (poss) => { const l = lastOf(poss); return l && l.r === ">" ? (R.overPen[l.a] || 0) : 0; };
    let carry = 0;
    nonfinal.forEach((poss) => { const pen = penOf(poss); possValues(poss, -pen, R, carry).forEach(([p, v, e]) => add(p, v, e)); carry = -pen; });
    const oc = onCourt(r);
    const team = (x) => oc.forEach((p) => add(p, x / oc.length));
    let mode;
    if (r.w === "M") {
      if (final.length) { mode = "выигран: изменения состояния, последнее касание доводит до +1"; possValues(final, 1, R, carry).forEach(([p, v, e]) => add(p, v, e)); }
      else { mode = "выигран: ошибка соперника без касаний — поровну на площадке"; team(1 - carry); }
    } else {
      if (end.k === "pt" || !final.length) { mode = "проигран: очко соперника его действием — поровну на площадке"; team(-1 - carry); }
      else if (code(end) === "D=" && final.length === 1) {
        mode = "проигран: не поднята атака — защитник и остальные";
        const k = 1 + carry;   // долг уменьшает потерю
        add(end.p, -R.digMissOwn * k, end);
        const others = oc.filter((p) => p !== end.p).slice(0, 5);
        others.forEach((p) => add(p, -(1 - R.digMissOwn) * k / others.length));
      } else { mode = "проигран: изменения состояния, ошибка доводит до −1"; possValues(final, -1, R, carry).forEach(([p, v, e]) => add(p, v, e)); }
    }
    if (carry && (end.k === "pt" || !final.length)) mode += " (с учётом долга за мяч на сторону соперника)";
    return { sh, mode, tv };
  }

  function emptyCounts() { return {}; }
  const inc = (o, k, n) => { o[k] = (o[k] || 0) + (n == null ? 1 : n); };

  function playerCounts(acts) {
    const c = emptyCounts();
    acts.forEach((e) => { inc(c, e.a); inc(c, e.a + e.r); });
    const g = (k) => c[k] || 0;
    c.Dup = g("D#") + g("D+") + g("D-") + g("D>");
    c.over = g("R>") + g("D>") + g("E>");
    c.pts = g("S#") + g("A#") + g("C#") + g("B#") + g("F#");
    c.err = g("S=") + g("R=") + g("A/") + g("A=") + g("C/") + g("C=") + g("B=") + g("D=") + g("E=") + g("X=") + g("F=");
    c.actions = acts.length;
    return c;
  }

  const POINT_CATS = [
    ["M", "Атака"], ["M", "Эйсы"], ["M", "Блок"], ["M", "Ошибки соперника"],
    ["N", "Атака соперника"], ["N", "Эйс соперника"], ["N", "Блок соперника"], ["N", "Прочее (соперник)"],
    ["N", "Ошибки атаки"], ["N", "Ошибки подачи"], ["N", "Ошибки паса"], ["N", "Ошибки блока"]
  ];
  function pointCat(e) {
    if (e.k === "pt") {
      if (e.w === "M") return ["M", "Ошибки соперника"];
      return ["N", { att: "Атака соперника", ace: "Эйс соперника", blk: "Блок соперника" }[e.why] || "Прочее (соперник)"];
    }
    return ({
      "S#": ["M", "Эйсы"], "A#": ["M", "Атака"], "C#": ["M", "Атака"], "F#": ["M", "Атака"], "B#": ["M", "Блок"],
      "S=": ["N", "Ошибки подачи"], "A=": ["N", "Ошибки атаки"], "C=": ["N", "Ошибки атаки"], "F=": ["N", "Ошибки атаки"], "A/": ["N", "Блок соперника"], "C/": ["N", "Блок соперника"],
      "R=": ["N", "Эйс соперника"], "D=": ["N", "Атака соперника"], "B=": ["N", "Ошибки блока"], "E=": ["N", "Ошибки паса"], "X=": ["N", "Ошибки атаки"]
    })[code(e)] || null;
  }

  function compute(match) {
    const R = mergeRules(match.rules);
    const { rallies, sets, warnings, breaks } = buildRallies(match);
    const nSets = R.setsDenominator || sets.length || 1;
    // ---- партии
    const setRows = sets.map((s) => {
      const RS = rallies.filter((r) => r.set === s);
      let m = 0, n = 0, prev = null, runM = 0, runN = 0, cur = null, L = 0;
      const prog = [];
      let Mserve = 0, Mbreak = 0, Msideout = 0, Nbreak = 0, Nsideout = 0;
      RS.forEach((r, i) => {
        const hasS = r.acts.some((e) => e.a === "S");
        const srv = prev == null ? (hasS ? "M" : "N") : prev;
        if (r.w === "M") m++; else n++;
        if (srv === "M") { Mserve++; if (r.w === "M") Mbreak++; else Nsideout++; }
        else { if (r.w === "M") Msideout++; else Nbreak++; }
        L = r.w === cur ? L + 1 : 1; cur = r.w;
        if (r.w === "M") runM = Math.max(runM, L); else runN = Math.max(runN, L);
        prog.push({ set: s, rally: i + 1, M: m, N: n, diff: m - n, winner: r.w, t: r.t });
        prev = r.w;
      });
      const evs = (match.events || []).filter((e) => e.s === s && (e.k === "act" || e.k === "pt"));
      const minutes = evs.length ? Math.round((evs[evs.length - 1].t - evs[0].t) / 6) / 10 : 0;
      const toM = breaks.filter((b) => b.s === s && b.kind === "toM").length, toN = breaks.filter((b) => b.s === s && b.kind === "toN").length;
      return { set: s, M: m, N: n, minutes, toM, toN, Mserve, Mbreak, Mrecv: RS.length - Mserve, Msideout, Nbreak, Nsideout, runM, runN, prog };
    });
    // ---- игроки
    const acts = (match.events || []).filter((e) => e.k === "act");
    const nums = Array.from(new Set(acts.map((e) => e.p).concat((match.roster || []).map((x) => String(x.num))))).filter((p) => acts.some((e) => e.p === p));
    const players = {};
    nums.forEach((p) => { players[p] = playerCounts(acts.filter((e) => e.p === p)); });
    const byset = {};
    nums.forEach((p) => sets.forEach((s) => { byset[p + "|" + s] = playerCounts(acts.filter((e) => e.p === p && e.s === s)); }));
    const team = playerCounts(acts);
    // ---- источники очков
    const pts = {};
    POINT_CATS.forEach(([t, c]) => { pts[t + "|" + c] = {}; });
    (match.events || []).forEach((e) => {
      if (e.k !== "act" && e.k !== "pt") return;
      if (!winOf(e)) return;
      const c = pointCat(e); if (!c) return;
      const key = c[0] + "|" + c[1]; pts[key] = pts[key] || {}; inc(pts[key], e.s);
    });
    // ---- вклад
    const contrib = {};
    const C = (p) => (contrib[p] = contrib[p] || { idx: 0, touchIdx: 0, pos: 0, neg: 0, bySet: {}, touches: 0, oncourt: 0, part: 0, list: [] });
    const touchVals = [];
    const rallyRows = [];
    rallies.forEach((r, i) => {
      const { sh, mode, tv } = rallyShares(r, R);
      r.share = sh; r.mode = mode;
      tv.forEach(({ e, v }) => { const c = C(e.p); c.touchIdx += v; touchVals.push({ p: String(e.p), a: e.a, r: e.r, v, set: r.set, id: e.id }); });
      onCourt(r).forEach((p) => { C(p).oncourt++; });
      const partSet = new Set(Array.from(r.part));
      // «с участием» — только розыгрыши, где игрок сам касался мяча (доля очка без касания не считается)
      partSet.forEach((p) => { C(p).part++; });
      Object.keys(sh).forEach((p) => {
        const v = sh[p], c = C(p);
        c.idx += v; inc(c.bySet, r.set, v); if (v > 0) c.pos += v; else c.neg += v;
      });
      rallyRows.push({ n: i + 1, set: r.set, t: r.t, w: r.w, mode, share: sh, acts: r.acts.map((e) => [e.p, code(e)]), court: onCourt(r),
        idx: r.idx, before: r.before, srv: r.srv, zones: r.zones, rot: r.rot, ev: r.acts.map((e) => ({ id: e.id, p: e.p, a: e.a, r: e.r, t: e.t, mid: e.mid })), mid: r.end.mid, endId: r.end.id });
    });
    acts.forEach((e) => { C(e.p).touches++; });
    const totIdx = Object.values(contrib).reduce((a, c) => a + c.idx, 0);
    const totOn = Object.values(contrib).reduce((a, c) => a + c.oncourt, 0);
    const mu = totOn ? totIdx / totOn : 0;
    Object.keys(contrib).forEach((p) => {
      const c = contrib[p];
      c.perPart = c.part ? c.idx / c.part : null;
      c.perCourt = c.oncourt ? c.idx / c.oncourt : null;
      c.touchPerRally = c.oncourt ? c.touches / c.oncourt : null;
      c.voa = c.idx - mu * c.oncourt;
      c.eligible = c.oncourt >= R.threshold;
    });
    const elig = Object.keys(contrib).filter((p) => contrib[p].eligible);
    Object.keys(contrib).forEach((p) => {
      const c = contrib[p];
      c.place = c.eligible ? 1 + elig.filter((q) => contrib[q].perPart > c.perPart + 1e-12).length : null;
    });
    // ---- полезность
    const w = R.w;
    const value = {};
    Object.keys(players).forEach((p) => {
      const o = players[p], g = (k) => o[k] || 0;
      const setsPlayed = sets.filter((s) => (byset[p + "|" + s] || {}).actions > 0).length;
      const pcr = g("A#") + g("B#") + g("S#") + g("F#") + w.e3 * g("E#") + w.r3 * g("R#") + w.r2 * g("R+") - (g("A=") + g("A/") + g("S=") + g("E=") + g("B=") + g("F="));
      const full = (o.pts - o.err) + w.r3 * g("R#") + w.r2 * g("R+") + w.e3 * g("E#") + w.e2 * g("E+") + w.dig * o.Dup + w.btouch * g("B+");
      value[p] = {
        sets: setsPlayed, pts: o.pts, wl: o.pts - o.err, pcr, full,
        pcrPerSet: setsPlayed ? pcr / setsPlayed : null, fullPerSet: setsPlayed ? full / setsPlayed : null,
        visSpike: (g("A") + g("C")) ? (g("A#") + g("C#") - g("A/") - g("A=") - g("C/") - g("C=")) / (g("A") + g("C")) : null, A: g("A") + g("C"),
        visRecv: g("R") ? (g("R#") - g("R=")) / g("R") : null, R: g("R"),
        srvEff: g("S") ? (g("S#") - g("S=")) / g("S") : null, S: g("S"),
        acePS: g("S#") / nSets, blkPS: g("B#") / nSets, digPS: o.Dup / nSets, setPS: g("E#") / nSets,
        oncourt: (contrib[p] || {}).oncourt || 0
      };
    });
    const velig = Object.keys(value).filter((p) => value[p].oncourt >= R.threshold);
    const rk = (p, k) => 1 + velig.filter((q) => value[q][k] > value[p][k] + 1e-12).length;
    Object.keys(value).forEach((p) => {
      const v = value[p];
      v.avgRank = v.oncourt >= R.threshold ? (rk(p, "pts") + rk(p, "wl") + rk(p, "pcr") + rk(p, "full")) / 4 : null;
    });
    Object.keys(value).forEach((p) => {
      const v = value[p];
      v.place = v.avgRank == null ? null : 1 + velig.filter((q) => value[q].avgRank < v.avgRank - 1e-12).length;
    });
    // ---- сайд-аут по качеству приёма (FBSO)
    const fb = {}, fbP = {};
    const FB = (o, g) => (o[g] = o[g] || { g, n: 0, fbso: 0, so: 0, atk: 0, atkErr: 0, noAtk: 0 });
    rallies.forEach((r) => {
      if (r.srv !== "N") return;
      const P = possessions(r.ev);
      const pi = P.findIndex((ps) => ps.some((e) => e.a === "R"));
      if (pi < 0) return;
      const rec = P[pi].find((e) => e.a === "R");
      const after = P[pi].slice(P[pi].indexOf(rec) + 1);
      const atk = after.find((e) => e.a === "A" || e.a === "F" || e.a === "C");
      [FB(fb, rec.r), FB((fbP[rec.p] = fbP[rec.p] || {}), rec.r)].forEach((o) => {
        o.n++;
        if (r.w === "M") o.so++;
        if (atk) { o.atk++; if (atk.r === "#") o.fbso++; if (atk.r === "=" || atk.r === "/") o.atkErr++; } else o.noAtk++;
      });
    });
    const an = analytics(match, rallyRows);
    Object.keys(contrib).forEach((p) => { contrib[p].passive = contrib[p].idx - contrib[p].touchIdx; });
    return { rules: R, sets, nSets, setRows, players, byset, team, points: pts, POINT_CATS, contrib, mu, rallies: rallyRows, value, warnings, touchVals,
      breaks, fbso: fb, fbsoByPlayer: fbP, roles: an.roles, rotations: an.rotations, rotTeam: an.rotTeam, rotMode: an.rotMode, attacks: an.attacks, lanes: an.lanes };
  }

  /* ---------- амплуа, расстановки, направления атак ---------- */
  const ROLES = [["", "не задано"], ["S", "Связующий"], ["OH", "Доигровщик"], ["MB", "Центральный"], ["OPP", "Диагональный"], ["L", "Либеро"], ["U", "Универсал"]];
  const ZONES = ["I", "II", "III", "IV", "V", "VI"];
  const LANES = ["Диагональ", "Пайп", "Центр", "Доигровщик", "Скидка", "Связующий", "Не задано"];
  function laneOf(role, zi) {
    const front = zi >= 1 && zi <= 3 ? true : zi >= 0 ? false : null;
    if (role === "OPP") return "Диагональ";
    if (role === "MB") return front === false ? "Пайп" : "Центр";
    if (role === "OH" || role === "U") return front === false ? "Пайп" : "Доигровщик";
    if (role === "S") return "Связующий";
    return "Не задано";
  }
  function analytics(match, rallies) {
    const roles = {};
    (match.roster || []).forEach((x) => { if (x.role) roles[String(x.num)] = x.role; });
    const hasSetter = rallies.some((r) => r.zones.length === 6 && r.zones.some((p) => roles[p] === "S"));
    const rotMode = hasSetter ? "setter" : "start";
    const rot = {};
    const team = { n: 0, won: 0, srvN: 0, srvWon: 0, rcvN: 0, rcvWon: 0 };
    rallies.forEach((r) => {
      if (r.zones.filter(Boolean).length < 6) { r.rotKey = null; return; }
      let key, label;
      const si = hasSetter ? r.zones.findIndex((p) => roles[p] === "S") : -1;
      if (hasSetter && si >= 0) { key = "S" + (si + 1); label = "Связующий в зоне " + ZONES[si]; }
      else if (hasSetter) { key = "S0"; label = "Без связующего на площадке"; }
      else { key = "R" + (r.rot % 6 + 1); label = "Расстановка " + (r.rot % 6 + 1) + " от стартовой"; }
      r.rotKey = key;
      const o = rot[key] = rot[key] || { key, label, n: 0, won: 0, srvN: 0, srvWon: 0, rcvN: 0, rcvWon: 0, A: 0, Ak: 0, Ae: 0, R: 0, Rp: 0, Re: 0, S: 0, Sa: 0, Se: 0, six: {} };
      const win = r.w === "M" ? 1 : 0;
      o.n++; o.won += win; team.n++; team.won += win;
      if (r.srv === "M") { o.srvN++; o.srvWon += win; team.srvN++; team.srvWon += win; } else { o.rcvN++; o.rcvWon += win; team.rcvN++; team.rcvWon += win; }
      r.ev.forEach((e) => {
        if (e.a === "A" || e.a === "C") { o.A++; if (e.r === "#") o.Ak++; if (e.r === "=" || e.r === "/") o.Ae++; }
        if (e.a === "R") { o.R++; if (e.r === "#" || e.r === "+") o.Rp++; if (e.r === "=") o.Re++; }
        if (e.a === "S") { o.S++; if (e.r === "#") o.Sa++; if (e.r === "=") o.Se++; }
      });
      const sk = r.zones.join("-"); o.six[sk] = (o.six[sk] || 0) + 1;
    });
    const avg = team.n ? (2 * team.won - team.n) / team.n : 0;
    const tSO = team.rcvN ? team.rcvWon / team.rcvN : null, tBP = team.srvN ? team.srvWon / team.srvN : null;
    const rotations = Object.values(rot).map((o) => {
      o.lost = o.n - o.won; o.diff = o.won - o.lost; o.perRally = o.n ? o.diff / o.n : 0;
      o.so = o.rcvN ? o.rcvWon / o.rcvN : null; o.bp = o.srvN ? o.srvWon / o.srvN : null;
      o.aEff = o.A ? (o.Ak - o.Ae) / o.A : null; o.rPos = o.R ? o.Rp / o.R : null;
      o.rating = o.n < 6 ? "мало данных" : o.perRally - avg >= 0.15 ? "сильная" : o.perRally - avg <= -0.15 ? "слабая" : "средняя";
      const notes = [];
      if (o.so != null && tSO != null && o.rcvN >= 4) { const d = o.so - tSO; if (Math.abs(d) >= 0.1) notes.push("сайд-аут " + (d > 0 ? "+" : "−") + Math.round(Math.abs(d) * 100) + " п.п."); }
      if (o.bp != null && tBP != null && o.srvN >= 4) { const d = o.bp - tBP; if (Math.abs(d) >= 0.1) notes.push("брейк " + (d > 0 ? "+" : "−") + Math.round(Math.abs(d) * 100) + " п.п."); }
      o.note = notes.join(", ");
      const top = Object.entries(o.six).sort((a, b) => b[1] - a[1])[0];
      o.mainSix = top ? top[0].split("-") : [];
      o.mainSixShare = top ? top[1] / o.n : 0;
      return o;
    }).sort((a, b) => a.key.localeCompare(b.key));
    const rotTeam = { n: team.n, perRally: avg, so: tSO, bp: tBP };
    // атаки по направлениям
    const attacks = [];
    rallies.forEach((r, gi) => r.ev.forEach((e) => {
      if (e.a !== "A" && e.a !== "C") return;
      const zi = r.zones.length === 6 ? r.zones.indexOf(e.p) : -1;
      attacks.push({ id: e.id, gi, set: r.set, idx: r.idx, t: e.t, mid: e.mid, p: e.p, r: e.r, lane: e.a === "C" ? "Скидка" : laneOf(roles[e.p], zi), row: zi < 0 ? "" : (zi >= 1 && zi <= 3 ? "передняя" : "задняя") });
    }));
    const lanes = LANES.filter((l, i) => i < 4 || attacks.some((a) => a.lane === l));
    return { roles, rotations, rotTeam, rotMode, attacks, lanes };
  }

  /* Объединение нескольких матчей в один «виртуальный»: партии нумеруются подряд. */
  function mergeMatches(list) {
    const out = { id: "merged", meta: { us: (list[0] && list[0].meta.us) || "Наша команда", them: "Соперники (" + list.length + " матча)", date: "" },
      roster: [], lineups: {}, rules: list[0] ? list[0].rules : null, events: [], setLabels: {}, setMatch: {} };
    const ros = {};
    let off = 0;
    list.forEach((m, k) => {
      (m.roster || []).forEach((x) => { const n = String(x.num); const o = ros[n] = ros[n] || { num: x.num, name: "", role: "" }; if (!o.name && x.name) o.name = x.name; if (!o.role && x.role) o.role = x.role; });
      const sets = Array.from(new Set((m.events || []).map((e) => e.s))).sort((a, b) => a - b);
      const map = {};
      sets.forEach((s) => { off++; map[s] = off; out.setLabels[off] = "М" + (k + 1) + "·П" + s; out.setMatch[off] = { id: m.id, s, title: m.meta.them || "" }; if ((m.lineups || {})[s]) out.lineups[off] = m.lineups[s].slice(); });
      (m.events || []).forEach((e) => { out.events.push(Object.assign({}, e, { s: map[e.s], mid: m.id })); });
    });
    out.roster = Object.values(ros);
    return out;
  }

  /* Проверки разметки: подсказки, а не запреты. */
  /* Записи, стоящие в журнале позже, чем по времени: время раньше конца предыдущего розыгрыша. */
  function misplaced(match) {
    const out = []; const lastPt = {};
    (match.events || []).forEach((e) => {
      if (e.k !== "act" && e.k !== "pt" && e.k !== "opp") return;
      const lp = lastPt[e.s];
      if (lp != null && e.t < lp - 3) out.push(e);
      if (winOf(e)) lastPt[e.s] = Math.max(lp == null ? -Infinity : lp, e.t);
    });
    return out;
  }
  function check(match) {
    const out = [];
    misplaced(match).forEach((e) => out.push({ t: e.t, s: e.s, id: e.id, key: "order:" + e.id, fix: "order", text: "Запись стоит не на своём месте: по времени она раньше уже завершённого розыгрыша" }));
    const { rallies, warnings } = buildRallies(match);
    warnings.forEach((w) => out.push(Object.assign({ key: "warn:" + w.s + ":" + w.t + ":" + w.text }, w)));
    const AN = { S: "подача", R: "приём", A: "атака", C: "скидка", B: "блок", D: "защита", E: "пас", F: "переброс", X: "прочая ошибка" };
    rallies.forEach((r) => {
      // розыгрыш начинается с нашей подачи или с приёма подачи соперника (или с ошибки вне игры)
      const acts = r.ev.filter((e) => e.k === "act");
      if (acts.length && "SRX".indexOf(acts[0].a) < 0)
        out.push({ t: acts[0].t, s: r.set, id: acts[0].id, key: "start:" + acts[0].id, text: "Розыгрыш начинается не с подачи и не с приёма: №" + acts[0].p + ", " + (AN[acts[0].a] || acts[0].a) + ". Возможно, пропущена запись подачи или приёма, или очко в конце прошлого розыгрыша" });
      acts.slice(1).forEach((e) => { if (e.a === "R") out.push({ t: e.t, s: r.set, id: e.id, key: "recv:" + e.id, text: "№" + e.p + ": приём не в начале розыгрыша. Приём бывает только первым касанием после подачи соперника — возможно, это защита, или перед ним пропущено очко" }); });
      let prev = null;
      r.ev.forEach((b) => {
        if (b.k === "opp") { prev = null; return; }
        if (b.k !== "act") return;
        const a = prev; prev = b;
        if (!a) return;
        const overNet = a.a === "S" || a.a === "B" || ((a.a === "A" || a.a === "F" || a.a === "C") && a.r === "0") || a.r === ">" || a.r === "<";
        if (overNet) return;
        if (a.p === b.p) out.push({ t: b.t, s: r.set, id: b.id, key: "dbl:" + b.id, text: "№" + b.p + ": два касания подряд" });
        if ((a.a === "R" || a.a === "D") && "#+-".indexOf(a.r) >= 0 && b.a === "A") out.push({ t: b.t, s: r.set, id: b.id, key: "nopass:" + b.id, text: "Атака сразу после " + (a.a === "R" ? "приёма" : "защиты") + " — пропущен пас?" });
      });
    });
    const ok = match.checksOk || {};
    return out.filter((c) => !ok[c.key]);
  }

  /* ---------- Статистика за несколько матчей ----------
     Сравнимые между матчами показатели: только вклад собственных касаний (без долей «на всех»),
     в расчёте на касание; «над партнёрами» — каждое касание минус среднее партнёров по этому же
     действию в этом же матче (без самого игрока); проценты — с поправкой на тех же партнёров.
     Уровень соперника — отметка тренера или авто по доле выигранных очков. */
  const LEVELS = [["strong", "Сильный"], ["equal", "Равный"], ["weak", "Слабый"]];
  const SKILL_OF = { C: "A" };
  const RATES = {
    R: { name: "Приём", codes: ["R"], rates: [["pos", "Позитив", (g, n) => (g("#") + g("+")) / n], ["err", "Ошибки", (g, n) => g("=") / n, true]] },
    A: { name: "Атака", codes: ["A", "C"], rates: [["eff", "Эффективность", (g, n) => (g("#") - g("/") - g("=")) / n], ["kill", "Очко", (g, n) => g("#") / n]] },
    S: { name: "Подача", codes: ["S"], rates: [["eff", "Эффективность", (g, n) => (g("#") - g("=")) / n], ["err", "Ошибки", (g, n) => g("=") / n, true]] },
    D: { name: "Защита", codes: ["D"], rates: [["up", "Поднято", (g, n) => (n - g("=")) / n]] },
    E: { name: "Пас", codes: ["E"], rates: [["good", "Отл. + норм.", (g, n) => (g("#") + g("+")) / n]] }
  };
  function autoLevel(r) { const M = r.setRows.reduce((a, s) => a + s.M, 0), N = r.setRows.reduce((a, s) => a + s.N, 0); const sh = M + N ? M / (M + N) : 0.5; return sh >= 0.56 ? "weak" : sh <= 0.44 ? "strong" : "equal"; }
  function multi(list, MIN) {
    MIN = MIN || 30;
    const P = {}, team = {}, matchesOut = [];
    const PL = (p) => (P[p] = P[p] || { p, matches: 0, n: 0, v: 0, relSum: 0, relN: 0, oncourt: 0, B: 0, Bt: 0, byLevel: {}, perMatch: [], rates: {} });
    list.forEach(({ m, level }) => {
      const r = compute(m);
      const M = r.setRows.reduce((a, s) => a + s.M, 0), N = r.setRows.reduce((a, s) => a + s.N, 0);
      const auto = autoLevel(r), lv = level || auto;
      const sum = (k) => r.setRows.reduce((a, s) => a + (s[k] || 0), 0);
      const mo = { id: m.id, date: m.meta.date || "", us: m.meta.us, them: m.meta.them || "", level: level || "", auto, lv, M, N, share: M + N ? M / (M + N) : null,
        sets: r.setRows.map((s) => s.M + ":" + s.N), setsW: r.setRows.filter((s) => s.M > s.N).length, setsL: r.setRows.filter((s) => s.N > s.M).length,
        so: sum("Mrecv") ? sum("Msideout") / sum("Mrecv") : null, br: sum("Mserve") ? sum("Mbreak") / sum("Mserve") : null, soN: sum("Mrecv"), brN: sum("Mserve"), touches: r.touchVals.length };
      matchesOut.push(mo);
      // среднее по каждому действию в матче: сумма и число касаний — всего и по игрокам
      const sk = {}, skp = {};
      r.touchVals.forEach((t) => { const a = SKILL_OF[t.a] || t.a; const o = sk[a] = sk[a] || { s: 0, n: 0 }; o.s += t.v; o.n++; const q = skp[t.p + "|" + a] = skp[t.p + "|" + a] || { s: 0, n: 0 }; q.s += t.v; q.n++; });
      const pm = {};
      r.touchVals.forEach((t) => {
        const a = SKILL_OF[t.a] || t.a, all = sk[a], me = skp[t.p + "|" + a], on = all.n - me.n;
        const x = pm[t.p] = pm[t.p] || { n: 0, v: 0, relSum: 0, relN: 0 }; x.n++; x.v += t.v;
        if (on >= 3 && me.n / all.n <= 0.6) { x.relSum += t.v - (all.s - me.s) / on; x.relN++; }   // игрок, сделавший больше 60% таких действий команды, сравнивать не с кем
      });
      // счётчики результатов по действиям — для процентов с поправкой на партнёров
      const cnt = {}; m.events.forEach((e) => { if (e.k !== "act") return; const k = String(e.p); const c = cnt[k] = cnt[k] || {}; c[e.a] = (c[e.a] || 0) + 1; c[e.a + e.r] = (c[e.a + e.r] || 0) + 1; });
      const tot = {}; Object.values(cnt).forEach((c) => Object.keys(c).forEach((k) => { tot[k] = (tot[k] || 0) + c[k]; }));
      Array.from(new Set(Object.keys(pm).concat(Object.keys(cnt)))).forEach((p) => {
        const pl = PL(p), x = pm[p] || { n: 0, v: 0, relSum: 0, relN: 0 }, c = cnt[p] || {};
        const con = r.contrib[p] || r.contrib[+p] || {};
        if (!x.n && !(con.oncourt)) return;
        pl.matches++; pl.n += x.n; pl.v += x.v; pl.relSum += x.relSum; pl.relN += x.relN; pl.oncourt += con.oncourt || 0;
        pl.B += c["B#"] || 0; pl.Bt += c["B+"] || 0;
        const L = pl.byLevel[lv] = pl.byLevel[lv] || { n: 0, relSum: 0, relN: 0, v: 0 }; L.n += x.n; L.v += x.v; L.relSum += x.relSum; L.relN += x.relN;
        pl.perMatch.push({ id: m.id, n: x.n, v: x.n ? x.v / x.n : null, rel: x.relN ? x.relSum / x.relN : null, relN: x.relN });
        Object.keys(RATES).forEach((key) => {
          const D = RATES[key], g = (o) => (res) => D.codes.reduce((a, cd) => a + (o[cd + res] || 0), 0), n = D.codes.reduce((a, cd) => a + (c[cd] || 0), 0);
          if (!n) return;
          const others = {}; Object.keys(tot).forEach((k) => { others[k] = tot[k] - (c[k] || 0); });
          const no = D.codes.reduce((a, cd) => a + (others[cd] || 0), 0);
          const R0 = pl.rates[key] = pl.rates[key] || { n: 0, cnt: {}, dW: {}, dN: 0 };
          R0.n += n; D.codes.forEach((cd) => Object.keys(c).forEach((k) => { if (k.indexOf(cd) === 0) R0.cnt[k] = (R0.cnt[k] || 0) + c[k]; }));
          if (no >= 3 && n / (n + no) <= 0.6) { R0.dN += n; D.rates.forEach(([rk, , f]) => { R0.dW[rk] = (R0.dW[rk] || 0) + n * (f(g(c), n) - f(g(others), no)); }); }
        });
      });
      // команда по уровню
      const T = team[lv] = team[lv] || { matches: 0, M: 0, N: 0, so: 0, soN: 0, br: 0, brN: 0, cnt: {} };
      T.matches++; T.M += M; T.N += N; T.so += sum("Msideout"); T.soN += sum("Mrecv"); T.br += sum("Mbreak"); T.brN += sum("Mserve");
      Object.keys(tot).forEach((k) => { T.cnt[k] = (T.cnt[k] || 0) + tot[k]; });
    });
    const players = Object.values(P).map((pl) => {
      const o = Object.assign({}, pl, { perTouch: pl.n ? pl.v / pl.n : null, rel: pl.relN ? pl.relSum / pl.relN : null, cover: pl.n ? pl.relN / pl.n : null, small: pl.relN < MIN,
        blk10: pl.oncourt ? (pl.B) / pl.oncourt * 10 : null, blkT10: pl.oncourt ? (pl.B + pl.Bt) / pl.oncourt * 10 : null });
      Object.keys(o.byLevel).forEach((k) => { const L = o.byLevel[k]; L.rel = L.relN ? L.relSum / L.relN : null; L.small = L.relN < MIN / 2; });
      Object.keys(o.rates).forEach((key) => { const R0 = o.rates[key], D = RATES[key], g = (res) => D.codes.reduce((a, cd) => a + (R0.cnt[cd + res] || 0), 0);
        R0.val = {}; R0.delta = {}; D.rates.forEach(([rk, , f]) => { R0.val[rk] = f(g, R0.n); R0.delta[rk] = R0.dN ? R0.dW[rk] / R0.dN : null; }); });
      return o; });
    const ranked = players.filter((x) => !x.small && x.rel != null).sort((a, b) => b.rel - a.rel);
    ranked.forEach((x, i) => { x.place = i + 1; });
    Object.values(team).forEach((T) => { const g = (k) => T.cnt[k] || 0; const nA = g("A") + g("C");
      T.share = T.M + T.N ? T.M / (T.M + T.N) : null; T.soR = T.soN ? T.so / T.soN : null; T.brR = T.brN ? T.br / T.brN : null;
      T.rPos = g("R") ? (g("R#") + g("R+")) / g("R") : null; T.aEff = nA ? (g("A#") + g("C#") - g("A/") - g("C/") - g("A=") - g("C=")) / nA : null; T.sEff = g("S") ? (g("S#") - g("S=")) / g("S") : null; });
    return { matches: matchesOut, players, team, MIN, LEVELS, RATES };
  }

  const api = { multi, autoLevel, LEVELS, DEFAULT_RULES, mergeRules, compute, check, buildRallies, POINT_CATS, WIN, code, winOf, ROLES, ZONES, LANES, laneOf, mergeMatches, misplaced };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.VStats = api;
})(typeof window !== "undefined" ? window : this);
