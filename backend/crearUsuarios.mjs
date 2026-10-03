// Crea los usuarios del panel. Idempotente: si el usuario ya existe, no lo toca.
// Las contraseñas se generan al azar y se imprimen UNA sola vez: no quedan en el código.
//
//   node crearUsuarios.mjs            → crea los que falten
//   node crearUsuarios.mjs --listar   → solo muestra los que ya hay
import { randomBytes, scryptSync } from 'crypto'
import { sequelize } from './database.js'
import Usuario from './models/Usuario.js'

const clave = () => randomBytes(4).toString('hex')            // 8 caracteres, fácil de dictar
const hashear = (pass, salt) => scryptSync(String(pass), salt, 64).toString('hex')

// Las juezas se agregan cuando Emilia confirme los nombres y qué evalúa cada una.
const PERSONAS = [
  { usuario: 'emilia',   rol: 'admin',   nombre: 'María Emilia Manca' },
  { usuario: 'jose',     rol: 'admin',   nombre: 'José Díaz Figueroa' },
  { usuario: 'puerta1',  rol: 'control', nombre: 'Control de puerta 1' },
  { usuario: 'puerta2',  rol: 'control', nombre: 'Control de puerta 2' },
  { usuario: 'puerta3',  rol: 'control', nombre: 'Control de puerta 3' },
]

await sequelize.authenticate()
await Usuario.sync()

if (process.argv.includes('--listar')) {
  const todos = await Usuario.findAll({ order: [['rol', 'ASC'], ['usuario', 'ASC']] })
  todos.forEach(u => console.log(`${u.rol.padEnd(8)} ${u.usuario.padEnd(10)} ${u.nombre || ''}`))
  if (!todos.length) console.log('todavía no hay usuarios')
  process.exit(0)
}

const nuevos = []
for (const p of PERSONAS) {
  if (await Usuario.findOne({ where: { usuario: p.usuario } })) {
    console.log(`= ${p.usuario} ya existía, no se toca`)
    continue
  }
  const pass = clave(), salt = randomBytes(16).toString('hex')
  await Usuario.create({ ...p, salt, hash: hashear(pass, salt) })
  nuevos.push({ ...p, pass })
}

if (nuevos.length) {
  console.log('\n──────── ANOTÁ ESTAS CONTRASEÑAS, NO SE VUELVEN A MOSTRAR ────────')
  nuevos.forEach(n => console.log(`  ${n.rol.padEnd(8)} ${n.usuario.padEnd(10)} ${n.pass}   (${n.nombre})`))
  console.log('───────────────────────────────────────────────────────────────────')
}
await sequelize.close()
