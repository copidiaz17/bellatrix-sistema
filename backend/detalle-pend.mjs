import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [cols] = await c.query("SHOW COLUMNS FROM ordenes")
console.log('columnas:', cols.map(c=>c.Field).join(', '))
const [p] = await c.query("SELECT id,nombre,email,cantidad,estado,medioPago,avisadoEn,createdAt,updatedAt FROM ordenes WHERE estado='pendiente' ORDER BY createdAt")
console.table(p.map(o=>({ nombre:o.nombre, medio:o.medioPago, aviso:o.avisadoEn, creada:new Date(o.createdAt).toISOString().slice(11,16) })))
const [pag] = await c.query("SELECT nombre,cantidad,total,medioPago,createdAt FROM ordenes WHERE estado='pagada' ORDER BY createdAt")
console.log('PAGADAS:'); console.table(pag.map(o=>({ nombre:o.nombre, u:o.cantidad, total:o.total, medio:o.medioPago, hora:new Date(o.createdAt).toISOString().slice(11,16) })))
await c.end()
