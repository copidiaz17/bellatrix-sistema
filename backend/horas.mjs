import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [[t]] = await c.query("SELECT NOW() ahora_base, UTC_TIMESTAMP() ahora_utc, @@session.time_zone zona")
console.log('la base dice que ahora son:', t.ahora_base, '| UTC:', t.ahora_utc, '| zona:', t.zona)
console.log('tu reloj (Argentina):', new Date().toLocaleString('es-AR'))
const [f] = await c.query(`SELECT nombre, estado, cantidad, total,
  DATE_FORMAT(CONVERT_TZ(createdAt,'+00:00','-03:00'), '%d/%m %H:%i') AS hora_arg
  FROM ordenes ORDER BY createdAt`)
console.table(f)
await c.end()
