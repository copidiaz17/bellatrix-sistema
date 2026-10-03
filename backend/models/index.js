// Modelos + asociaciones. Importá siempre desde acá.
import { sequelize } from '../database.js'
import Orden from './Orden.js'
import Entrada from './Entrada.js'
import Usuario from './Usuario.js'
import Visita from './Visita.js'
import Categoria from './Categoria.js'
import Coreografia from './Coreografia.js'
import Puntaje from './Puntaje.js'

Orden.hasMany(Entrada, { as: 'qrs', foreignKey: 'orden_id', onDelete: 'CASCADE' })
Entrada.belongsTo(Orden, { as: 'orden', foreignKey: 'orden_id' })

Categoria.hasMany(Coreografia, { as: 'coreografias', foreignKey: 'categoria_id', onDelete: 'CASCADE' })
Coreografia.belongsTo(Categoria, { as: 'categoria', foreignKey: 'categoria_id' })

Coreografia.hasMany(Puntaje, { as: 'puntajes', foreignKey: 'coreografia_id', onDelete: 'CASCADE' })
Puntaje.belongsTo(Coreografia, { as: 'coreografia', foreignKey: 'coreografia_id' })

Usuario.hasMany(Puntaje, { as: 'puntajesCargados', foreignKey: 'usuario_id' })
Puntaje.belongsTo(Usuario, { as: 'jueza', foreignKey: 'usuario_id' })

export { sequelize, Orden, Entrada, Usuario, Visita, Categoria, Coreografia, Puntaje }
