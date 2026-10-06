import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [o] = await c.query("SELECT estado, COUNT(*) n, SUM(total) monto FROM ordenes GROUP BY estado")
console.log('ÓRDENES EN LA BASE DE PRODUCCIÓN:'); console.table(o)
const [e] = await c.query("SELECT COUNT(*) entradas, SUM(usado) usadas FROM entradas")
console.table(e)
const [v] = await c.query("SELECT COUNT(*) visitas FROM visitas")
console.table(v)
await c.end()
