const path = require('node:path')
const { createNtfsClient } = require('../desktop/ntfs-client.cjs')
;(async () => {
  const client = await createNtfsClient(path.resolve(process.env.DISK_SENSE_NTFS_CACHE || 'release-search-validation/ntfs-native-cache'), { elevate: process.argv.includes('--elevate') })
  if (!client) { console.log(JSON.stringify({ available: false, reason: 'Windows required' })); return }
  try {
    const roots = process.argv.slice(2).filter(value => !value.startsWith('--'))
    for (const root of roots.length ? roots : ['C:\\', 'D:\\']) {
      for await (const event of client.request({ op: 'probe', root })) console.log(JSON.stringify(event))
    }
  } finally { client.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
