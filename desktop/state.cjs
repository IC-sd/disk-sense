const fs = require('node:fs'); const path = require('node:path')
function store(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); let data={version:1,snapshots:[],memories:[],events:[]}; try{data={...data,...JSON.parse(fs.readFileSync(file,'utf8'))}}catch{}; return { read:()=>data, save:()=>fs.writeFileSync(file,JSON.stringify(data,null,2),'utf8') } }
module.exports={store}
