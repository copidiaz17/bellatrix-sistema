import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Usuarios del panel: admin (ve ventas), control (escanea en puerta),
// venta (venta y control manual: ve el listado, muestra QR y genera entradas manuales),
// jueza (carga puntajes de UNA de las 3 áreas: dificultad, ejecución o artístico).
const Usuario = sequelize.define('Usuario', {
  id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  usuario:  { type: DataTypes.STRING, allowNull: false, unique: true },
  hash:     { type: DataTypes.STRING, allowNull: false },  // scrypt del password
  salt:     { type: DataTypes.STRING, allowNull: false },
  rol:      { type: DataTypes.ENUM('admin', 'control', 'venta', 'jueza'), allowNull: false },
  // Solo se usa cuando rol = 'jueza'. Define qué campos carga esa jueza.
  area:     { type: DataTypes.ENUM('dificultad', 'ejecucion', 'artistico'), allowNull: true },
  nombre:   { type: DataTypes.STRING, allowNull: true },  // nombre a mostrar (ej. en el login de jueza)
  // Solo para jueces: 'Rítmica' o 'Artística'. Vacío = ve todas las categorías.
  disciplina: { type: DataTypes.STRING, allowNull: true },
}, {
  tableName: 'usuarios',
  timestamps: true,
})

export default Usuario
