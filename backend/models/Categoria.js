import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Cada categoría agrupa coreografías que compiten entre sí (mismo ranking).
// Ej: nivel "C", categoriaEdad "AC2", modalidad "Individual", aparato "Aro".
// Las 4 dimensiones vienen de la planilla real del torneo: Nivel (Escuela/C) +
// Categoría por edad (Baby, Pre Mini, Mini, AC2, AC3, Juvenil, Mayor...) +
// Modalidad (Individual/Dúo/Trío/Conjunto) + Aparato.
const Categoria = sequelize.define('Categoria', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  nombre:        { type: DataTypes.STRING, allowNull: false },  // "C · AC2 · Individual · Aro"
  nivel:         { type: DataTypes.STRING, allowNull: false },  // Escuela, C, ...
  categoriaEdad: { type: DataTypes.STRING, allowNull: true },   // Baby, Pre Mini, Mini, AC2, AC3, Juvenil, Mayor
  modalidad:     { type: DataTypes.STRING, allowNull: false },  // Individual, Dúo, Trío, Conjunto
  aparato:       { type: DataTypes.STRING, allowNull: true },   // Aro, Pelota, Cinta, Mazas, Soga, ML (opcional)
  orden:         { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // para listar en un orden fijo
}, {
  tableName: 'categorias',
  timestamps: true,
})

export default Categoria
