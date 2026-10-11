// Habilita o deshabilita accesos, sin borrarlos. Un usuario deshabilitado
// existe igual (y conserva su contraseña), pero no puede entrar.
//
//   node accesos.mjs --prod                      → lista cómo está cada uno
//   node accesos.mjs --prod --off damian luisina → los deja afuera
//   node accesos.mjs --prod --on damian          → lo vuelve a habilitar
//
// Para el torneo se usan solo los accesos de carga y de resultados; los de los
// jueces quedan deshabilitados para que nadie cargue en paralelo con la mesa y
// el sistema promedie dos planillas de la misma gimnasta.
import { readFileSync } from 'fs'

const args = process.argv.slice(2)
const PROD = args.includes('--prod')
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

// La columna es nueva: se agrega sola la primera vez.
const cols = await sequelize.getQueryInterface().describeTable('usuarios')
if (!cols.activo) {
  await sequelize.query('ALTER TABLE usuarios ADD COLUMN activo TINYINT(1) NOT NULL DEFAULT 1')
  console.log('✅ se agregó la columna activo (todos quedan habilitados)')
}

const prender = args.includes('--on')
const apagar  = args.includes('--off')
const quienes = args.filter(a => !a.startsWith('--'))

if (prender || apagar) {
  if (!quienes.length) { console.log('Decime a qué usuarios, ej: --off damian luisina'); process.exit(1) }
  for (const nombre of quienes) {
    const u = await Usuario.findOne({ where: { usuario: nombre } })
    if (!u) { console.log(`⚠️  no existe "${nombre}"`); continue }
    await u.update({ activo: prender })
    console.log(`${prender ? '✅ habilitado  ' : '🚫 deshabilitado'} ${nombre}`)
  }
  console.log('')
}

const todos = await Usuario.findAll({ order: [['rol', 'ASC'], ['usuario', 'ASC']] })
console.table(todos.map(u => ({
  usuario: u.usuario, rol: u.rol, disciplina: u.disciplina || '—',
  entra: u.activo === false ? 'NO' : 'sí',
})))
await sequelize.close()
