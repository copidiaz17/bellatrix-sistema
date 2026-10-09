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

const [[hora]] = await c.query("SELECT DATE_FORMAT(CONVERT_TZ(NOW(),'+00:00','-03:00'),'%d/%m %H:%i') h")
console.log('ahora en Argentina:', hora.h, '\n')

const [filas] = await c.query(`SELECT id,nombre,email,cantidad,total,estado,medioPago,
  DATE_FORMAT(CONVERT_TZ(createdAt,'+00:00','-03:00'),'%H:%i') hora
  FROM ordenes WHERE createdAt >= UTC_TIMESTAMP() - INTERVAL 24 HOUR ORDER BY createdAt`)

const pagadas = filas.filter(f=>f.estado==='pagada')
const otras   = filas.filter(f=>f.estado!=='pagada')
const mailsQueCompraron = new Set(pagadas.map(f=>String(f.email).trim().toLowerCase()))

console.log(`ÚLTIMAS 24 HORAS: ${filas.length} órdenes · ${pagadas.length} pagadas · ${otras.length} sin pagar\n`)
console.log('PAGADAS:')
pagadas.forEach(f=>console.log(`  ${f.hora}  ${String(f.nombre).trim().slice(0,24).padEnd(24)} ${f.cantidad}u  $${f.total}  ${f.medioPago||''}`))

console.log('\nSIN PAGAR — qué dice ePagos y si esa persona compró igual:')
let perdidas = 0
for (const f of otras) {
  let est='—'
  try { const p = await consultarPago({ numeroOperacion: f.id }); est = `${p.estado}` } catch { est='sin datos' }
  const compro = mailsQueCompraron.has(String(f.email).trim().toLowerCase())
  if (!compro) perdidas++
  console.log(`  ${f.hora}  ${String(f.nombre).trim().slice(0,24).padEnd(24)} ${f.cantidad}u  $${f.total}  ePagos: ${est.padEnd(10)} ${compro ? '→ despues COMPRO ✅' : '→ NO compro ❌  ' + f.email}`)
}
const entradas = pagadas.reduce((a,f)=>a+f.cantidad,0), monto = pagadas.reduce((a,f)=>a+Number(f.total),0)
const personas = new Set(filas.map(f=>String(f.email).trim().toLowerCase())).size
console.log(`\nRESULTADO: ${entradas} entradas · $${monto.toLocaleString('es-AR')}`)
console.log(`Personas que intentaron: ${personas} · compraron ${mailsQueCompraron.size} (${Math.round(100*mailsQueCompraron.size/personas)}%) · quedaron sin comprar ${perdidas}`)
await c.end()
