// ───────────────────────────────────────────────────────────────
//  Backend - Venta de entradas "Olympia Vibra 2026"
//  ePagos (E-Checkout + verificacion por API) + generación de QR + mail.
//  Órdenes persistidas en MySQL (Sequelize).
//  Los datos del evento salen del .env (EVENTO_*) para poder
//  reusar este mismo código en otros eventos.
// ───────────────────────────────────────────────────────────────

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { randomUUID, createHmac, timingSafeEqual, scryptSync } from 'crypto'
import { construirCheckout, pagoAcreditado, epagosConfigurado, epagosEsProduccion, urlLogosPago, EPAGOS_URLS } from './epagos.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import QRCode from 'qrcode'
import nodemailer from 'nodemailer'
import { Op } from 'sequelize'
import { sequelize, Orden, Entrada, Usuario, Visita, Categoria, Coreografia, Puntaje } from './models/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '.env') })

const app = express()
app.use(cors())
app.use(express.json())
// ePagos vuelve al sitio y avisa por webhook con POST de formulario, no JSON.
app.use(express.urlencoded({ extended: true }))

// Servir el frontend (el landing) desde ../frontend  ->  http://localhost:PORT/
app.use(express.static(join(__dirname, '..', 'frontend')))

// ───── Configuración ─────
const PORT = process.env.PORT || 3010
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500'
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`
// OJO: no usar `Number(x) || def`. El 0 es falsy, así que CARGO_PCT=0 caía
// en el default y seguía cobrando el 10%. Con esto, un 0 explícito se respeta.
function numEnv(clave, porDefecto) {
  const v = process.env[clave]
  if (v === undefined || String(v).trim() === '') return porDefecto
  const n = Number(v)
  return Number.isFinite(n) ? n : porDefecto
}
const PRECIO_ENTRADA = numEnv('PRECIO_ENTRADA', 10000)
const CARGO_PCT = numEnv('CARGO_PCT', 10) // % de cargo por servicio (lo paga el comprador)
const MAX_ENTRADAS = numEnv('MAX_ENTRADAS', 20)

// ───── Datos del evento (para mails, ePagos y /health) ─────
const EVENTO_NOMBRE = process.env.EVENTO_NOMBRE || 'Olympia Vibra 2026'
const EVENTO_CUANDO = process.env.EVENTO_CUANDO || 'Sáb 12 de Septiembre'
const EVENTO_LUGAR  = process.env.EVENTO_LUGAR  || 'Nodo Tecnológico · Santiago del Estero'
const EVENTO_MAIL_FROM = process.env.EVENTO_MAIL_FROM || 'entradas@olympiavibra.com'
const IS_PROD = process.env.NODE_ENV === 'production'
const QR_SECRET = process.env.QR_SECRET || 'CAMBIAR_ESTE_SECRETO_EN_PRODUCCION'
const SCAN_TOKEN = process.env.SCAN_TOKEN || '' // token para el escaneo en puerta (staff)

// ───── Seguridad ─────
// Firma HMAC del contenido del QR → no se puede falsificar sin el secreto.
function firmarQR(base) {
  const sig = createHmac('sha256', QR_SECRET).update(base).digest('hex').slice(0, 16)
  return `${base}::${sig}`
}
function verificarQR(codigo) {
  const parts = String(codigo).split('::')
  if (parts.length < 3) return null
  const sig  = parts.pop()
  const base = parts.join('::')
  const esperado = createHmac('sha256', QR_SECRET).update(base).digest('hex').slice(0, 16)
  const a = Buffer.from(sig), b = Buffer.from(esperado)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return base // "orderId::index"
}
// Escapa HTML (para no inyectar en el mail)
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}
// Rate limiting simple en memoria, por IP
function rateLimit({ windowMs, max, msg }) {
  const hits = new Map()
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x'
    const now = Date.now()
    let rec = hits.get(ip)
    if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; hits.set(ip, rec) }
    rec.count++
    if (rec.count > max) return res.status(429).json({ error: msg || 'Demasiadas solicitudes. Probá en un momento.' })
    next()
  }
}

// ───── Auth del panel (admin / control) ─────
function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString('hex')
}
function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
// Token de sesión firmado (mini-JWT con HMAC), válido 12 h
function firmarToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url')
  const sig = createHmac('sha256', QR_SECRET).update(body).digest('base64url').slice(0, 32)
  return `${body}.${sig}`
}
function verificarToken(token) {
  const [body, sig] = String(token || '').split('.')
  if (!body || !sig) return null
  const esperado = createHmac('sha256', QR_SECRET).update(body).digest('base64url').slice(0, 32)
  const a = Buffer.from(sig), b = Buffer.from(esperado)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (p.exp && Date.now() > p.exp) return null
    return p
  } catch { return null }
}
function tokenDeReq(req) {
  return verificarToken((req.headers.authorization || '').replace(/^Bearer /, ''))
}
function requireAuth(roles) {
  return (req, res, next) => {
    const p = tokenDeReq(req)
    if (!p) return res.status(401).json({ error: 'No autorizado' })
    if (roles && !roles.includes(p.rol)) return res.status(403).json({ error: 'Sin permiso' })
    req.usuario = p
    next()
  }
}

// Carpeta donde guardamos los QR generados
const QR_DIR = join(__dirname, 'qrs')
if (!existsSync(QR_DIR)) mkdirSync(QR_DIR, { recursive: true })
app.use('/qrs', express.static(QR_DIR)) // servir las imágenes de los QR (legacy, disco efímero)

// Regenerar el QR AL VUELO desde el código firmado. Robusto ante el disco efímero de
// Render (que borra los PNG en cada deploy): mientras el código sea válido, la imagen existe.
app.get('/qr', async (req, res) => {
  try {
    const codigo = String(req.query.c || '')
    if (!verificarQR(codigo)) return res.status(400).send('QR inválido')
    const png = await QRCode.toBuffer(codigo, { width: 420, margin: 1, color: { dark: '#d6006e', light: '#ffffff' } })
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(png)
  } catch (e) {
    console.error('❌ Error generando QR al vuelo:', e?.message || e)
    res.status(500).send('Error generando QR')
  }
})

// ───── Pagos: ePagos (ver epagos.js) ─────

// ═══════════════════════════════════════════════════════════════
//  EMAIL (demo con Ethereal: genera un link para VER el mail enviado)
// ═══════════════════════════════════════════════════════════════
let _transporter = null
async function getTransporter() {
  if (_transporter) return _transporter
  // Si hay credenciales de Gmail en el .env → envío REAL a la bandeja
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false }, // evita "self-signed certificate" (antivirus/proxy local)
    })
    console.log(`📮 Email: Gmail (${process.env.EMAIL_USER})`)
  } else {
    // Fallback: Ethereal (solo preview, no llega a una bandeja real)
    const testAcc = await nodemailer.createTestAccount()
    _transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: testAcc.user, pass: testAcc.pass },
    })
    console.log('📮 Email: Ethereal (preview)')
  }
  return _transporter
}


// Mail para el que quedó a mitad de camino. Se manda UNA sola vez por
// persona: la idea es tenderle una mano, no perseguirlo.
async function enviarMailPendiente(orden) {
  const t = await getTransporter()
  const wa = 'https://wa.me/5493854414082?text=' + encodeURIComponent(
    'Hola! Quise comprar entradas para ' + EVENTO_NOMBRE + ' y no pude completar el pago.')
  const cuantas = orden.cantidad === 1 ? '1 entrada' : orden.cantidad + ' entradas'

  const info = await t.sendMail({
    from: `"${EVENTO_NOMBRE}" <${process.env.EMAIL_USER || EVENTO_MAIL_FROM}>`,
    to: orden.email,
    subject: `¿Tuviste problemas para pagar tus entradas?`,
    html: `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#2a1214;">
      <div style="background:linear-gradient(135deg,#5b1a86,#c4006b);color:#fff;padding:26px;border-radius:14px 14px 0 0;text-align:center;">
        <h1 style="margin:0;font-size:22px;">${EVENTO_NOMBRE}</h1>
        <p style="margin:6px 0 0;opacity:.9;font-size:14px;">${EVENTO_CUANDO} · ${EVENTO_LUGAR}</p>
      </div>
      <div style="border:1px solid #f0e2ea;border-top:none;border-radius:0 0 14px 14px;padding:26px;">
        <p style="font-size:16px;">Hola ${escapeHtml(String(orden.nombre).split(' ')[0])}:</p>
        <p style="font-size:15px;line-height:1.6;">
          Vimos que empezaste a comprar <b>${cuantas}</b> y el pago quedó sin completar.
          <b>No se te cobró nada.</b>
        </p>
        <p style="font-size:15px;line-height:1.6;">
          Casi siempre se traba en el mismo lugar. Cuando se abre la pantalla de pago,
          elegí <b>&ldquo;Billetera&rdquo;</b> y después <b>&ldquo;Otras billeteras&rdquo;</b>
          —no la de ePagos—. Recién ahí aparece el código QR, para escanear con
          Mercado Pago, Ualá, MODO o la app de tu banco.
        </p>
        <p style="font-size:15px;line-height:1.6;">
          Y conviene <b>comprar desde la computadora</b> —o desde otro celular— porque
          el QR lo vas a escanear con la billetera de tu teléfono.
        </p>
        <div style="text-align:center;margin:26px 0;">
          <a href="${FRONTEND_URL}" style="background:#ff1e8c;color:#fff;text-decoration:none;
             font-weight:700;padding:14px 32px;border-radius:30px;display:inline-block;">
            Retomar mi compra
          </a>
        </div>
        <div style="background:#f7f2f6;border-radius:12px;padding:16px;text-align:center;">
          <p style="margin:0 0 10px;font-size:14px;">¿Preferís que te demos una mano?</p>
          <a href="${wa}" style="background:#25D366;color:#fff;text-decoration:none;
             font-weight:700;padding:11px 26px;border-radius:24px;display:inline-block;font-size:14px;">
            Escribinos por WhatsApp
          </a>
        </div>
        <p style="font-size:12px;color:#8a7a83;margin-top:22px;text-align:center;">
          Si ya compraste tus entradas, ignorá este mensaje.
        </p>
      </div>
    </div>`,
  })
  console.log(`✉️ Recordatorio enviado a ${orden.email} (${orden.cantidad} entrada/s)`)
  return info
}

async function enviarMail(orden, qrs) {
  const t = await getTransporter()

  // El logo va adjunto (cid) porque muchos clientes de mail bloquean las
  // imágenes externas; así se ve siempre.
  const attachments = qrs.map((q, i) => ({
    filename: `entrada-${i + 1}.png`, path: q.archivo, cid: `qr${i}`,
  }))
  const logo = join(__dirname, '..', 'frontend', 'assets', 'logo-bellatrix.jpg')
  if (existsSync(logo)) attachments.push({ filename: 'bellatrix.jpg', path: logo, cid: 'logo' })

  const htmlQrs = qrs.map((q, i) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
      <tr><td align="center" style="background:#ffffff;border:3px solid #111111;border-radius:14px;padding:18px 14px;">
        <div style="font:700 13px/1.2 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#b3121a;">
          Entrada ${i + 1} de ${orden.cantidad}
        </div>
        <img src="cid:qr${i}" width="240" height="240" alt="Código QR de la entrada ${i + 1}"
             style="display:block;margin:12px auto 8px;">
        <div style="font:400 10px/1.4 Consolas,monospace;color:#9a9a9a;word-break:break-all;max-width:320px;margin:auto;">
          ${q.codigo}
        </div>
      </td></tr>
    </table>`).join('')

  const html = `
  <div style="background:#fdf4fa;padding:22px 12px;font-family:'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:auto;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(120,40,110,.12);">

      <!-- Encabezado -->
      <tr><td align="center" style="background:linear-gradient(135deg,#d6247a,#8e3bb8);background-color:#a72f9b;padding:26px 20px;">
        <img src="cid:logo" width="74" height="74" alt="Escuela de Gimnasia Bellatrix"
             style="display:block;margin:0 auto 12px;border-radius:50%;background:#fff;padding:4px;">
        <div style="font:800 22px/1.2 Arial,sans-serif;color:#ffffff;">11° Torneo Aniversario</div>
        <div style="font:400 14px/1.5 Arial,sans-serif;color:#ffd6ea;margin-top:4px;">Escuela de Gimnasia Bellatrix</div>
      </td></tr>

      <!-- Saludo -->
      <tr><td style="padding:26px 26px 6px;">
        <div style="font:800 19px/1.3 Arial,sans-serif;color:#2a1f4d;">¡Listo, ${escapeHtml((orden.nombre || '').split(' ')[0])}! 🎉</div>
        <p style="font:400 15px/1.6 Arial,sans-serif;color:#3d3560;margin:10px 0 0;">
          Tu compra se confirmó. Abajo están ${orden.cantidad > 1 ? `tus <b>${orden.cantidad} entradas</b>` : 'tu <b>entrada</b>'},
          cada una con su código QR.
        </p>
      </td></tr>

      <!-- Datos del evento -->
      <tr><td style="padding:18px 26px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdf4fa;border:1px solid #f0dcea;border-radius:12px;">
          <tr><td style="padding:16px 18px;font:400 14px/1.9 Arial,sans-serif;color:#3d3560;">
            📅 <b>${escapeHtml(EVENTO_CUANDO)}</b>, desde las <b>10:00</b><br>
            📍 <b>${escapeHtml(EVENTO_LUGAR)}</b><br>
            🤸 Gimnasia <b>rítmica y artística</b> · una sola entrada para todo el torneo
          </td></tr>
        </table>
      </td></tr>

      <!-- Entradas -->
      <tr><td style="padding:22px 26px 0;">
        ${htmlQrs}
      </td></tr>

      <!-- Cómo entrar -->
      <tr><td style="padding:4px 26px 0;">
        <div style="font:700 12px/1.2 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#b0239a;margin-bottom:8px;">
          Cómo entrar
        </div>
        <ul style="font:400 14px/1.7 Arial,sans-serif;color:#3d3560;margin:0;padding-left:20px;">
          <li>Mostrá el QR en la puerta, desde el celular o impreso.</li>
          <li>Cada QR sirve <b>una sola vez</b>: si venís con más gente, cada persona necesita el suyo.</li>
          <li>Te recomendamos llegar unos minutos antes para no hacer cola.</li>
          <li>Si se te pierde el mail, entrá a <b>Mis entradas</b> con tu correo y recuperalas.</li>
        </ul>
      </td></tr>

      <!-- Botón -->
      <tr><td align="center" style="padding:22px 26px 6px;">
        <a href="${FRONTEND_URL}/mis-entradas.html"
           style="display:inline-block;background:#d6247a;color:#ffffff;text-decoration:none;font:700 15px/1 Arial,sans-serif;padding:14px 30px;border-radius:999px;">
          Ver mis entradas
        </a>
      </td></tr>

      <!-- Pie -->
      <tr><td align="center" style="padding:18px 26px 26px;">
        <div style="font:400 12px/1.6 Arial,sans-serif;color:#8d85a6;">
          ¡Viví la gimnasia, compartí la pasión!<br>
          N° de compra: ${escapeHtml(orden.id)}
        </div>
      </td></tr>
    </table>
  </div>`

  const texto = `¡Listo, ${(orden.nombre || '').split(' ')[0]}!

Tu compra se confirmó: ${orden.cantidad} entrada(s) para el 11° Torneo Aniversario Bellatrix.
${EVENTO_CUANDO}, desde las 10:00 · ${EVENTO_LUGAR}

Las entradas con su código QR van adjuntas a este mail. Mostralas en la puerta
desde el celular o impresas. Cada QR sirve una sola vez.

Si no ves las imágenes, entrá a ${FRONTEND_URL}/mis-entradas.html con tu correo.

N° de compra: ${orden.id}`

  const info = await t.sendMail({
    from: `"${EVENTO_NOMBRE}" <${process.env.EMAIL_USER || EVENTO_MAIL_FROM}>`,
    to: orden.email,
    subject: `🎟️ ${orden.cantidad > 1 ? `Tus ${orden.cantidad} entradas` : 'Tu entrada'} para el 11° Torneo Bellatrix`,
    text: texto,
    html,
    attachments,
  })
  orden.emailPreview = nodemailer.getTestMessageUrl(info) || null
  if (orden.emailPreview) console.log(`📧 Mail (preview): ${orden.emailPreview}`)
  else console.log(`📧 Mail enviado a ${orden.email} — revisá tu bandeja (y spam)`)
}

