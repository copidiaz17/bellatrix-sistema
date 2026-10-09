import { readFileSync } from 'fs'
process.env.DB_HOST='ritmica-falube-stock.g.aivencloud.com'; process.env.DB_PORT='23807'
process.env.DB_USER='avnadmin'; process.env.DB_NAME='bellatrix'; process.env.DB_SSL='true'
process.env.DB_PASSWORD=readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim()
const { sequelize } = await import('./database.js')
const { default: Coreografia } = await import('./models/Coreografia.js')
const c = await Coreografia.findOne({ where: { nombre: '67. Constanza Rubio Cruz' } })
if (!c) { console.log('no la encontré'); process.exit(1) }
await c.update({ exhibicion: true })
console.log('marcada como exhibición:', c.nombre)
const total = await Coreografia.count({ where: { exhibicion: true } })
console.log('exhibiciones ahora:', total)
await sequelize.close()
