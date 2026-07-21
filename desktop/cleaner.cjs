const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os')
const h=os.homedir()
const rules=[
 {id:'user-temp',title:'用户临时文件',category:'系统',root:path.join(h,'AppData','Local','Temp'),pattern:/.*/,risk:'low',reason:'程序运行时产生，可重新生成。'},
 {id:'crash-dumps',title:'程序崩溃转储',category:'诊断',root:path.join(h,'AppData','Local','CrashDumps'),pattern:/\.dmp$/i,risk:'low',reason:'仅用于崩溃诊断，不影响程序运行。'},
 {id:'chrome-cache',title:'Chrome 缓存',category:'浏览器',root:path.join(h,'AppData','Local','Google','Chrome','User Data'),pattern:/./,risk:'low',reason:'浏览器可重新生成，不触碰书签、密码和 Cookie。'},
 {id:'edge-cache',title:'Edge 缓存',category:'浏览器',root:path.join(h,'AppData','Local','Microsoft','Edge','User Data'),pattern:/./,risk:'low',reason:'浏览器可重新生成，不触碰个人配置。'},
 {id:'npm-cache',title:'npm 缓存',category:'开发工具',root:path.join(h,'AppData','Local','npm-cache'),pattern:/./,risk:'low',reason:'包管理器缓存，构建时可以重新下载。'}
]
function filesFor(rule){if(!fs.existsSync(rule.root))return[];const out=[];const queue=[rule.root];while(queue.length){const dir=queue.pop();let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}for(const e of entries){const p=path.join(dir,e.name);if(e.isDirectory()){if(rule.id.includes('cache')&&e.name!=='Cache'&&dir!==rule.root)continue;queue.push(p)}else if(rule.pattern.test(e.name)){try{const s=fs.statSync(p);out.push({path:p,name:e.name,size:s.size})}catch{}}}}return out}
function scanRule(id){const rule=rules.find(x=>x.id===id);if(!rule)throw new Error('rule-not-found');const files=filesFor(rule);return {id:rule.id,title:rule.title,category:rule.category,risk:rule.risk,reason:rule.reason,files,total:files.reduce((s,x)=>s+x.size,0)}}
module.exports={rules,scanRule}