// ═══════════════════════════════════════════════════════════════
//  CONFIRMAR ORDEN + EMITIR QR  (lo usan el webhook Y la simulación)
// ═══════════════════════════════════════════════════════════════
async function confirmarYEmitir(orden, paymentId = null, pago = null) {
  // Idempotencia ATÓMICA: solo el primero que la pasa a "pagada" emite las entradas
  // (evita emitir dos veces si llegan dos webhooks juntos).
  const campos = { estado: 'pagada' }
  if (paymentId) campos.paymentId = paymentId
  if (pago?.tipo) campos.medioPago = pago.tipo
  if (pago?.medioId) campos.medioId = pago.medioId
  const [afectadas] = await Orden.update(campos, { where: { id: orden.id, estado: { [Op.in]: ['pendiente', 'abandonada'] } } })
  if (!afectadas) return // ya estaba pagada
  orden.estado = 'pagada'
  if (paymentId) orden.paymentId = paymentId

  // Un QR por entrada
  const qrs = []
  for (let i = 1; i <= orden.cantidad; i++) {
    const base   = `${orden.id}::${i}`
    const codigo = firmarQR(base) // QR firmado (HMAC) → no se puede falsificar
    const nombreArchivo = `${orden.id}-${i}.png`
    const archivo = join(QR_DIR, nombreArchivo)
    // Rojo oscuro, no rojo puro: los lectores necesitan contraste contra el
    // blanco y un rojo claro falla con cámaras malas o poca luz.
    await QRCode.toFile(archivo, codigo, {
      width: 480, margin: 2, color: { dark: '#b3121a', light: '#ffffff' },
    })
    qrs.push({ orden_id: orden.id, indice: i, codigo, base, archivo, url: `/qrs/${nombreArchivo}`, usado: false, usadoEn: null })
  }
  await Entrada.bulkCreate(qrs)

  await enviarMail(orden, qrs)
  console.log(`✅ Orden ${orden.id} PAGADA → ${qrs.length} QR generados + mail a ${orden.email}`)
}

