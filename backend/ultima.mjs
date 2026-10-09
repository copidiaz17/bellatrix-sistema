import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [o] = await c.query(`SELECT o.id, o.nombre, o.email, o.cantidad, o.total, o.medioPago, o.estado,
  (SELECT COUNT(*) FROM entradas e WHERE e.orden_id=o.id) qrs,
  DATE_FORMAT(CONVERT_TZ(o.createdAt,'+00:00','-03:00'),'%H:%i') hora
  FROM ordenes o WHERE o.estado='pagada' ORDER BY o.createdAt DESC LIMIT 3`)
console.table(o)
const [[t]] = await c.query("SELECT COUNT(*) compras, SUM(cantidad) entradas, SUM(total) monto FROM ordenes WHERE estado='pagada'")
console.log('TOTAL VENDIDO:', t.compras, 'compras ·', t.entradas, 'entradas · $' + Number(t.monto).toLocaleString('es-AR'))
console.log('  para Emilia (91,8%): $' + Math.round(t.monto*0.918).toLocaleString('es-AR'))
console.log('  para vos    (8,2%) : $' + Math.round(t.monto*0.082).toLocaleString('es-AR'))
await c.end()
