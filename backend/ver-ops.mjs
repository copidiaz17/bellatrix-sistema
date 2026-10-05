import 'dotenv/config'
import { consultarPagosPorFecha } from './epagos.js'
const hoy = new Date().toISOString().slice(0,10)
const r = await consultarPagosPorFecha({ desde: hoy, hasta: hoy })
const lista = Array.isArray(r) ? r : (r?.pagos || [])
console.log('operaciones de hoy en el sandbox:', lista.length)
for (const o of lista.slice(-14)) {
  console.log(`${(o.numeroOperacion||'').padEnd(26)} tx=${o.idTransaccion} $${o.importe} estado=${o.estado} (${o.estadoBruto}) ${o.formaPago||''} ${o.fechaPago||''}`)
}