// ═══════════════════════════════════════════════════════════════
// 1) CREAR ORDEN + PREFERENCIA DE PAGO
// ═══════════════════════════════════════════════════════════════
app.post('/api/orders', rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
  try {
    const { nombre, email, dni, cantidad = 1, metodo = 'mp' } = req.body
    // El DNI es opcional: en la puerta se vende contra reloj y pedirlo demora.
    if (!nombre || !email) {
      return res.status(400).json({ error: 'Faltan datos (nombre y email)' })
    }

    const cant = parseInt(cantidad, 10)
    if (!Number.isInteger(cant) || cant < 1 || cant > MAX_ENTRADAS) {
      return res.status(400).json({ error: `Cantidad inválida (permitido: 1 a ${MAX_ENTRADAS})` })
    }

    const orderId = 'orden_' + randomUUID()
    const subtotal = PRECIO_ENTRADA * cant
    const cargo = Math.round(subtotal * CARGO_PCT / 100)
    const total = subtotal + cargo

    await Orden.create({
      id: orderId, nombre, email, dni, metodo,
      cantidad: cant, subtotal, cargo, total,
      estado: 'pendiente',
    })

    // ─── PAGO POR ePAGOS (E-Checkout) ───
    // El checkout NO se abre con un redirect por GET: hay que hacer un POST de
    // formulario. Devolvemos url + campos y el navegador arma y envía el form.
    const { url, campos } = await construirCheckout(
      { id: orderId, total, nombre, email, dni },
      {
        okUrl:    `${PUBLIC_URL}/pago/ok`,
        errorUrl: `${PUBLIC_URL}/pago/error`,
        detalle: [
          // ePagos suma los monto_item SIN multiplicarlos por cantidad_item:
          // mandando el precio unitario con cantidad 2, sus ítems no llegaban
          // al total y el enlace de pago tiraba error. Por eso cada línea va
          // con cantidad_item 1 y el monto ya multiplicado: así la suma da
          // igual se lea como se lea.
          { id_item: 1, desc_item: `${cant} entrada${cant > 1 ? 's' : ''} · ${EVENTO_NOMBRE}`,
            monto_item: subtotal, cantidad_item: 1 },
          ...(cargo > 0 ? [{ id_item: 2, desc_item: 'Cargo por servicio', monto_item: cargo, cantidad_item: 1 }] : []),
        ],
      })

    console.log(`🧾 Orden creada: ${orderId} ($${total})`)
    res.json({ orderId, checkout: { url, campos } })
  } catch (e) {
    console.error('❌ Error creando orden:', e?.message || e)
    res.status(500).json({ error: 'No se pudo crear la orden' })
  }
})

// ═══════════════════════════════════════════════════════════════
// 2) ePAGOS: callbacks + webhook
//    ⚠️ REGLA DE ORO: ni el callback ni el webhook vienen firmados, así que
//    NUNCA emitimos una entrada por lo que dicen. Solo los usamos como
//    disparador y SIEMPRE reconfirmamos contra la API (obtener_pagos), que
//    además valida el importe.
// ═══════════════════════════════════════════════════════════════

// Verifica contra la API y, si está acreditada, emite las entradas.
async function verificarYEmitir(orden, idTransaccion = null) {
  if (orden.estado === 'pagada') return true
  const r = await pagoAcreditado({
    idTransaccion,
    numeroOperacion: idTransaccion ? null : orden.id,
    totalEsperado: orden.total,
  })
  if (!r.ok) {
    console.log(`ℹ️ Orden ${orden.id}: todavía no acreditada (${r.motivo})`)
    return false
  }
  await confirmarYEmitir(orden, r.pago.idTransaccion, r.pago)
  return true
}

