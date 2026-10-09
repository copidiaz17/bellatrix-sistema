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
const [[h]] = await c.query("SELECT DATE_FORMAT(CONVERT_TZ(NOW(),'+00:00','-03:00'),'%H:%i:%s') h")
console.log('ahora:', h.h)
const [f] = await c.query(`SELECT id,nombre,cantidad,estado,
  DATE_FORMAT(CONVERT_TZ(createdAt,'+00:00','-03:00'),'%H:%i') hora
  FROM ordenes WHERE estado<>'pagada' AND createdAt >= UTC_TIMESTAMP() - INTERVAL 3 HOUR ORDER BY createdAt`)
for (const o of f) {
  let p = {}
  try { p = await consultarPago({ numeroOperacion: o.id }) } catch(e) { p = { estado:'sin datos' } }
  console.log(`${o.hora}  ${o.nombre.trim()}  ${o.cantidad}u → ePagos: ${p.estado} ${p.formaPago||''} ${p.medioPago||''}`)
}
await c.end()
