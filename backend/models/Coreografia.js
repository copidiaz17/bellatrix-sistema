import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Una coreografía = lo que puntúan las juezas. Puede ser una gimnasta sola
// (individual) o un grupo (dúo/trío/conjunto) — "nombre" cubre ambos casos.
const Coreografia = sequelize.define('Coreografia', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  categoria_id:{ type: DataTypes.INTEGER, allowNull: false },
  nombre:      { type: DataTypes.STRING, allowNull: false },  // gimnasta o nombre del conjunto
  escuela:     { type: DataTypes.STRING, allowNull: true },   // de qué escuela/academia viene
  orden:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // orden de salida
  exhibicion:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // no compite, no entra al ranking
}, {
  tableName: 'coreografias',
  timestamps: true,
})

export default Coreografia