// ePagos redirige al comprador con un POST. Verificamos y lo mandamos a la
// página de resultado.
async function manejarRetorno(req, res, exito) {
  try {
    const datos = { ...req.query, ...req.body }
    // Ojo: a la vuelta el campo se llama "identificador_2", no
    // "identificador_externo_2" como al enviarlo.
    const ordenId = datos.numero_operacion || datos.identificador_2 || datos.identificador_externo_2 || datos.ExternoId
    const idTransaccion = datos.id_transaccion || datos.CodigoUnicoTransaccion || null
    // 02001 = acreditado · 02002 = pendiente · 02004/02007 = cancelado o rechazado
    const idResp = String(datos.id_resp || '')
    console.log(`↩️ Retorno ePagos (${exito ? 'ok' : 'error'}) orden=${ordenId} transaccion=${idTransaccion} id_resp=${idResp || '—'} ${datos.respuesta ? '"' + datos.respuesta + '"' : ''}`)

    // Llevamos el motivo a la página de error para poder diagnosticar sin
    // tener que ir a mirar los logs del servidor.
    const motivo = `cod=${encodeURIComponent(idResp)}&msg=${encodeURIComponent(String(datos.respuesta || '').slice(0, 200))}`

    if (!ordenId) return res.redirect(`${FRONTEND_URL}/pago-fallido.html?${motivo}`)
    const orden = await Orden.findByPk(ordenId)
    if (!orden) return res.redirect(`${FRONTEND_URL}/pago-fallido.html?${motivo}`)

    if (!exito) return res.redirect(`${FRONTEND_URL}/pago-fallido.html?orden=${orden.id}&${motivo}`)

    // Si el medio es efectivo/homebanking/transferencia, ePagos devuelve la
    // boleta con las instrucciones de pago. La guardamos para ofrecerla.
    if (datos.pdf) {
      BOLETAS.set(orden.id, datos.pdf)
      console.log(`🧾 Boleta de pago recibida para la orden ${orden.id}`)
    }

    const emitida = await verificarYEmitir(orden, idTransaccion)
    // Si el medio es efectivo/transferencia queda "adeudado": todavía no pagó.
    const conBoleta = datos.pdf ? '&boleta=1' : ''
    return res.redirect(emitida
      ? `${FRONTEND_URL}/pago-exitoso.html?orden=${orden.id}`
      : `${FRONTEND_URL}/pago-pendiente.html?orden=${orden.id}${conBoleta}`)
  } catch (e) {
    console.error('❌ Error en el retorno de ePagos:', e?.message || e)
    return res.redirect(`${FRONTEND_URL}/pago-fallido.html`)
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEV: banco de pruebas del plan de certificación de ePagos.
//  Cada caso pide un monto e identificador_externo_2 concretos.
//  🔒 Vive solo mientras ePagos esté en SANDBOX: ahí las operaciones son de
//  mentira. En cuanto se pasa a prod, estos endpoints desaparecen solos y la
//  central de pruebas deja de funcionar. (La certificación hay que correrla
//  contra la URL pública, por eso no alcanza con mirar NODE_ENV.)
// ═══════════════════════════════════════════════════════════════
const EPAGOS_SANDBOX = (process.env.EPAGOS_ENV || 'sandbox').toLowerCase() !== 'prod'

app.post('/api/dev/certificacion/:caso', async (req, res) => {
  if (!EPAGOS_SANDBOX) return res.sendStatus(404)
  try {
    const caso = String(req.params.caso)
    if (!/^\d{5}$/.test(caso)) return res.status(400).json({ error: 'Caso inválido' })

    const orderId = 'cert_' + caso + '_' + randomUUID().slice(0, 8)
    const total = Number(caso) // el plan pide monto = número de caso
    await Orden.create({
      id: orderId, nombre: 'Prueba Certificacion', email: process.env.EMAIL_USER || 'prueba@evento.local',
      dni: '30123456', metodo: 'certificacion', cantidad: 1,
      subtotal: total, cargo: 0, total, estado: 'pendiente',
    })

    // Para la prueba de rechazo hay que dejar los datos del pagador VACÍOS:
    // si los pre-cargamos, el checkout completa el titular y no se puede
    // escribir "CALL", que es lo que fuerza el rechazo.
    const pagador = req.body?.sinDatosPagador
      ? { id: orderId, total }
      : { id: orderId, total, nombre: 'Prueba Certificacion', email: process.env.EMAIL_USER, dni: '30123456' }

    const { url, campos } = await construirCheckout(pagador,
      { okUrl: `${PUBLIC_URL}/pago/ok`, errorUrl: `${PUBLIC_URL}/pago/error`, detalle: [] })

    // El plan exige identificador_externo_2 = número de caso
    campos.identificador_externo_2 = caso
    // Para los casos de efectivo/homebanking hay que ofrecer todos los medios
    if (req.body?.todosLosMedios) delete campos.tp_excluidos
    // Caso 11007: operación con fecha de vencimiento
    if (req.body?.vencimiento) campos.opc_fecha_vencimiento = req.body.vencimiento

    console.log(`🧪 Certificación ${caso} → orden ${orderId} ($${total})`)
    res.json({ orderId, checkout: { url, campos } })
  } catch (e) {
    console.error('❌ Error armando el caso de certificación:', e?.message || e)
    res.status(500).json({ error: e?.message || 'Error' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  BOLETA DE PAGO (efectivo / homebanking / transferencia)
//  ePagos devuelve el comprobante en base64 dentro del POST de vuelta.
//  Lo guardamos en memoria y lo servimos: es lo que el comprador necesita
//  para ir a pagar. Se pierde al reiniciar, y está bien: sirve solo en el
//  momento posterior al checkout.
// ═══════════════════════════════════════════════════════════════
const BOLETAS = new Map()

app.get('/boleta/:orden', (req, res) => {
  const b64 = BOLETAS.get(req.params.orden)
  if (!b64) return res.status(404).send('La boleta ya no está disponible. Revisá tu email.')
  try {
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `inline; filename="boleta-${req.params.orden}.pdf"`)
    res.send(Buffer.from(b64, 'base64'))
  } catch {
    res.status(500).send('No se pudo generar la boleta')
  }
})

// ePagos hace POST, pero aceptamos GET por las dudas.
app.post('/pago/ok',    (req, res) => manejarRetorno(req, res, true))
app.get('/pago/ok',     (req, res) => manejarRetorno(req, res, true))
app.post('/pago/error', (req, res) => manejarRetorno(req, res, false))
app.get('/pago/error',  (req, res) => manejarRetorno(req, res, false))

// Webhook: se registra en el panel de ePagos (sección Desarrolladores).
app.post('/api/webhooks/epagos', async (req, res) => {
  res.sendStatus(200) // responder rápido siempre
  try {
    const datos = { ...req.query, ...req.body }
    const ordenId = datos.numero_operacion || datos.identificador_2 || datos.identificador_externo_2 || datos.ExternoId
    const idTransaccion = datos.id_transaccion || datos.CodigoUnicoTransaccion || null
    console.log(`🔔 Webhook ePagos: orden=${ordenId} transaccion=${idTransaccion} · payload: ${JSON.stringify(datos).slice(0, 400)}`)

    const orden = ordenId ? await Orden.findByPk(ordenId) : null
    if (!orden) return console.log('⚠️ Webhook ePagos: no pude ubicar la orden', JSON.stringify(datos).slice(0, 300))
    await verificarYEmitir(orden, idTransaccion)
  } catch (e) {
    console.error('❌ Error en webhook ePagos:', e?.message || e)
  }
})

// ── Webhook de DEVOLUCIONES ──
// ePagos avisa acá cuando una operación se reversa, se devuelve o se anula.
// Sin esto, un pago devuelto dejaría la entrada válida y esa persona entraría
// gratis. Marcamos la orden como 'reversada' y /api/validar la rechaza sola,
// porque solo deja pasar las que están en estado 'pagada'.
app.post('/api/webhooks/epagos/devoluciones', async (req, res) => {
  res.sendStatus(200) // responder rápido siempre
  try {
    const datos = { ...req.query, ...req.body }
    const ordenId = datos.numero_operacion || datos.identificador_2 || datos.identificador_externo_2 || datos.ExternoId
    console.log(`↩️ Webhook devoluciones: orden=${ordenId} · payload: ${JSON.stringify(datos).slice(0, 400)}`)

    const orden = ordenId ? await Orden.findByPk(ordenId) : null
    if (!orden) return console.log('⚠️ Devolución: no pude ubicar la orden', JSON.stringify(datos).slice(0, 300))

    // Antes de anular, confirmamos contra la API: el webhook no viene firmado
    // y no queremos invalidar la entrada de alguien por un aviso trucho.
    const r = await pagoAcreditado({
      numeroOperacion: orden.id,
      idTransaccion: datos.id_transaccion || datos.CodigoUnicoTransaccion || null,
      totalEsperado: orden.total,
    })
    if (r.ok) {
      return console.log(`⚠️ Devolución avisada para ${orden.id}, pero la API la sigue dando por acreditada. No se anula.`)
    }

    const entradas = await Entrada.count({ where: { orden_id: orden.id } })
    const usadas = await Entrada.count({ where: { orden_id: orden.id, usado: true } })
    await orden.update({ estado: 'reversada' })
    console.log(`🚫 Orden ${orden.id} marcada como REVERSADA (${entradas} entradas, ${usadas} ya habían ingresado). Motivo API: ${r.motivo}`)
  } catch (e) {
    console.error('❌ Error en webhook de devoluciones:', e?.message || e)
  }
})

// ═══════════════════════════════════════════════════════════════
// 3) DEV: simular el pago de una orden (mismo flujo que el webhook)
//     ⚠️ SOLO para pruebas locales. Quitar en producción.
// ═══════════════════════════════════════════════════════════════
app.post('/api/dev/confirmar/:orden', async (req, res) => {
  if (IS_PROD) return res.sendStatus(404) // 🔒 deshabilitado en producción (evita emitir entradas sin pago)
  try {
    const orden = await Orden.findByPk(req.params.orden)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
    await confirmarYEmitir(orden)
    const qrs = await Entrada.findAll({ where: { orden_id: orden.id } })
    res.json({
      ok: true, estado: orden.estado,
      emailPreview: orden.emailPreview,
      qrs: qrs.map(q => q.archivo),
    })
  } catch (e) {
    console.error('❌ Error confirmando:', e?.message || e)
    res.status(500).json({ error: 'No se pudo confirmar/emitir' })
  }
})

// 4) Consultar estado de una orden
app.get('/api/orders/:id', async (req, res) => {
  const orden = await Orden.findByPk(req.params.id, { include: [{ model: Entrada, as: 'qrs' }] })
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
  res.json(orden)
})

// 4b) CONFIRMAR AL VOLVER DEL PAGO — verifica el pago con MP y emite las entradas.
//     Es la red de seguridad si el webhook no llegó (servicio dormido, etc.).
app.post('/api/orders/:id/confirmar', async (req, res) => {
  try {
    const orden = await Orden.findByPk(req.params.id)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })

    // Red de seguridad si el webhook no llegó: preguntamos a la API por
    // nuestro número de orden.
    if (orden.estado !== 'pagada') {
      await verificarYEmitir(orden, req.body?.id_transaccion || req.query.id_transaccion || null)
        .catch(e => console.error('❌ Verificando al retorno:', e?.message || e))
    }

    const qrs = await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] })
    res.json({
      id: orden.id, nombre: orden.nombre, email: orden.email,
      cantidad: orden.cantidad, estado: orden.estado,
      qrs: qrs.map(q => ({ url: `/qr?c=${encodeURIComponent(q.codigo)}`, codigo: q.codigo })),
    })
  } catch (e) {
    console.error('❌ Error confirmando al retorno:', e?.message || e)
    res.status(500).json({ error: 'No se pudo verificar el pago' })
  }
})

// 5) "Mis Entradas": buscar entradas pagadas por email + DNI (passwordless)
app.post('/api/mis-entradas', rateLimit({ windowMs: 60000, max: 10, msg: 'Demasiados intentos. Esperá un minuto.' }), async (req, res) => {
  const { email, dni } = req.body
  if (!email || !dni) return res.status(400).json({ error: 'Faltan email y DNI' })
  const mail = String(email).trim()
  const doc = String(dni).trim()
  try {
    const encontradas = await Orden.findAll({
      where: { estado: 'pagada', email: mail, dni: doc }, // MySQL compara email sin distinguir mayúsculas
      include: [{ model: Entrada, as: 'qrs' }],
      order: [['createdAt', 'DESC']],
    })
    res.json({
      ordenes: encontradas.map(o => ({
        id: o.id, fecha: o.createdAt, cantidad: o.cantidad,
        qrs: o.qrs.map(q => ({ url: `/qr?c=${encodeURIComponent(q.codigo)}`, codigo: q.codigo, usado: q.usado })),
      })),
    })
  } catch (e) {
    console.error('❌ Error en mis-entradas:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron obtener las entradas' })
  }
})

// 6) VALIDAR entrada en la puerta (escaneo del QR) — verifica firma + UN SOLO USO
//    Protegido con token de staff en el header X-Scan-Token.
app.post('/api/validar', rateLimit({ windowMs: 60000, max: 1200 }), async (req, res) => {
  // Autoriza si trae sesión de control/admin O el token de escaneo por header
  const p = tokenDeReq(req)
  const okAuth = (p && ['control', 'admin'].includes(p.rol)) ||
                 (SCAN_TOKEN && req.headers['x-scan-token'] === SCAN_TOKEN)
  if (!okAuth) return res.status(401).json({ ok: false, error: 'No autorizado' })
  const { codigo } = req.body || {}
  if (!codigo) return res.status(400).json({ ok: false, error: 'Falta el código' })

  const base = verificarQR(codigo)
  if (!base) return res.json({ ok: false, estado: 'invalido', msg: 'QR inválido o adulterado' })

  try {
    const [orderId] = base.split('::')
    const orden = await Orden.findByPk(orderId)
    if (orden && orden.estado === 'reversada') {
      return res.json({ ok: false, estado: 'reversada', nombre: orden.nombre,
        msg: 'PAGO DEVUELTO — esta entrada fue anulada' })
    }
    if (!orden || orden.estado !== 'pagada') {
      return res.json({ ok: false, estado: 'no_pagada', msg: 'Entrada no válida o no pagada' })
    }
    const qr = await Entrada.findOne({ where: { base } })
    if (!qr) return res.json({ ok: false, estado: 'invalido', msg: 'QR no corresponde a la orden' })

    // Marcado ATÓMICO de un solo uso: solo pasa si estaba SIN usar (evita doble escaneo)
    const [afectadas] = await Entrada.update(
      { usado: true, usadoEn: new Date() },
      { where: { base, usado: false } }
    )
    if (!afectadas) {
      const yaUsado = await Entrada.findOne({ where: { base } })
      const usadas = await Entrada.count({ where: { orden_id: orden.id, usado: true } })
      return res.json({ ok: false, estado: 'usado', msg: `Ya ingresó (${yaUsado?.usadoEn})`, nombre: orden.nombre, cantidad: orden.cantidad, usadas })
    }
    const usadas = await Entrada.count({ where: { orden_id: orden.id, usado: true } })
    const esPrueba = orden.metodo === 'prueba'
    return res.json({ ok: true, estado: 'valido', msg: esPrueba ? 'PRUEBA · Ingreso OK' : 'Ingreso OK', nombre: orden.nombre, cantidad: orden.cantidad, usadas, prueba: esPrueba })
  } catch (e) {
    console.error('❌ Error validando:', e?.message || e)
    return res.status(500).json({ ok: false, error: 'Error al validar' })
  }
})

