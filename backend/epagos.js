// ───────────────────────────────────────────────────────────────
//  Integración ePagos — E-Checkout + verificación por API (SOAP)
//
//  Flujo:
//   1) obtenerTokenCheckout()  -> POST {BASE}/post.php con las credenciales
//   2) construirCheckout()     -> devuelve URL + campos para un POST de form
//   3) ePagos redirige (POST) a ok_url / error_url
//   4) El webhook avisa el pago... pero NO viene firmado:
//      SIEMPRE reconfirmar con consultarPago() antes de emitir entradas.
// ───────────────────────────────────────────────────────────────

const VERSION      = '1.0'  // versión del protocolo del E-Checkout
const VERSION_API  = '2.0'  // versión a informar en los métodos SOAP

// ⚠️ Leemos process.env DENTRO de las funciones, no al importar el módulo:
// los imports de ESM se evalúan antes de que server.js corra dotenv.config(),
// así que a nivel de módulo las variables todavía no existen.
function cfg() {
  const env = (process.env.EPAGOS_ENV || 'sandbox').toLowerCase()
  const esProd = env === 'prod' || env === 'produccion' || env === 'production'
  return {
    esProd,
    urls: esProd
      ? { token: 'https://api.epagos.com/post.php',     checkout: 'https://post.epagos.com',       wsdl: 'https://api.epagos.com/wsdl/2.5/index.php' }
      : { token: 'https://sandbox.epagos.com/post.php', checkout: 'https://postsandbox.epagos.com', wsdl: 'https://sandbox.epagos.com/wsdl/2.5/index.php' },
    idOrganismo: process.env.EPAGOS_ID_ORGANISMO || '',
    idUsuario:   process.env.EPAGOS_ID_USUARIO   || '',
    password:    process.env.EPAGOS_PASSWORD     || '',
    hash:        process.env.EPAGOS_HASH         || '',
    convenio:    process.env.EPAGOS_CONVENIO     || '',
  }
}

// Getter para que server.js pueda loguear a dónde apunta.
export const EPAGOS_URLS = new Proxy({}, { get: (_t, k) => cfg().urls[k] })

export function epagosConfigurado() {
  const c = cfg()
  return Boolean(c.idOrganismo && c.idUsuario && c.password && c.hash)
}

export function epagosEsProduccion() { return cfg().esProd }

// Tipos de forma de pago (tabla oficial de ePagos):
// 1 efectivo · 2 crédito · 3 débito · 4 prepago · 5 publicación de deuda
// (cajeros/homebanking) · 6 billetera ePagos · 7 transferencias · 8 teléfono · 9 cripto
const TIPOS_OFRECIDOS = ['1', '2', '3', '5', '6', '7']

