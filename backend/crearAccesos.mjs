// Accesos separados por disciplina, para el día del torneo.
//
//   · Mesa de cómputo: carga las planillas que le pasan los jueces en papel.
//     Entra en /jueza.html y ve SOLO las categorías de su disciplina.
//   · Resultados: ve los puestos de su disciplina en /torneo.html, sin poder
//     crear ni borrar nada (eso quedó solo para los admin).
//
//   node crearAccesos.mjs            → base local
//   node crearAccesos.mjs --prod     → base de producción (Aiven)
//   node crearAccesos.mjs --prod --reset  → vuelve a poner estas contraseñas
//
// Idempotente: si el usuario ya existe, no se toca (salvo con --reset).
import { scryptSync, randomBytes } from 'crypto'
import { readFileSync } from 'fs'

const PROD = process.argv.includes('--prod')
const RESET = process.argv.includes('--reset')
if (PROD) {
  process.env.DB_HOST = 'ritmica-falube-stock.g.aivencloud.com'
  process.env.DB_PORT = '23807'
  process.env.DB_USER = 'avnadmin'
  process.env.DB_PASSWORD = readFileSync('C:/patin-fa/backend/aiven.txt', 'utf8').trim()
  process.env.DB_NAME = 'bellatrix'
  process.env.DB_SSL = 'true'
}

const { sequelize } = await import('./database.js')
const { default: Usuario } = await import('./models/Usuario.js')
await sequelize.authenticate()
await Usuario.sync()

// El rol 'director' ya lo aceptaba el código, pero nunca se había agregado al
// ENUM de la tabla. Sin esto, crear el usuario falla con "Data truncated".
const [[col]] = await sequelize.query("SHOW COLUMNS FROM usuarios LIKE 'rol'")
if (!String(col.Type).includes('director')) {
  await sequelize.query(
    "ALTER TABLE usuarios MODIFY rol ENUM('admin','control','venta','jueza','director') NOT NULL")
  console.log("✅ se agregó el rol 'director' a la tabla usuarios")
}

const ACCESOS = [
  // Carga de planillas (rol jueza → entra en /jueza.html)
  { usuario: 'carga-ritmica',      clave: 'rit2026',    rol: 'jueza',    disciplina: 'Rítmica',
    nombre: 'Mesa de cómputo · Rítmica' },
  { usuario: 'carga-artistica',    clave: 'art2026',    rol: 'jueza',    disciplina: 'Artística',
    nombre: 'Mesa de cómputo · Artística' },
  // Resultados (rol director → entra en /torneo.html, solo mira)
  { usuario: 'resultados-ritmica', clave: 'verrit2026', rol: 'director', disciplina: 'Rítmica',
    nombre: 'Resultados · Rítmica' },
  { usuario: 'resultados-artistica', clave: 'verart2026', rol: 'director', disciplina: 'Artística',
    nombre: 'Resultados · Artística' },
]

for (const a of ACCESOS) {
  const salt = randomBytes(8).toString('hex')
  const datos = {
    usuario: a.usuario, nombre: a.nombre, rol: a.rol, disciplina: a.disciplina,
    salt, hash: scryptSync(a.clave, salt, 64).toString('hex'),
  }
  const ya = await Usuario.findOne({ where: { usuario: a.usuario } })
  if (ya && !RESET) {
    console.log(`= ${a.usuario.padEnd(22)} ya existía, no se toca`)
  } else {
    ya ? await ya.update(datos) : await Usuario.create(datos)
    console.log(`✅ ${a.usuario.padEnd(22)} ${a.clave.padEnd(12)} ${a.disciplina}`)
  }
}

// El usuario único de carga quedó reemplazado por los dos de arriba.
const viejo = await Usuario.findOne({ where: { usuario: 'mesa' } })
if (viejo) { await viejo.destroy(); console.log('🗑️  se borró el usuario "mesa" (lo reemplazan los dos de carga)') }

await sequelize.close()