// ═══════════════════════════════════════════════════════════════
// 7) PANEL ADMIN — login + resumen de ventas
// ═══════════════════════════════════════════════════════════════
app.post('/api/admin/login', rateLimit({ windowMs: 60000, max: 10, msg: 'Demasiados intentos. Esperá un minuto.' }), async (req, res) => {
  try {
    const { usuario, password } = req.body || {}
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan usuario y contraseña' })
    const u = await Usuario.findOne({ where: { usuario: String(usuario).trim() } })
    if (!u || !verifyPassword(password, u.salt, u.hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' })
    }
    res.json({
      token: firmarToken({ usuario: u.usuario, rol: u.rol, area: u.area }),
      rol: u.rol, usuario: u.usuario, area: u.area, nombre: u.nombre,
    })
  } catch (e) {
    console.error('❌ Error en login:', e?.message || e)
    res.status(500).json({ error: 'Error al iniciar sesión' })
  }
})

// Resumen de ventas (solo admin): totales + tabla de compradores
// Registrar visita a la landing (público, fire-and-forget desde el front)
app.post('/api/visita', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null
    await Visita.create({ ip })
    res.json({ ok: true })
  } catch (e) {
    // Nunca romper la carga de la página por el contador
    res.json({ ok: false })
  }
})

app.get('/api/admin/resumen', requireAuth(['admin', 'venta', 'control']), async (req, res) => {
  try {
    // Excluye las órdenes de PRUEBA (metodo='prueba') para no ensuciar el panel.
    const ordenes = await Orden.findAll({ where: { estado: 'pagada', metodo: { [Op.notIn]: ['prueba', 'cortesia'] } }, order: [['createdAt', 'DESC']] })

    // Cuántas entradas de cada orden ya entraron (escaneadas o marcadas a mano).
    const usadas = {}
    for (const e of await Entrada.findAll({ where: { usado: true }, attributes: ['orden_id'] })) {
      usadas[e.orden_id] = (usadas[e.orden_id] || 0) + 1
    }

    const listado = ordenes.map(o => ({
      id: o.id, metodo: o.metodo,
      nombre: o.nombre, email: o.email, dni: o.dni,
      cantidad: o.cantidad, total: o.total, fecha: o.createdAt,
      medioPago: o.medioPago, medioId: o.medioId,
      ingresadas: usadas[o.id] || 0,
    }))

    // Los perfiles "venta" y "control" solo ven el listado de compradores (buscar por DNI,
    // mostrar/reenviar entradas). NO reciben estadísticas: ni recaudación, ni entradas
    // vendidas, ni visitas. Ni siquiera llegan a su navegador.
    if (req.usuario.rol === 'venta' || req.usuario.rol === 'control') {
      return res.json({ ordenes: listado })
    }

    // Cuánto entró por cada medio: sirve para cruzar con la rendición de ePagos,
    // donde el plazo de depósito cambia según el instrumento.
    const porMedio = {}
    for (const o of ordenes) {
      const k = o.medioPago || 'sin identificar'
      if (!porMedio[k]) porMedio[k] = { medio: k, id: o.medioId || null, operaciones: 0, entradas: 0, importe: 0 }
      porMedio[k].operaciones++
      porMedio[k].entradas += o.cantidad
      porMedio[k].importe  += o.total
    }

    const totalEntradas  = ordenes.reduce((a, o) => a + o.cantidad, 0)
    // Recaudado = lo que corresponde al evento: entradas por su valor.
    // NO se suma el cargo por servicio, que no es plata del organizador.
    const totalRecaudado = ordenes.reduce((a, o) => a + o.subtotal, 0)
    const escaneadas     = await Entrada.count({
      where: { usado: true },
      include: [{ model: Orden, as: 'orden', attributes: [], required: true, where: { metodo: { [Op.notIn]: ['prueba', 'cortesia'] } } }],
    })

    // Visitas a la página
    // "Hoy" es el día en Argentina, no en el servidor. Render corre en UTC,
    // así que su medianoche son las 21:00 de acá: sin esto, el contador de
    // visitas se reiniciaba cada noche a las nueve.
    const inicioHoy = comienzoDelDiaArgentino()
    const totalVisitas     = await Visita.count()
    const visitantesUnicos = await Visita.count({ col: 'ip', distinct: true })
    const visitasHoy       = await Visita.count({ where: { createdAt: { [Op.gte]: inicioHoy } } })

    res.json({
      totalEntradas, totalRecaudado, cantidadOrdenes: ordenes.length, escaneadas,
      totalVisitas, visitantesUnicos, visitasHoy,
      porMedio: Object.values(porMedio).sort((a, b) => b.importe - a.importe),
      ordenes: listado,
    })
  } catch (e) {
    console.error('❌ Error en resumen:', e?.message || e)
    res.status(500).json({ error: 'Error al obtener el resumen' })
  }
})

// Generar una ENTRADA DE PRUEBA (solo admin): es un QR real y escaneable, pero la orden
// va marcada como metodo='prueba' → NO aparece en ventas/recaudación/ingresos del panel.
app.post('/api/admin/entrada-prueba', requireAuth(['admin']), async (req, res) => {
  try {
    const cant = Math.min(Math.max(parseInt(req.body?.cantidad, 10) || 1, 1), 5)
    const orderId = 'orden_' + randomUUID()
    await Orden.create({
      id: orderId, nombre: 'ENTRADA DE PRUEBA', email: 'prueba@evento.local', dni: 'PRUEBA',
      metodo: 'prueba', cantidad: cant, subtotal: 0, cargo: 0, total: 0, estado: 'pagada',
    })
    const qrs = []
    for (let i = 1; i <= cant; i++) {
      const base = `${orderId}::${i}`
      const codigo = firmarQR(base)
      const url = `/qr?c=${encodeURIComponent(codigo)}`
      await Entrada.create({ orden_id: orderId, indice: i, codigo, base, url, usado: false })
      qrs.push({ indice: i, codigo, url })
    }
    res.json({ ok: true, ordenId: orderId, cantidad: cant, qrs })
  } catch (e) {
    console.error('❌ Error generando entrada de prueba:', e?.message || e)
    res.status(500).json({ error: 'No se pudo generar la entrada de prueba' })
  }
})

// Emitir una ENTRADA DE CORTESÍA (solo admin): QR real y escaneable ("Ingreso OK" normal),
// se envía por email, y NO cuenta como venta (metodo='cortesia', excluida del panel).
app.post('/api/admin/entrada-cortesia', requireAuth(['admin']), async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim() || 'Invitación de cortesía'
    const email  = String(req.body?.email || '').trim()
    const cant   = Math.min(Math.max(parseInt(req.body?.cantidad, 10) || 1, 1), 10)
    if (!email) return res.status(400).json({ error: 'Falta el email de la invitada' })

    const orderId = 'orden_' + randomUUID()
    const orden = await Orden.create({
      id: orderId, nombre, email, dni: 'CORTESIA',
      metodo: 'cortesia', cantidad: cant, subtotal: 0, cargo: 0, total: 0, estado: 'pagada',
    })
    const qrs = []
    for (let i = 1; i <= cant; i++) {
      const base = `${orderId}::${i}`
      const codigo = firmarQR(base)
      const nombreArchivo = `${orderId}-${i}.png`
      const archivo = join(QR_DIR, nombreArchivo)
      await QRCode.toFile(archivo, codigo, { width: 420, margin: 1, color: { dark: '#d6006e', light: '#ffffff' } })
      qrs.push({ orden_id: orderId, indice: i, codigo, base, archivo, url: `/qr?c=${encodeURIComponent(codigo)}`, usado: false, usadoEn: null })
    }
    await Entrada.bulkCreate(qrs)
    await enviarMail(orden, qrs)   // mismo mail de siempre, con los QR adjuntos
    console.log(`🎫 Cortesía emitida: ${cant} entrada(s) → ${email} (${nombre})`)
    res.json({ ok: true, ordenId: orderId, cantidad: cant, email })
  } catch (e) {
    console.error('❌ Error emitiendo cortesía:', e?.message || e)
    res.status(500).json({ error: 'No se pudo emitir la cortesía' })
  }
})