/** Tipos excluidos por configuración, como array de strings. */
export function tiposExcluidos() {
  return String(process.env.EPAGOS_TIPOS_EXCLUIDOS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Imagen oficial con los logos de los medios de pago.
 * Descuenta los tipos excluidos para no mostrar logos de medios que el
 * comprador después no va a encontrar en el checkout.
 */
export function urlLogosPago({ variante = 'mediana' } = {}) {
  const c = cfg()
  const fuera = tiposExcluidos()
  const tipos = TIPOS_OFRECIDOS.filter(t => !fuera.includes(t)).join(',')
  const base = c.esProd ? 'https://api.epagos.com/logos.php' : 'https://sandbox.epagos.com/logos.php'
  return `${base}?id_organismo=${encodeURIComponent(c.idOrganismo)}&tipo_fp=${encodeURIComponent(tipos)}&variante=${variante}`
}

// ───────────────────────────────────────────────────────────────
//  1) TOKEN para el E-Checkout
//     OJO: el token que devuelve la API SOAP (obtener_token) NO sirve
//     para iniciar un pago por E-Checkout. Son circuitos distintos.
// ───────────────────────────────────────────────────────────────
export async function obtenerTokenCheckout() {
  if (!epagosConfigurado()) throw new Error('Faltan credenciales de ePagos')

  const c = cfg()
  const body = new URLSearchParams({
    id_organismo: c.idOrganismo, id_usuario: c.idUsuario,
    password: c.password, hash: c.hash,
  })

  const r = await fetch(c.urls.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const txt = await r.text()

  let data
  try { data = JSON.parse(txt) }
  catch { throw new Error(`ePagos devolvió una respuesta inesperada al pedir el token: ${txt.slice(0, 200)}`) }

  // 01001 = "Token generado"
  if (String(data.id_resp) !== '01001' || !data.token) {
    throw new Error(`ePagos rechazó las credenciales (${data.id_resp}): ${data.respuesta || 'sin detalle'}`)
  }
  return data.token
}

// ───────────────────────────────────────────────────────────────
//  2) Campos del POST del checkout
//     Devolvemos url + campos y que el navegador haga el POST del form
//     (el E-Checkout NO se inicia con un simple redirect por GET).
// ───────────────────────────────────────────────────────────────
export async function construirCheckout(orden, { okUrl, errorUrl, detalle = [] }) {
  const c = cfg()
  const token = await obtenerTokenCheckout()

  const campos = {
    version: VERSION,
    operacion: 'op_pago',
    id_organismo: c.idOrganismo,
    token,
    ok_url: okUrl,
    error_url: errorUrl,
    id_moneda_operacion: 1,                       // 1 = ARS
    monto_operacion: Number(orden.total).toFixed(2),
    numero_operacion: orden.id,                   // con esto conciliamos
    // En SANDBOX el plan de pruebas de ePagos pide identificador_externo_2 con
    // el número del caso (11002 = acreditación, 11003 = rechazo, etc.).
    // Solo se permite fuera de producción: el número de orden sigue viajando
    // en numero_operacion, así que la conciliación no se rompe.
    identificador_externo_2: (!c.esProd && process.env.EPAGOS_TEST_ID2) || orden.id,
    opc_email_automatico: 'true',
    // Sin esto (viene en false por defecto) el que paga por transferencia o
    // efectivo termina en "pago pendiente" sin ver NUNCA las instrucciones
    // ni la cuenta destino. Con true, ePagos le muestra la boleta.
    opc_descargar_pdf: 'true',
    opc_pdf: 'true',
    opc_devolver_qr: 'true',
  }
  // El convenio es obligatorio, pero la doc dice que mandando el valor "null"
  // la plataforma lo infiere sola (a nosotros nos asigna el 20349).
  campos.convenio = c.convenio || 'null'

  if (orden.email)  campos.email_pagador = orden.email
  if (orden.nombre) {
    const partes = String(orden.nombre).trim().split(/\s+/)
    campos.nombre_pagador   = partes.shift() || ''
    campos.apellido_pagador = partes.join(' ') || campos.nombre_pagador
  }
  // Si mandamos el número de documento, ePagos EXIGE también el tipo
  // (si no, rechaza con 02005). Confirmado en la tabla oficial: 1 = DNI.
  if (orden.dni && /^\d+$/.test(String(orden.dni))) {
    campos.numero_doc_pagador = orden.dni
    campos.tipo_doc_pagador = process.env.EPAGOS_TIPO_DOC || '1'
  }

  // Permite excluir medios de pago por tipo. Útil si se decide no aceptar
  // tarjeta de crédito (tipo 2), que acredita a 18 días hábiles.
  if (process.env.EPAGOS_TIPOS_EXCLUIDOS) campos.tp_excluidos = process.env.EPAGOS_TIPOS_EXCLUIDOS

  // El detalle va como JSON urlencodeado (así lo pide la documentación).
  if (detalle.length) campos.detalle_operacion = encodeURIComponent(JSON.stringify(detalle))

  return { url: c.urls.checkout, campos }
}

// ───────────────────────────────────────────────────────────────
//  3) Verificación por API (SOAP) — la fuente de verdad
// ───────────────────────────────────────────────────────────────
function escXml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]))
}

async function llamarSoap(metodo, cuerpoXml) {
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:epagos">` +
      `<soapenv:Body><urn:${metodo}>${cuerpoXml}</urn:${metodo}></soapenv:Body>` +
    `</soapenv:Envelope>`

  const r = await fetch(cfg().urls.wsdl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: metodo },
    body: envelope,
  })
  return await r.text()
}

function sacarTag(xml, tag) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'))
  return m ? m[1].trim() : null
}

// Token para consumir métodos de la API (distinto del de checkout)
async function obtenerTokenApi() {
  const c = cfg()
  const xml = await llamarSoap('obtener_token',
    `<version>${VERSION_API}</version>` +
    `<credenciales>` +
      `<id_organismo>${escXml(c.idOrganismo)}</id_organismo>` +
      `<id_usuario>${escXml(c.idUsuario)}</id_usuario>` +
      `<password>${escXml(c.password)}</password>` +
      // La doc dice "Hash" con mayúscula, pero el servidor solo acepta "hash".
      `<hash>${escXml(c.hash)}</hash>` +
    `</credenciales>`)

  const token = sacarTag(xml, 'token')
  if (!token) throw new Error(`No se pudo obtener token de API: ${xml.slice(0, 300)}`)
  return token
}

