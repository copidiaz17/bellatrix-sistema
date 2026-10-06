import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [[o]] = await c.query("SELECT id, createdAt, updatedAt, estado FROM ordenes ORDER BY createdAt DESC LIMIT 1")
const [[e]] = await c.query("SELECT createdAt FROM entradas ORDER BY createdAt DESC LIMIT 1")
const t = x => new Date(x).toLocaleTimeString('es-AR')
console.log('orden creada  :', t(o.createdAt))
console.log('orden pagada  :', t(o.updatedAt), `(${Math.round((new Date(o.updatedAt)-new Date(o.createdAt))/1000)} s después de crearla)`)
console.log('entrada emitida:', t(e.createdAt), `(${Math.round((new Date(e.createdAt)-new Date(o.updatedAt))/1000)} s después de marcarla pagada)`)
await c.end()