// Ver los QR de una orden (admin/venta): para mostrarlos en pantalla y escanearlos en la puerta
// Marca TODAS las entradas de una orden como ingresadas, sin escanear.
// Es para la venta en la puerta: la persona paga ahí mismo, los QR salen en la
// pantalla del staff y no tiene sentido hacerla esperar el mail para escanearlos.
// Protegido igual que el escáner: hace falta sesión de staff.
app.post('/api/admin/orden/:id/ingresar', requireAuth(['admin', 'venta', 'control']), async (req, res) => {
  try {
    const orden = await Orden.findByPk(req.params.id)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
    if (orden.estado !== 'pagada') {
      return res.status(400).json({ error: 'La orden todavía no está pagada' })
    }
    const entradas = await Entrada.findAll({ where: { orden_id: orden.id } })
    if (!entradas.length) return res.status(404).json({ error: 'Esa orden no tiene entradas emitidas' })

    let marcadas = 0
    for (const e of entradas) {
      // Mismo marcado atómico que usa la puerta: si ya estaba usada, no se toca.
      const [n] = await Entrada.update({ usado: true, usadoEn: new Date() },
        { where: { id: e.id, usado: false } })
      marcadas += n
    }
    const yaEstaban = entradas.length - marcadas
    console.log(`🚪 Ingreso manual ${orden.id}: ${marcadas} marcada/s` +
      (yaEstaban ? `, ${yaEstaban} ya estaba/n` : '') + ` (por ${req.usuario?.usuario || 'staff'})`)
    res.json({ ok: true, total: entradas.length, marcadas, yaEstaban, nombre: orden.nombre })
  } catch (e) {
    console.error('❌ Error marcando ingreso manual:', e?.message || e)
    res.status(500).json({ error: 'No se pudo marcar el ingreso' })
  }
})

app.get('/api/admin/orden/:id/qrs', requireAuth(['admin', 'venta', 'control']), async (req, res) => {
  try {
    const orden = await Orden.findByPk(req.params.id)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
    const entradas = await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] })
    res.json({
      ok: true,
      nombre: orden.nombre, email: orden.email, dni: orden.dni, cantidad: orden.cantidad,
      qrs: entradas.map(e => ({ indice: e.indice, url: `/qr?c=${encodeURIComponent(e.codigo)}`, usado: e.usado })),
    })
  } catch (e) {
    console.error('❌ Error obteniendo QRs de la orden:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron obtener los QR' })
  }
})

// REENVIAR las entradas por email (admin/venta): para quien puso MAL su email al comprar.
// Corrige el email guardado en la orden (así queda bien en el listado y en "Mis Entradas")
// y reenvía los mismos QR al correcto. Regenera los PNG desde el código firmado (disco efímero).
app.post('/api/admin/orden/:id/reenviar', requireAuth(['admin', 'venta', 'control']), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim()
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' })

    const orden = await Orden.findByPk(req.params.id)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })

    const entradas = await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] })
    if (!entradas.length) return res.status(404).json({ error: 'La orden no tiene entradas emitidas' })

    orden.email = email
    await orden.save()

    const qrs = []
    for (const e of entradas) {
      const archivo = join(QR_DIR, `${orden.id}-${e.indice}.png`)
      await QRCode.toFile(archivo, e.codigo, { width: 420, margin: 1, color: { dark: '#d6006e', light: '#ffffff' } })
      qrs.push({ orden_id: orden.id, indice: e.indice, codigo: e.codigo, archivo })
    }

    await enviarMail(orden, qrs)
    console.log(`📧 Reenvío de entradas: orden ${orden.id} → ${email} (${qrs.length} QR)`)
    res.json({ ok: true, email, cantidad: qrs.length })
  } catch (e) {
    console.error('❌ Error reenviando entradas:', e?.message || e)
    res.status(500).json({ error: 'No se pudo reenviar el email' })
  }
})

// VENTA MANUAL (admin/venta): entrada pagada por transferencia. Cuenta como venta real,
// aparece en el listado y se envía por email. Solo se pide nombre y email.
// Repesca a pedido: para cuando alguien avisa "pagué y no me llegó" y no se
// quiere esperar a la pasada automática.
app.post('/api/admin/repescar', requireAuth(['admin', 'venta']), async (_req, res) => {
  try {
    const antes = await Orden.count({ where: { estado: 'pendiente' } })
    await repescarPagos()
    const despues = await Orden.count({ where: { estado: 'pendiente' } })
    res.json({ ok: true, revisadas: antes, emitidas: antes - despues, pendientes: despues })
  } catch (e) {
    console.error('❌ Error en la repesca manual:', e?.message || e)
    res.status(500).json({ error: 'No se pudo revisar los pagos pendientes' })
  }
})

// Archiva las pendientes viejas: el contador del panel arranca de cero y
// se puede ver cuántos tienen problemas de acá en adelante. No se borra
// nada y la repesca las sigue vigilando.
app.post('/api/admin/archivar-pendientes', requireAuth(['admin']), async (req, res) => {
  try {
    const minutos = numEnv('ARCHIVAR_DESDE_MIN', 30)
    const corte = new Date(Date.now() - minutos * 60 * 1000)
    const [n] = await Orden.update({ estado: 'abandonada' },
      { where: { estado: 'pendiente', createdAt: { [Op.lte]: corte } } })
    console.log(`🗄️ ${n} orden(es) pendientes archivadas como abandonadas`)
    res.json({ ok: true, archivadas: n })
  } catch (e) {
    console.error('❌ Error archivando pendientes:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron archivar' })
  }
})

app.post('/api/admin/entrada-manual', requireAuth(['admin', 'venta']), async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim()
    const email  = String(req.body?.email || '').trim()
    const cant   = Math.min(Math.max(parseInt(req.body?.cantidad, 10) || 1, 1), MAX_ENTRADAS)
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre' })
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' })

    const orderId  = 'orden_' + randomUUID()
    const subtotal = PRECIO_ENTRADA * cant
    const orden = await Orden.create({
      id: orderId, nombre, email, dni: String(req.body?.dni || 'MANUAL').trim(),
      metodo: 'transferencia', cantidad: cant, subtotal, cargo: 0, total: subtotal, estado: 'pagada',
    })
    const qrs = []
    for (let i = 1; i <= cant; i++) {
      const base = `${orderId}::${i}`
      const codigo = firmarQR(base)
      const nombreArchivo = `${orderId}-${i}.png`
      const archivo = join(QR_DIR, nombreArchivo)
      await QRCode.toFile(archivo, codigo, { width: 420, margin: 1, color: { dark: '#d6006e', light: '#ffffff' } })
      qrs.push({ orden_id: orderId, indice: i, codigo, base, archivo, url: `/qr?c=${encodeURIComponent(codigo)}`, usado: false, usadoEn: null })
    }
    await Entrada.bulkCreate(qrs)
    await enviarMail(orden, qrs)
    console.log(`💵 Venta manual (transferencia): ${cant} entrada(s) → ${email} (${nombre}) · $${subtotal}`)
    res.json({ ok: true, ordenId: orderId, cantidad: cant, email, total: subtotal, qrs: qrs.map(q => ({ indice: q.indice, url: q.url })) })
  } catch (e) {
    console.error('❌ Error en venta manual:', e?.message || e)
    res.status(500).json({ error: 'No se pudo generar la venta manual' })
  }
})

// ═══════════════════════════════════════════════════════════════
// 8) PUNTUACIÓN DE JUECES — carga de BD/DA/Ejecución/Artístico + ranking
//
//    Cada jueza puntúa la coreografía ENTERA y arma su propia nota final:
//      Nota D (de esa jueza) = BD + DA
//      Nota final (de esa jueza) = D + Ejecución + Artístico
//    DA es "destreza de aparato": en las categorías de manos libres no hay
//    aparato, así que no se puntúa y queda vacía. La Nota D es entonces solo
//    BD — se suma lo que haya cargado, no se toma la falta como un cero.
//    La nota que define el puesto es el PROMEDIO de las notas finales de
//    todas las juezas que la puntuaron. Las columnas D/E/A que se muestran
//    son también el promedio, para que se vea de dónde sale el total.
//    No se guarda ninguna nota "final": se calcula todo al vuelo acá.
// ═══════════════════════════════════════════════════════════════

// Argentina es UTC-3 todo el año (no hay horario de verano).
const HORAS_AR = 3
function comienzoDelDiaArgentino() {
  const ahora = new Date()
  // Corro el reloj a hora argentina para saber qué día es acá...
  const aca = new Date(ahora.getTime() - HORAS_AR * 3600 * 1000)
  // ...y devuelvo el instante en que arrancó ese día, expresado en UTC.
  return new Date(Date.UTC(aca.getUTCFullYear(), aca.getUTCMonth(), aca.getUTCDate(), HORAS_AR, 0, 0))
}

// Redondea a 2 decimales sin arrastrar errores de punto flotante.
const num2 = n => Math.round(Number(n) * 100) / 100

