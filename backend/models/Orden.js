import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Una orden de compra de entradas.
const Orden = sequelize.define('Orden', {
  id:        { type: DataTypes.STRING, primaryKey: true },   // 'orden_<uuid>'
  nombre:    { type: DataTypes.STRING, allowNull: false },
  email:     { type: DataTypes.STRING, allowNull: false },
  dni:       { type: DataTypes.STRING, allowNull: true },   // opcional: agiliza la venta en la puerta
  metodo:    { type: DataTypes.STRING, defaultValue: 'mp' },
  cantidad:  { type: DataTypes.INTEGER, allowNull: false },
  subtotal:  { type: DataTypes.INTEGER, allowNull: false },
  cargo:     { type: DataTypes.INTEGER, allowNull: false },
  total:     { type: DataTypes.INTEGER, allowNull: false },
    // 'reversada' = ePagos devolvió o anuló el pago. La entrada deja de servir en la puerta.
  // 'abandonada' = quedó sin pagar y ya se la archivó para no ensuciar el
  // contador del panel. La repesca la sigue mirando: en ePagos figura como
  // adeudada y todavía se puede pagar.
  estado:    { type: DataTypes.ENUM('pendiente', 'pagada', 'reversada', 'abandonada'), defaultValue: 'pendiente' },
  paymentId: { type: DataTypes.STRING, allowNull: true },
  // Con qué medio pagó, según lo que devuelve la API de ePagos.
  // 'transferencia' y 'billetera' comparten comisión pero no plazo de depósito,
  // así que guardamos el instrumento concreto para poder conciliar.
  medioPago: { type: DataTypes.STRING, allowNull: true },   // transferencia, billetera, debin...
  medioId:   { type: DataTypes.STRING, allowNull: true },   // identificador del instrumento
  // Cuándo se le mandó el recordatorio por quedar a mitad de camino.
  // Sirve para no escribirle dos veces a la misma persona.
  avisadoEn: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'ordenes',
  timestamps: true, // createdAt = fecha de la orden
})

export default Orden
