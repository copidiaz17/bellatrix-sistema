import 'dotenv/config'
import { consultarPago } from './epagos.js'
const txs = ['6431927','6431928']   // 11004 y 11006, abandonadas
for (let i=0;i<40;i++) {
  const estados = []
  for (const tx of txs) {
    const p = await consultarPago({ idTransaccion: tx })
    estados.push(`${tx}=${p.estado}(${p.estadoBruto})`)
  }
  console.log(new Date().toLocaleTimeString('es-AR'), estados.join('  '))
  if (estados.every(e=>/cancelado/.test(e))) { console.log('LISTO: las dos quedaron canceladas'); break }
  await new Promise(r=>setTimeout(r,60000))
}
