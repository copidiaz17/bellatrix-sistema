process.env.EPAGOS_ENV='prod'; process.env.EPAGOS_ID_ORGANISMO='23619'
process.env.EPAGOS_ID_USUARIO='402008'
process.env.EPAGOS_HASH='5b56da27adf9c876c1171a574e09118e'
process.env.EPAGOS_PASSWORD='f04fcc89164dc8c861b6c2e7ac93389c'
const { consultarPago } = await import('./epagos.js')
const mysql = (await import('mysql2/promise')).default
const { readFileSync } = await import('fs')
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })

const [tot] = await c.query("SELECT estado, COUNT(*) n, SUM(cantidad) entradas, SUM(total) monto FROM ordenes GROUP BY estado")
console.log('RESUMEN:'); console.table(tot)

const [pend] = await c.query("SELECT id,nombre,email,cantidad,total,createdAt FROM ordenes WHERE estado IN ('pendiente','abandonada') ORDER BY createdAt")
console.log(`\nPENDIENTES (${pend.length}) — qué dice ePagos de cada una:`)
for (const o of pend) {
  let est = '—'
  try { const p = await consultarPago({ numeroOperacion: o.id }); est = `${p.estado} (${p.estadoBruto}) ${p.formaPago||''}` }
  catch (e) { est = 'sin datos en ePagos' }
  const min = Math.round((Date.now() - new Date(o.createdAt)) / 60000)
  console.log(`  ${new Date(o.createdAt).toLocaleTimeString('es-AR').padEnd(9)} ${String(o.nombre).slice(0,22).padEnd(22)} ${String(o.cantidad)}u $${o.total}  hace ${min} min  → ${est}`)
  console.log(`     ${o.email}`)
}
await c.end()