// Dado un array de Puntaje (todos de la misma coreografía), calcula D/E/A/Final.
function calcularNotas(puntajes) {
  const promedio = arr => arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null

  // Solo cuentan las planillas completas: una jueza que dejó un campo vacío
  // todavía no terminó, y sumarla como 0 hundiría injustamente la nota.
  // DA queda afuera del requisito: sin aparato no se puntúa.
  const llenas = puntajes.filter(p =>
    p.bd != null && p.ejecucion != null && p.artistico != null)

  const notaD = promedio(llenas.map(p => Number(p.bd) + Number(p.da || 0)))
  const notaE = promedio(llenas.map(p => Number(p.ejecucion)))
  const notaA = promedio(llenas.map(p => Number(p.artistico)))

  const completo = llenas.length > 0
  return {
    notaD: notaD != null ? num2(notaD) : null,
    notaE: notaE != null ? num2(notaE) : null,
    notaA: notaA != null ? num2(notaA) : null,
    notaFinal: completo ? num2(notaD + notaE + notaA) : null,
    completo,
    juezas: llenas.length,       // cuántas planillas completas entraron al promedio
    cargas: puntajes.length,     // cuántas juezas la tocaron (completas o no)
  }
}

// ── ADMIN: armar el torneo (categorías y coreografías) ──
app.get('/api/admin/categorias', requireAuth(['admin','director']), async (_req, res) => {
  const categorias = await Categoria.findAll({ order: [['orden', 'ASC'], ['id', 'ASC']] })
  res.json(categorias)
})

app.post('/api/admin/categorias', requireAuth(['admin','director']), async (req, res) => {
  try {
    const { nivel, categoriaEdad, modalidad, aparato, orden } = req.body || {}
    if (!nivel || !modalidad) return res.status(400).json({ error: 'Faltan nivel y modalidad' })
    const nombre = [nivel, categoriaEdad, modalidad, aparato].filter(Boolean).join(' · ')
    const cat = await Categoria.create({ nivel, categoriaEdad: categoriaEdad || null, modalidad, aparato: aparato || null, nombre, orden: orden || 0 })
    res.json(cat)
  } catch (e) {
    console.error('❌ Error creando categoría:', e?.message || e)
    res.status(500).json({ error: 'No se pudo crear la categoría' })
  }
})

app.delete('/api/admin/categorias/:id', requireAuth(['admin','director']), async (req, res) => {
  await Categoria.destroy({ where: { id: req.params.id } })
  res.json({ ok: true })
})

app.post('/api/admin/coreografias', requireAuth(['admin','director']), async (req, res) => {
  try {
    const { categoria_id, nombre, escuela, orden, exhibicion } = req.body || {}
    if (!categoria_id || !nombre) return res.status(400).json({ error: 'Faltan categoria_id y nombre' })
    const cor = await Coreografia.create({ categoria_id, nombre, escuela: escuela || null, orden: orden || 0, exhibicion: !!exhibicion })
    res.json(cor)
  } catch (e) {
    console.error('❌ Error creando coreografía:', e?.message || e)
    res.status(500).json({ error: 'No se pudo crear la coreografía' })
  }
})

app.delete('/api/admin/coreografias/:id', requireAuth(['admin','director']), async (req, res) => {
  await Coreografia.destroy({ where: { id: req.params.id } })
  res.json({ ok: true })
})

// Resultados de una categoría: cada coreografía con sus notas y el puesto.
app.get('/api/admin/resultados/:categoriaId', requireAuth(['admin','director']), async (req, res) => {
  try {
    const coreografias = await Coreografia.findAll({
      where: { categoria_id: req.params.categoriaId },
      include: [{ model: Puntaje, as: 'puntajes', include: [{ model: Usuario, as: 'jueza' }] }],
      order: [['orden', 'ASC'], ['id', 'ASC']],
    })
    const filas = coreografias.map(c => ({
      id: c.id, nombre: c.nombre, escuela: c.escuela, exhibicion: c.exhibicion,
      ...calcularNotas(c.puntajes),
      // Voto de cada jueza por separado, para poder auditar de dónde sale el promedio.
      detalle: c.puntajes.map(p => {
        const bd = p.bd == null ? null : Number(p.bd)
        const da = p.da == null ? null : Number(p.da)
        const ej = p.ejecucion == null ? null : Number(p.ejecucion)
        const ar = p.artistico == null ? null : Number(p.artistico)
        const completa = bd != null && ej != null && ar != null
        return {
          jueza: p.jueza?.nombre || p.jueza?.usuario || 'Jueza',
          bd, da, ejecucion: ej, artistico: ar, completa,
          total: completa ? num2(bd + (da || 0) + ej + ar) : null,
        }
      }).sort((a, b) => String(a.jueza).localeCompare(String(b.jueza))),
    }))
    // Puesto: solo entre las que tienen al menos una planilla completa Y no son exhibición
    // (una exhibición nunca compite, aunque alguien la puntúe por error).
    const completas = filas.filter(f => f.completo && !f.exhibicion).sort((a, b) => b.notaFinal - a.notaFinal)
    completas.forEach((f, i) => { f.puesto = i + 1 })
    res.json(filas)
  } catch (e) {
    console.error('❌ Error calculando resultados:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron calcular los resultados' })
  }
})

// ── JUEZA: ver coreografías de una categoría y cargar su puntaje ──
app.get('/api/jueza/categorias', requireAuth(['jueza', 'admin']), async (req, res) => {
  const categorias = await Categoria.findAll({ order: [['orden', 'ASC'], ['id', 'ASC']] })

  // Avance de ESTA jueza: cuántas coreografías de cada categoría ya dejó
  // completas. Las de exhibición no se puntúan, así que no cuentan.
  const usuario = await Usuario.findOne({ where: { usuario: req.usuario.usuario } })
  const coreografias = await Coreografia.findAll({
    where: { exhibicion: false },
    include: [{ model: Puntaje, as: 'puntajes', where: { usuario_id: usuario?.id || 0 }, required: false }],
  })
  const avance = {}
  for (const c of coreografias) {
    const p = c.puntajes[0]
    const lista = p && p.bd != null && p.ejecucion != null && p.artistico != null
    const x = avance[c.categoria_id] || (avance[c.categoria_id] = { total: 0, hechas: 0 })
    x.total++
    if (lista) x.hechas++
  }

  res.json(categorias.map(c => {
    const x = avance[c.id] || { total: 0, hechas: 0 }
    return { ...c.toJSON(), coreografias: x.total, hechas: x.hechas, completa: x.total > 0 && x.hechas === x.total }
  }))
})

app.get('/api/jueza/categorias/:id/coreografias', requireAuth(['jueza', 'admin']), async (req, res) => {
  try {
    const usuario = await Usuario.findOne({ where: { usuario: req.usuario.usuario } })
    const categoria = await Categoria.findByPk(req.params.id)
    const coreografias = await Coreografia.findAll({
      where: { categoria_id: req.params.id },
      include: [{ model: Puntaje, as: 'puntajes', where: { usuario_id: usuario.id }, required: false }],
      order: [['orden', 'ASC'], ['id', 'ASC']],
    })
    res.json(coreografias.map(c => ({
      aparato: aparatoDeCategoria(categoria),
      id: c.id, nombre: c.nombre, escuela: c.escuela, exhibicion: c.exhibicion,
      // Mi propio puntaje ya cargado para esta coreografía (si existe), para poder editarlo.
      miPuntaje: c.puntajes[0] || null,
    })))
  } catch (e) {
    console.error('❌ Error listando coreografías para jueza:', e?.message || e)
    res.status(500).json({ error: 'No se pudo cargar la lista' })
  }
})

// Qué aparato usa una categoría, o null si es manos libres (y entonces no hay
// DA que puntuar). "ML" es como viene cargado manos libres en las planillas.
function aparatoDeCategoria(categoria) {
  const a = (categoria?.aparato || '').trim()
  if (!a || a.toUpperCase() === 'ML') return null
  return a
}

// Las juezas escriben "8,50" o "8.50" indistintamente: acá se acepta cualquiera
// de las dos y se guarda siempre como número.
function aNumero(n) {
  if (n === null || n === undefined) return NaN
  return Number(String(n).trim().replace(',', '.'))
}

// Rango válido de carga: 0,10 a 10,00 con hasta 2 decimales (indicado por la directora).
function valorValido(n) {
  const x = aNumero(n)
  return Number.isFinite(x) && x >= 0.10 && x <= 10.00
}

app.post('/api/jueza/puntaje', requireAuth(['jueza']), async (req, res) => {
  try {
    const usuario = await Usuario.findOne({ where: { usuario: req.usuario.usuario } })
    const { coreografia_id, bd, da, ejecucion, artistico } = req.body || {}
    if (!coreografia_id) return res.status(400).json({ error: 'Falta coreografia_id' })

    // La jueza puntúa la coreografía entera. DA es la única opcional: en las
    // categorías sin aparato no hay destreza de aparato que puntuar.
    for (const [nombre, valor] of Object.entries({ bd, ejecucion, artistico })) {
      if (!valorValido(valor)) {
        return res.status(400).json({ error: `${nombre.toUpperCase()} debe estar entre 0,10 y 10,00` })
      }
    }
    const daVacia = da === '' || da === null || da === undefined
    if (!daVacia && !valorValido(da)) {
      return res.status(400).json({ error: 'DA debe estar entre 0,10 y 10,00, o vacía si no hay aparato' })
    }

    const datos = {
      coreografia_id, usuario_id: usuario.id,
      bd: num2(aNumero(bd)), da: daVacia ? null : num2(aNumero(da)),
      ejecucion: num2(aNumero(ejecucion)), artistico: num2(aNumero(artistico)),
    }

    // Upsert: si ya había cargado esta coreografía, se actualiza (permite corregir).
    const existente = await Puntaje.findOne({ where: { coreografia_id, usuario_id: usuario.id } })
    const puntaje = existente ? await existente.update(datos) : await Puntaje.create(datos)
    res.json({ ok: true, puntaje })
  } catch (e) {
    console.error('❌ Error guardando puntaje:', e?.message || e)
    res.status(500).json({ error: 'No se pudo guardar el puntaje' })
  }
})