// ePagos devuelve el estado como UNA LETRA, no como palabra.
// VERIFICADOS con operaciones reales en sandbox:
//   P = pendiente  (operación creada, todavía sin pagar)
//   A = acreditado (pago con tarjeta confirmado → tx 6408203)
//   C = cancelado  (la operación se abandonó o expiró)
//   O = adeudado   (deducido comparando registros completos: las 'O' traen
//                   forma de pago elegida, código de barras y fecha de
//                   vencimiento → la deuda está publicada esperando el pago.
//                   Es el "Adeudado" del diagrama oficial; la A ya estaba
//                   tomada por Acreditado.)
// R sale del diagrama y no se pudo verificar. No importa para la seguridad:
// SOLO la 'A' emite entradas.
const ESTADOS = { P: 'pendiente', A: 'acreditado', O: 'adeudado', R: 'rechazado', C: 'cancelado' }

/**
 * Consulta una operación en ePagos. Es la ÚNICA fuente confiable de que un
 * pago está acreditado: ni el webhook ni el callback vienen firmados.
 * Se busca por id de transacción o por nuestro número de orden.
 */
export async function consultarPago({ idTransaccion, numeroOperacion }) {
  if (!epagosConfigurado()) throw new Error('Faltan credenciales de ePagos')
  const c = cfg()
  const token = await obtenerTokenApi()

  let filtro = ''
  if (idTransaccion)   filtro += `<CodigoUnicoTransaccion>${escXml(idTransaccion)}</CodigoUnicoTransaccion>`
  if (numeroOperacion) filtro += `<ExternoId>${escXml(numeroOperacion)}</ExternoId>`
  if (!filtro) throw new Error('Hay que indicar idTransaccion o numeroOperacion')

  const xml = await llamarSoap('obtener_pagos',
    `<version>${VERSION_API}</version>` +
    `<credenciales>` +
      `<id_organismo>${escXml(c.idOrganismo)}</id_organismo>` +
      `<token>${escXml(token)}</token>` +
    `</credenciales>` +
    `<pago>${filtro}</pago>`)

  const bruto = (sacarTag(xml, 'Estado') || '').trim()
  return {
    estadoBruto: bruto,
    estado: ESTADOS[bruto.toUpperCase()] || (bruto ? bruto.toLowerCase() : null),
    idTransaccion: sacarTag(xml, 'CodigoUnicoTransaccion'),
    numeroOperacion: (sacarTag(xml, 'Externa') || '').trim(),
    importe: Number(sacarTag(xml, 'Importe') || 0),
    convenio: sacarTag(xml, 'Convenio'),
    // Con qué pagó realmente. "Tipo" es la familia (tipo_fp_transferencia,
    // tipo_fp_billetera…) e "Identificador" el instrumento concreto dentro de
    // ella: es lo único que distingue un QR de una transferencia común, que
    // tienen la misma comisión pero distinto plazo de acreditación.
    tipo: (sacarTag(xml, 'Tipo') || '').replace('tipo_fp_', '') || null,
    medioId: sacarTag(xml, 'Identificador') || null,
    fechaAcreditacion: sacarTag(xml, 'FechaAcreditacion') || null,
    crudo: xml,
  }
}

/**
 * Busca operaciones por RANGO DE FECHAS. Es el caso 21001 del plan de
 * certificación de ePagos y la base de la conciliación diaria: permite
 * detectar pagos que el webhook no avisó y evitar emitir dos veces.
 * Fechas en formato AAAA-MM-DD.
 */
