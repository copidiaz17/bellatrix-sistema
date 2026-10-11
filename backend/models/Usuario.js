import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Usuarios del panel: admin (ve ventas), control (escanea en puerta),
// venta (venta y control manual: ve el listado, muestra QR y genera entradas manuales),
// jueza (carga puntajes en /jueza.html),
// director (mira los resultados en /torneo.html, sin poder crear ni borrar nada).
const Usuario = sequelize.define('Usuario', {
  id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  usuario:  { type: DataTypes.STRING, allowNull: false, unique: true },
  hash:     { type: DataTypes.STRING, allowNull: false },  // scrypt del password
  salt:     { type: DataTypes.STRING, allowNull: false },
  rol:      { type: DataTypes.ENUM('admin', 'control', 'venta', 'jueza', 'director'), allowNull: false },
  // Legado: antes cada jueza cargaba un área. Hoy cargan la planilla entera.
  area:     { type: DataTypes.ENUM('dificultad', 'ejecucion', 'artistico'), allowNull: true },
  nombre:   { type: DataTypes.STRING, allowNull: true },  // nombre a mostrar (ej. en el login de jueza)
  // 'Rítmica' o 'Artística': el usuario ve SOLO las categorías de esa disciplina.
  // Vacío = ve todas (es el caso de los admin).
  disciplina: { type: DataTypes.STRING, allowNull: true },
}, {
  tableName: 'usuarios',
  timestamps: true,
})

export default Usuario
