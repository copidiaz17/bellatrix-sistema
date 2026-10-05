import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
const [ordenes] = await c.query("SELECT id,estado,total,email,createdAt FROM ordenes ORDER BY createdAt DESC LIMIT 4")
console.table(ordenes)
const [ent] = await c.query("SELECT * FROM entradas ORDER BY createdAt DESC LIMIT 4")
console.table(ent)
await c.end()