export async function consultarPagosPorFecha({ desde, hasta, pagina }) {
  if (!epagosConfigurado()) throw new Error('Faltan credenciales de ePagos')
  const c = cfg()
  const token = await obtenerTokenApi()

  const xml = await llamarSoap('obtener_pagos',
    `<version>${VERSION_API}</version>` +
    `<credenciales>` +
      `<id_organismo>${escXml(c.idOrganismo)}</id_organismo>` +
      `<token>${escXml(token)}</token>` +
    `</credenciales>` +
    `<pago>` +
      `<FechaPagoDesde>${escXml(desde)}</FechaPagoDesde>` +
      `<FechaPagoHasta>${escXml(hasta)}</FechaPagoHasta>` +
      (pagina ? `<Pagina>${escXml(pagina)}</Pagina>` : '') +
    `</pago>`)

  const items = [...xml.matchAll(/<item xsi:type="tns:DatosPagoRespuesta">([\s\S]*?)<\/item>/g)]
  const dato = (frag, tag) => {
    const m = frag.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
    return m ? m[1].trim() : null
  }
  return {
    cantidadTotal: Number(sacarTag(xml, 'cantidadTotal') || 0),
    pagos: items.map(it => ({
      idTransaccion: dato(it[1], 'CodigoUnicoTransaccion'),
      estadoBruto: dato(it[1], 'Estado'),
      estado: ESTADOS[(dato(it[1], 'Estado') || '').toUpperCase()] || null,
      importe: Number(dato(it[1], 'Importe') || 0),
      numeroOperacion: dato(it[1], 'Externa'),
      fechaPago: dato(it[1], 'FechaPago'),
    })),
    crudo: xml,
  }
}

/**
 * Pagos adicionales por rango de fechas (caso 21002 del plan de
 * certificación). Devuelve movimientos complementarios de las rendiciones.
 */
export async function consultarPagosAdicionales({ desde, hasta }) {
  if (!epagosConfigurado()) throw new Error('Faltan credenciales de ePagos')
  const c = cfg()
  const token = await obtenerTokenApi()

  const xml = await llamarSoap('obtener_pagos_adicionales',
    `<version>${VERSION_API}</version>` +
    `<credenciales>` +
      `<id_organismo>${escXml(c.idOrganismo)}</id_organismo>` +
      `<token>${escXml(token)}</token>` +
    `</credenciales>` +
    `<pagos>` +
      `<Fecha_desde>${escXml(desde)}</Fecha_desde>` +
      `<Fecha_hasta>${escXml(hasta)}</Fecha_hasta>` +
    `</pagos>`)

  return {
    idResp: sacarTag(xml, 'id_resp'),
    respuesta: sacarTag(xml, 'respuesta'),
    cantidad: (xml.match(/<item xsi:type="tns:PagosAdicionales[^"]*">/g) || []).length,
    crudo: xml,
  }
}

/**
 * Cancela una o más operaciones en ePagos. Sirve para dar de baja órdenes
 * abandonadas sin esperar el timeout de la plataforma.
 * Recibe un array de id de transacción.
 */
export async function cancelarOperaciones(idsTransaccion) {
  if (!epagosConfigurado()) throw new Error('Faltan credenciales de ePagos')
  const c = cfg()
  const token = await obtenerTokenApi()

  const ops = [].concat(idsTransaccion)
    .map(id => `<item><CodigoUnicoTransaccion>${escXml(id)}</CodigoUnicoTransaccion></item>`).join('')

  const xml = await llamarSoap('cancelar_operacion',
    `<version>${VERSION_API}</version>` +
    `<credenciales>` +
      `<id_organismo>${escXml(c.idOrganismo)}</id_organismo>` +
      `<token>${escXml(token)}</token>` +
    `</credenciales>` +
    `<operaciones>${ops}</operaciones>`)

  const items = [...xml.matchAll(/<item xsi:type="tns:OperacionCancelada">([\s\S]*?)<\/item>/g)]
  const dato = (frag, tag) => {
    const m = frag.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
    return m ? m[1].trim() : null
  }
  return {
    idResp: sacarTag(xml, 'id_resp'),
    respuesta: sacarTag(xml, 'respuesta'),
    operaciones: items.map(it => ({
      idTransaccion: dato(it[1], 'CodigoUnicoTransaccion'),
      idResp: dato(it[1], 'id_resp'),
      descripcion: dato(it[1], 'descripcion'),
    })),
    crudo: xml,
  }
}

/**
 * true SOLO si ePagos confirma que la operación está acreditada Y el importe
 * coincide con el de la orden. Verificar el monto evita que alguien pague
 * menos y se lleve la entrada igual.
 */
export async function pagoAcreditado({ idTransaccion, numeroOperacion, totalEsperado }) {
  const p = await consultarPago({ idTransaccion, numeroOperacion })
  if (p.estado !== 'acreditado') return { ok: false, motivo: `estado=${p.estadoBruto || 'desconocido'}`, pago: p }
  if (totalEsperado != null && Math.round(p.importe) !== Math.round(Number(totalEsperado))) {
    return { ok: false, motivo: `importe no coincide (ePagos ${p.importe} vs orden ${totalEsperado})`, pago: p }
  }
  return { ok: true, pago: p }
}
