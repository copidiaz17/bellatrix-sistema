import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// La planilla que carga UNA jueza para UNA coreografía: la puntúa entera.
//   Nota D = bd + da
//   Nota final de esa jueza = D + ejecucion + artistico − penalizacion
// `ejecucion` y `artistico` se guardan como DESCUENTO (la resta del tope se hace
// al calcular). La penalización es la quinta banca: resta del total, es opcional
// y no tiene tope.
// Con varias juezas, la nota que define el puesto es el PROMEDIO de las notas
// finales (se calcula al vuelo en /api/admin/resultados, no se guarda acá).
const Puntaje = sequelize.define('Puntaje', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  coreografia_id:{ type: DataTypes.INTEGER, allowNull: false },
  usuario_id:    { type: DataTypes.INTEGER, allowNull: false }, // la jueza que cargó
  bd:            { type: DataTypes.DECIMAL(4, 2), allowNull: true },
  da:            { type: DataTypes.DECIMAL(4, 2), allowNull: true },
  ejecucion:     { type: DataTypes.DECIMAL(4, 2), allowNull: true },
  artistico:     { type: DataTypes.DECIMAL(4, 2), allowNull: true },
  penalizacion:  { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 0 },
}, {
  tableName: 'puntajes',
  timestamps: true,
  indexes: [
    // Una jueza carga UNA planilla por coreografía (se actualiza, no se duplica).
    { unique: true, fields: ['coreografia_id', 'usuario_id'] },
  ],
})

export default Puntaje
