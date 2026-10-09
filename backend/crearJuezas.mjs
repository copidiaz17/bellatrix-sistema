// Crea los usuarios de los jueces de rítmica en la base de PRODUCCIÓN.
// Idempotente: si el usuario existe, solo actualiza el área y el nombre.
//
//   node crearJuezas.mjs            → crea o actualiza
//   node crearJuezas.mjs --listar   → muestra los que hay
import { randomBytes, scryptSync } from 'crypto'
import { readFileSync } from 'fs'

process.env.DB_HOST = 'ritmica-falube-stock.g.aivencloud.com'
process.env.DB_PORT = '23807'
process.env.DB_USER = 'avnadmin'
process.env.DB_NAME = 'bellatrix'
process.env.DB_SSL = 'true'
process.env.DB_PASSWORD = readFileSync('C:/patin-fa/backend/aiven.txt', 'utf8').trim()

const { sequelize } = await import('./database.js')
const { default: Usuario } = await import('./models/Usuario.js')

const hashear = (pass, salt) => scryptSync(String(pass), salt, 64).toString('hex')

// Los tres de rítmica cargan la planilla completa (BD, DA, ejecución y artístico).
// Gabriel ve solo las categorías de artística.
const JUECES = [
  { usuario: 'damian',  pass: 'acosta26',   nombre: 'Damián Acosta',             disciplina: 'Rítmica'   },
  { usuario: 'luisina', pass: 'cuevas26',   nombre: 'Luisina Cuevas',            disciplina: 'Rítmica'   },
  { usuario: 'thiara',  pass: 'gonzalez26', nombre: 'Thiara González Rodríguez', disciplina: 'Rítmica'   },
  { usuario: 'gabriel', pass: 'cardenas26', nombre: 'Gabriel Cárdenas',          disciplina: 'Artística' },
]

await sequelize.authenticate()
await Usuario.sync()

if (process.argv.includes('--listar')) {
  const todos = await Usuario.findAll({ where: { rol: 'jueza' } })
  todos.forEach(u => console.log(`${u.usuario.padEnd(10)} ${String(u.area).padEnd(11)} ${u.nombre}`))
  if (!todos.length) console.log('todavía no hay jueces cargados')
  process.exit(0)
}

for (const j of JUECES) {
  const existente = await Usuario.findOne({ where: { usuario: j.usuario } })
  const salt = randomBytes(16).toString('hex')
  const datos = { rol: 'jueza', disciplina: j.disciplina, nombre: j.nombre, salt, hash: hashear(j.pass, salt) }
  if (existente) { await existente.update(datos); console.log(`actualizado  ${j.usuario}`) }
  else { await Usuario.create({ usuario: j.usuario, ...datos }); console.log(`creado       ${j.usuario}`) }
}

console.log('\n──────── ACCESOS DE LOS JUECES ────────')
JUECES.forEach(j => console.log(`  ${j.nombre.padEnd(26)} usuario: ${j.usuario.padEnd(9)} clave: ${j.pass.padEnd(12)} ${j.disciplina}`))
console.log('  entran en https://bellatrix-2026.onrender.com/jueza.html')
await sequelize.close()
