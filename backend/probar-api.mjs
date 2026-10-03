// Casos 21001 y 21002 del plan: conciliación por API contra el sandbox.
import 'dotenv/config'
import { consultarPagosPorFecha, consultarPagosAdicionales } from './epagos.js'
const hoy = new Date().toISOString().slice(0,10)
const ayer = new Date(Date.now()-86400000).toISOString().slice(0,10)
try {
  const r = await consultarPagosPorFecha({ desde: ayer, hasta: hoy })
  const lista = Array.isArray(r) ? r : (r?.pagos || r?.operaciones || [])
  console.log('21001 ObtenerPago por rango', ayer, '→', hoy, ': OK ·', lista.length ?? '—', 'operaciones')
  if (lista.length) console.log('   ejemplo:', JSON.stringify(lista[0]).slice(0,180))
} catch (e) { console.log('21001 FALLÓ:', e.message?.slice(0,200)) }
try {
  const a = await consultarPagosAdicionales({ desde: ayer, hasta: hoy })
  const lista = Array.isArray(a) ? a : (a?.pagos || [])
  console.log('21002 ObtenerPagoAdicionales: OK ·', lista.length ?? '—', 'registros')
} catch (e) { console.log('21002 FALLÓ:', e.message?.slice(0,200)) }