// Config pública para el frontend: el precio y el cargo salen del .env y NO
// se escriben a mano en el HTML (si divergen, el modal muestra un total y el
// checkout cobra otro).
app.get('/api/config', (_req, res) => res.json({
  precio: PRECIO_ENTRADA,
  cargoPct: CARGO_PCT,
  maxEntradas: MAX_ENTRADAS,
  evento: { nombre: EVENTO_NOMBRE, cuando: EVENTO_CUANDO, lugar: EVENTO_LUGAR },
  logosPago: urlLogosPago(),
}))

// Atajos sin ".html": nadie escribe la extensión a mano, y el día del evento
// hay que poder dictar la dirección por teléfono sin deletrear "punto html".
for (const p of ['admin', 'torneo', 'jueza', 'mis-entradas', 'pago-exitoso', 'pago-pendiente', 'pago-fallido']) {
  app.get('/' + p, (_req, res) => res.sendFile(join(__dirname, '..', 'frontend', p + '.html')))
}
// Alias por si lo buscan con otro nombre.
app.get('/juezas',   (_req, res) => res.redirect('/jueza.html'))
app.get('/jurado',   (_req, res) => res.redirect('/jueza.html'))
app.get('/panel',    (_req, res) => res.redirect('/admin.html'))
app.get('/entradas', (_req, res) => res.redirect('/mis-entradas.html'))

app.get('/health', (_req, res) => res.send(`Backend ${EVENTO_NOMBRE} ✅`))

// Levantar el server YA, sin bloquear por la base (Render necesita que responda rápido)
app.listen(PORT, () => {
  console.log(`🚀 Backend corriendo en el puerto ${PORT}`)
  if (!epagosConfigurado()) console.warn('⚠️ Faltan credenciales de ePagos (EPAGOS_*)')
  const amb = epagosEsProduccion() ? 'PRODUCCIÓN' : 'sandbox'
  console.log(`💳 Pagos: ePagos [${amb}] → ${EPAGOS_URLS.checkout} · cargo por servicio ${CARGO_PCT}%`)
  if (!epagosEsProduccion()) console.log('   ⚠️ Sandbox: los pagos NO son reales')
})

// ═══════════════════════════════════════════════════════════════
//  REPESCA DE PAGOS
//
//  La entrada se emite cuando el comprador vuelve de ePagos (/pago/ok) o
//  cuando llega el webhook. Los dos caminos pueden fallar:
//   · el comprador paga y cierra la pestaña sin volver;
//   · el webhook no está registrado o ePagos no lo pudo entregar;
//   · transferencia y homebanking acreditan más tarde, cuando ya se fue.
//
//  Acá le preguntamos a la API por cada orden pendiente. Es el mismo
//  verificarYEmitir que usa el retorno, así que valida el importe igual y
//  nunca emite dos veces (sale si la orden ya está pagada).
// ═══════════════════════════════════════════════════════════════
const REPESCA_MINUTOS = numEnv('REPESCA_MINUTOS', 1)
const REPESCA_HORAS   = numEnv('REPESCA_HORAS', 72)   // hasta dónde mirar atrás
const REPESCA_MAX     = numEnv('REPESCA_MAX', 30)     // órdenes por pasada

let repescaCorriendo = false

async function repescarPagos() {
  if (repescaCorriendo || !epagosConfigurado()) return
  repescaCorriendo = true
  try {
    const desde = new Date(Date.now() - REPESCA_HORAS * 3600 * 1000)
    const pendientes = await Orden.findAll({
      where: { estado: { [Op.in]: ['pendiente', 'abandonada'] }, createdAt: { [Op.gte]: desde } },
      order: [['createdAt', 'DESC']],
      limit: REPESCA_MAX,
    })
    if (!pendientes.length) return

    let emitidas = 0
    for (const orden of pendientes) {
      try {
        if (await verificarYEmitir(orden)) {
          emitidas++
          console.log(`🎟️ Repesca: orden ${orden.id} estaba paga y no se había emitido. Entrada enviada.`)
        }
      } catch (e) {
        console.error(`⚠️ Repesca, orden ${orden.id}:`, e?.message || e)
      }
    }
    if (emitidas) console.log(`✅ Repesca: ${emitidas} de ${pendientes.length} pendientes se emitieron.`)
  } catch (e) {
    console.error('⚠️ Error en la repesca:', e?.message || e)
  } finally {
    repescaCorriendo = false
  }
}


// ═══════════════════════════════════════════════════════════════
//  RECUPERO DE COMPRAS A MEDIO CAMINO
//
//  Cuando alguien aprieta "Ir a pagar" ya tenemos su nombre y su mail.
//  Si media hora después la orden sigue pendiente, le escribimos una vez
//  ofreciéndole ayuda. Nunca dos veces, y nunca a quien ya compró.
// ═══════════════════════════════════════════════════════════════
const RECUPERO_MINUTOS = numEnv('RECUPERO_MINUTOS', 10)   // cuánto esperar antes de escribir
const RECUPERO_HORAS   = numEnv('RECUPERO_HORAS', 48)     // no escribir por órdenes viejas
const RECUPERO_MAX     = numEnv('RECUPERO_MAX', 20)       // tope por pasada

let recuperoCorriendo = false

async function recuperarPendientes() {
  if (recuperoCorriendo) return
  recuperoCorriendo = true
  try {
    const ahora = Date.now()
    const candidatas = await Orden.findAll({
      where: {
        estado: 'pendiente',
        avisadoEn: null,
        metodo: { [Op.notIn]: ['prueba', 'cortesia'] },
        createdAt: {
          [Op.lte]: new Date(ahora - RECUPERO_MINUTOS * 60 * 1000),
          [Op.gte]: new Date(ahora - RECUPERO_HORAS * 3600 * 1000),
        },
      },
      order: [['createdAt', 'ASC']],
      limit: RECUPERO_MAX,
    })
    if (!candidatas.length) return

    const yaEscritos = new Set()
    for (const orden of candidatas) {
      const mail = String(orden.email || '').trim().toLowerCase()
      if (!mail || !mail.includes('@')) { await orden.update({ avisadoEn: new Date() }); continue }

      // Si esa persona ya compró (en esta u otra orden), no la molestamos.
      const compro = await Orden.count({ where: { email: orden.email, estado: 'pagada' } })
      if (compro) { await orden.update({ avisadoEn: new Date() }); continue }

      // Si dejó varios intentos, un solo mail alcanza.
      if (yaEscritos.has(mail)) { await orden.update({ avisadoEn: new Date() }); continue }

      try {
        await enviarMailPendiente(orden)
        yaEscritos.add(mail)
      } catch (e) {
        console.error(`⚠️ No se pudo escribir a ${orden.email}:`, e?.message || e)
      }
      // Se marca igual: si el mail falla, no reintentamos en loop.
      await orden.update({ avisadoEn: new Date() })
    }
    if (yaEscritos.size) console.log(`✅ Recupero: ${yaEscritos.size} recordatorio(s) enviado(s).`)
  } catch (e) {
    console.error('⚠️ Error en el recupero de pendientes:', e?.message || e)
  } finally {
    recuperoCorriendo = false
  }
}

// Conectar a la base en segundo plano y crear las tablas (si no existen)
sequelize.authenticate()
  .then(() => sequelize.sync())
  .then(() => {
    console.log('🗄️  Base MySQL conectada')
    if (REPESCA_MINUTOS > 0) {
      setInterval(repescarPagos, REPESCA_MINUTOS * 60 * 1000)
      setTimeout(repescarPagos, 20000)  // una primera pasada al arrancar
      console.log(`🔁 Repesca de pagos activa: cada ${REPESCA_MINUTOS} min, mirando ${REPESCA_HORAS} h atrás`)
    }
    if (RECUPERO_MINUTOS > 0) {
      setInterval(recuperarPendientes, 5 * 60 * 1000)   // revisar cada 5 minutos
      setTimeout(recuperarPendientes, 90000)            // primera pasada al minuto y medio
      console.log(`✉️ Recupero de compras a medio camino: a los ${RECUPERO_MINUTOS} min de quedar pendiente`)
    }
  })
  .catch(e => {
    console.error('❌ No se pudo conectar a la base:', e?.message || e)
    console.error('   Revisá DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME y el ALLOWLIST de IPs de Aiven')
  })

// Red de seguridad: que un error async no tumbe el proceso (evita el crash-loop)
process.on('unhandledRejection', e => console.error('⚠️ unhandledRejection:', e?.message || e))
process.on('uncaughtException',  e => console.error('⚠️ uncaughtException:', e?.message || e))
