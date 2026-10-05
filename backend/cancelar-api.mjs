import 'dotenv/config'
import { cancelarOperaciones, consultarPago } from './epagos.js'
const tx = process.argv[2]
console.log('antes:', JSON.stringify(await consultarPago({ idTransaccion: tx })).slice(0,160))
try {
  const r = await cancelarOperaciones([tx])
  console.log('cancelación:', JSON.stringify(r).slice(0,200))
} catch (e) { console.log('falló:', e.message?.slice(0,200)) }
await new Promise(r=>setTimeout(r,3000))
console.log('después:', JSON.stringify(await consultarPago({ idTransaccion: tx })).slice(0,160))
