// Corte quincenal de horas por aseadora.
// Vercel lo ejecuta solo el día 1 y el 16 a las 7:00 a. m. (hora Colombia), según vercel.json.
// Lee las limpiezas de Firestore, arma una tabla por aseadora y día, y la envía por correo
// (con el Excel adjunto) usando Resend.
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   RESEND_API_KEY  → clave de https://resend.com (obligatoria)
//   CORTE_EMAIL     → correo que recibe el corte (obligatoria)
//   CRON_SECRET     → opcional; si existe, solo Vercel Cron puede ejecutar esta función

const PROJECT = "lavanderia-limpieza";
const API_KEY = "AIzaSyDBSqHoAc_qDQQhrOmDtdcZ7ZyyPbXv5Sg"; // la misma clave pública que usa la app
const TZ_OFFSET_MIN = -5 * 60; // Colombia, sin horario de verano

const pad2 = (n) => String(n).padStart(2, "0");
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const nowCol = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000);
const hm = (ms) => { if (!ms) return ""; const d = new Date(ms + TZ_OFFSET_MIN * 60000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const fmtDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const fmtMin = (m) => { const t = Math.max(0, Math.round(m)); const h = Math.floor(t / 60); return h ? `${h} h ${pad2(t % 60)} min` : `${t % 60} min`; };
const hDec = (min) => (min / 60).toFixed(2).replace(".", ",");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Última quincena cerrada a la fecha (Colombia)
function ultimaQuincena() {
  const t = nowCol(); const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
  if (d <= 15) { const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; return [`${py}-${pad2(pm)}-16`, `${py}-${pad2(pm)}-${pad2(lastDayOf(py, pm))}`]; }
  return [`${y}-${pad2(m)}-01`, `${y}-${pad2(m)}-15`];
}

const val = (f) => f == null ? null : f.stringValue ?? (f.integerValue != null ? Number(f.integerValue) : f.doubleValue ?? f.booleanValue ?? null);

async function leerLimpiezas(desde, hasta) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/app_data/main:runQuery?key=${API_KEY}`;
  const body = { structuredQuery: {
    from: [{ collectionId: "cleanings_log" }],
    where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: desde } } },
      { fieldFilter: { field: { fieldPath: "date" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: hasta } } },
    ] } },
  } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Firestore ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.filter((x) => x.document).map((x) => {
    const f = x.document.fields || {};
    return { date: val(f.date), employeeName: val(f.employeeName) || "SIN NOMBRE", apartmentName: val(f.apartmentName),
      startedAt: val(f.startedAt), finishedAt: val(f.finishedAt), duplicado: !!val(f.duplicado) };
  }).filter((c) => !c.duplicado);
}

// Misma lógica que la pestaña Horas de la app
function jornadas(cleanings) {
  const g = {};
  cleanings.forEach((c) => { const k = c.employeeName + "|" + c.date; (g[k] = g[k] || []).push(c); });
  return Object.entries(g).map(([k, list]) => {
    const [emp, date] = k.split("|");
    const t = list.filter((c) => c.startedAt && c.finishedAt && c.finishedAt > c.startedAt).sort((a, b) => a.startedAt - b.startedAt);
    let horas = 0, muerto = 0;
    t.forEach((c, i) => { horas += (c.finishedAt - c.startedAt) / 60000; if (i > 0) { const gap = (c.startedAt - t[i - 1].finishedAt) / 60000; if (gap > 0 && gap < 240) muerto += gap; } });
    const salida = t.length ? Math.max(...t.map((c) => c.finishedAt)) : null;
    return { emp, date, aptos: list.length, medidos: t.length, sinHora: list.length - t.length,
      entrada: t.length ? t[0].startedAt : null, salida, jornada: t.length ? (salida - t[0].startedAt) / 60000 : 0, horas, muerto };
  }).sort((a, b) => a.emp.localeCompare(b.emp) || a.date.localeCompare(b.date));
}

function csv(rows) {
  const head = ["Aseadora", "Fecha", "Entrada", "Salida", "Jornada (h)", "Horas en apartamentos (h)", "Tiempo muerto (h)", "Apartamentos", "Registros sin hora"];
  const lines = rows.map((r) => [r.emp, fmtDate(r.date), hm(r.entrada), hm(r.salida), hDec(r.jornada), hDec(r.horas), hDec(r.muerto), r.aptos, r.sinHora].join(";"));
  return "﻿" + [head.join(";"), ...lines].join("\r\n");
}

function html(rows, desde, hasta) {
  const emps = [...new Set(rows.map((r) => r.emp))];
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:1px solid #ddd;font-size:12px;color:#555"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';
  let out = `<div style="font-family:Arial,sans-serif;color:#15201b"><h2 style="margin:0 0 4px">Corte de horas · ${fmtDate(desde)} a ${fmtDate(hasta)}</h2>
    <p style="color:#666;margin:0 0 18px">Entrada = primera limpieza del día, salida = última. El Excel va adjunto.</p>`;
  if (!emps.length) out += "<p>No hubo limpiezas en esta quincena.</p>";
  emps.forEach((emp) => {
    const rs = rows.filter((r) => r.emp === emp);
    const tot = rs.reduce((a, r) => ({ j: a.j + r.jornada, h: a.h + r.horas, m: a.m + r.muerto, n: a.n + r.aptos, s: a.s + r.sinHora }), { j: 0, h: 0, m: 0, n: 0, s: 0 });
    out += `<h3 style="margin:18px 0 4px">${esc(emp)}</h3>
      <p style="margin:0 0 8px;color:#444">${rs.length} días · jornada ${fmtMin(tot.j)} · en apartamentos <b>${fmtMin(tot.h)}</b> · tiempo muerto <b style="color:#c94040">${fmtMin(tot.m)}</b> · ${tot.n} apartamentos${tot.s ? ` (${tot.s} sin hora)` : ""}</p>
      <table style="border-collapse:collapse"><tr><th ${th}>Fecha</th><th ${th}>Entrada</th><th ${th}>Salida</th><th ${th}>Jornada</th><th ${th}>En apartamentos</th><th ${th}>Tiempo muerto</th><th ${th}>Aptos</th></tr>
      ${rs.map((r) => `<tr><td ${td}>${fmtDate(r.date)}</td><td ${td}>${hm(r.entrada) || "—"}</td><td ${td}>${hm(r.salida) || "—"}</td><td ${td}>${r.medidos ? fmtMin(r.jornada) : "—"}</td><td ${td}>${r.medidos ? fmtMin(r.horas) : "—"}</td><td ${td}>${r.medidos > 1 ? fmtMin(r.muerto) : "—"}</td><td ${td}>${r.aptos}${r.sinHora ? ` (${r.sinHora} sin hora)` : ""}</td></tr>`).join("")}
      </table>`;
  });
  return out + "</div>";
}

module.exports = async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: "No autorizado" });
    const to = process.env.CORTE_EMAIL, key = process.env.RESEND_API_KEY;
    if (!to || !key) return res.status(500).json({ ok: false, error: "Faltan RESEND_API_KEY o CORTE_EMAIL en Vercel" });

    const [desde, hasta] = ultimaQuincena();
    const rows = jornadas(await leerLimpiezas(desde, hasta));
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.CORTE_FROM || "Limpieza Pro <onboarding@resend.dev>",
        to: [to],
        subject: `Corte de horas ${fmtDate(desde)} a ${fmtDate(hasta)}`,
        html: html(rows, desde, hasta),
        attachments: [{ filename: `horas_${desde}_a_${hasta}.csv`, content: Buffer.from(csv(rows), "utf8").toString("base64") }],
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ ok: false, error: "Resend no envió el correo", detalle: out });
    return res.status(200).json({ ok: true, desde, hasta, filas: rows.length, id: out.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
