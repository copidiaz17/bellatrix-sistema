// Mismo contenido que crearUsuarios.mjs pero apuntando a Aiven, sin tocar el .env local.
process.env.DB_HOST='ritmica-falube-stock.g.aivencloud.com'
process.env.DB_PORT='23807'
process.env.DB_USER='avnadmin'
process.env.DB_PASSWORD=(await import('fs')).readFileSync('C:/patin-fa/backend/aiven.txt','utf8').trim()
process.env.DB_NAME='bellatrix'
process.env.DB_SSL='true'
await import('./crearUsuarios.mjs')
