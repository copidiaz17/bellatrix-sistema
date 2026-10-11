// Agrega la columna `penalizacion` a la tabla puntajes. Idempotente.
//
//   node migrar-penalizacion.mjs          → base local (la del .env)
//   node migrar-penalizacion.mjs --prod   → base de producción (Aiven)
//
// La penalización es la quinta banca: resta del total, es opcional y no tiene
// tope. Las planillas ya cargadas quedan en 0, así que no cambia ningún puntaje.
import { readFileSync } from 'fs'

const PROD = process.argv.includes('--prod')
if (PROD) {
  process.env.DB_HOST = 'ritmica-falube-stock.g.aivencloud.com'
  process.env.DB_PORT = '23807'
  process.env.DB_USER = 'avnadmin'
  process.env.DB_PASSWORD = readFileSync('C:/patin-fa/backend/aiven.txt', 'utf8').trim()
  process.env.DB_NAME = 'bellatrix'
  process.env.DB_SSL = 'true'
}

const { sequelize } = await import('./database.js')
await sequelize.authenticate()
console.log(PROD ? '→ base de PRODUCCIÓN (Aiven)' : '→ base local')

const cols = await sequelize.getQueryInterface().describeTable('puntajes')
if (cols.penalizacion) {
  console.log('= la columna penalizacion ya existía, no se toca')
} else {
  await sequelize.query('ALTER TABLE puntajes ADD COLUMN penalizacion DECIMAL(5,2) NULL DEFAULT 0')
  console.log('✅ columna penalizacion agregada')
}

const [[{ n }]] = await sequelize.query('SELECT COUNT(*) n FROM puntajes')
console.log(`   ${n} planilla(s) cargadas; las que ya estaban quedan con penalización 0`)
await sequelize.close()
