import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'
const c = await mysql.createConnection({ host:'ritmica-falube-stock.g.aivencloud.com', port:23807, user:'avnadmin',
  password: readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim(), database:'bellatrix',
  ssl:{ ca: readFileSync('aiven-ca.crt') } })
for (const [tabla, sql] of [
  ['categorias', "ALTER TABLE categorias ADD COLUMN disciplina VARCHAR(30) NOT NULL DEFAULT 'Rítmica'"],
  ['usuarios',   "ALTER TABLE usuarios ADD COLUMN disciplina VARCHAR(30) NULL"],
]) {
  const [[hay]] = await c.query(`SHOW COLUMNS FROM ${tabla} LIKE 'disciplina'`).then(r=>[r[0]])
  if (hay) { console.log(`${tabla}: ya tenía la columna`); continue }
  await c.query(sql)
  console.log(`${tabla}: columna disciplina agregada`)
}
const [[p]] = await c.query("SELECT COUNT(*) n FROM puntajes")
console.log('puntajes cargados:', p.n, p.n ? '⚠️ OJO: recargar borraría puntajes' : '(se puede recargar sin riesgo)')
await c.end()
