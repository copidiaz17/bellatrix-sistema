// Carga el orden de paso (categorías + coreografías) desde datos/orden-de-paso.json.
// Respeta el orden del PDF: el número de salida manda.
//
//   node cargarOrdenDePaso.mjs                 → carga en la base del .env (local)
//   node cargarOrdenDePaso.mjs --prod          → carga en la base de producción (Aiven)
//   node cargarOrdenDePaso.mjs --prod --borrar → borra lo que haya y vuelve a cargar
//
// ⚠️ --borrar elimina también los puntajes cargados. No usarlo el día del torneo.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROD = process.argv.includes('--prod')
const BORRAR = process.argv.includes('--borrar')

if (PROD) {
  process.env.DB_HOST = 'ritmica-falube-stock.g.aivencloud.com'
  process.env.DB_PORT = '23807'
  process.env.DB_USER = 'avnadmin'
  process.env.DB_PASSWORD = readFileSync('C:/patin-fa/backend/aiven.txt', 'utf8').trim()
  process.env.DB_NAME = 'bellatrix'
  process.env.DB_SSL = 'true'
}

const { sequelize } = await import('./database.js')
const { default: Categoria } = await import('./models/Categoria.js')
const { default: Coreografia } = await import('./models/Coreografia.js')

const datos = JSON.parse(readFileSync(join(__dirname, 'datos', 'orden-de-paso.json'), 'utf8'))

await sequelize.authenticate()
await Categoria.sync(); await Coreografia.sync()
console.log(PROD ? '→ base de PRODUCCIÓN (Aiven)' : '→ base local')

if (BORRAR) {
  const { default: Puntaje } = await import('./models/Puntaje.js')
  await Puntaje.destroy({ where: {} })
  await Coreografia.destroy({ where: {} })
  await Categoria.destroy({ where: {} })
  console.log('borrado lo anterior (categorías, coreografías y puntajes)')
}

const yaHay = await Categoria.count()
if (yaHay && !BORRAR) {
  console.log(`Ya hay ${yaHay} categorías cargadas. Usá --borrar si querés reemplazarlas.`)
  process.exit(1)
}

// El nombre visible arma: "C · Ac3 · Individual · Mazas"
const armarNombre = c => [c.disciplina, c.nivel, c.categoriaEdad, c.modalidad, c.aparato].filter(Boolean).join(' · ')

let nCat = 0, nCoreo = 0
for (const [i, c] of datos.categorias.entries()) {
  const cat = await Categoria.create({
    nombre: armarNombre(c),
    disciplina: c.disciplina || 'Rítmica',
    nivel: c.nivel,
    categoriaEdad: c.categoriaEdad || null,
    modalidad: c.modalidad,
    aparato: c.aparato || null,
    orden: (i + 1) * 10,
  })
  nCat++
  for (const [j, co] of c.coreografias.entries()) {
    await Coreografia.create({
      categoria_id: cat.id,
      // El número de salida va adelante: es como las nombran en la pista.
      nombre: `${co.n}. ${co.nombre}`,
      escuela: co.escuela || null,
      orden: (i + 1) * 100 + j,
      exhibicion: !!co.exhibicion,
    })
    nCoreo++
  }
}

console.log(`cargadas ${nCat} categorías y ${nCoreo} coreografías`)
const exh = await Coreografia.count({ where: { exhibicion: true } })
console.log(`de las cuales ${exh} son exhibición (no entran al ranking)`)
await sequelize.close()
