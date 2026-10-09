import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [f] = await c.query(`SELECT nombre,email,cantidad,total,estado,medioPago,medioId,
  DATE_FORMAT(CONVERT_TZ(createdAt,'+00:00','-03:00'),'%d/%m %H:%i') hora
  FROM ordenes
  WHERE DATE(CONVERT_TZ(createdAt,'+00:00','-03:00')) = DATE(CONVERT_TZ(NOW(),'+00:00','-03:00'))
  ORDER BY createdAt`)
console.log('ÓRDENES DE HOY (7/10):', f.length)
console.table(f)
await c.end()
