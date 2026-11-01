/** 显式授权后的隔离桌面验证：只读取所选模型配置，代理限制实际请求总数，不复制真实密钥到测试数据库。 */
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const origin=option('--origin') || 'http://localhost:4414'
const source=option('--models-db'),output=option('--output'),limit=Number(option('--max-requests'))
if(!source||!output||!Number.isInteger(limit)||limit<1)throw Error('必须明确 --models-db、--output、--max-requests；仅在得到真实请求授权后运行')
const out=resolve(output);mkdirSync(out,{recursive:true,mode:0o700})
const db=new DatabaseSync(resolve(source),{readOnly:true})
const setting=key=>{const r=db.prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?").get(JSON.stringify(key));return r?JSON.parse(r.value):null}
const config=JSON.parse(setting('ew-local-ai-models')),selected=setting('ew-agent-pi-model'),model=config.models.find(m=>String(m.id)===String(selected));db.close()
if(!model||model.status!==1||model.scene!=='text')throw Error('现有 Agent 模型未配置或不可用')
let count=0,phase='',child;const requests=[]
const ledger=()=>writeFileSync(resolve(out,'request-ledger.json'),JSON.stringify({model:model.modelCode,limit,count,requests},null,2),{mode:0o600})
const server=createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin',origin)
 let record
 try{
  if(req.url==='/fixture' && option('--fixture')){res.setHeader('content-type','application/json');res.end(readFileSync(resolve(option('--fixture'))));return}
  if(req.url==='/settings'){res.end(JSON.stringify({modelCode:model.modelCode,provider:model.provider,maxContext:model.maxContext,maxOutputTokens:model.maxOutputTokens,thinking:model.thinking}));return}
  if(req.url==='/status'){res.end(JSON.stringify({count,remaining:limit-count}));return}
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}')
  if(req.url==='/case'){phase=body.name;res.end('{}');return}
  if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return}
  if(count>=limit){res.writeHead(402);res.end(JSON.stringify({error:{message:'隔离验证请求预算已用完'}}));return}
  record={number:++count,scenario:phase,requestKind:body.tool_choice?.function?.name==='resolve_author_input'?'decision':'agent',tools:(body.tools||[]).map(t=>t.function.name),startedAt:Date.now(),messageRoles:(body.messages||[]).map(m=>m.role),lastUserMessage:(body.messages||[]).filter(m=>m.role==='user').at(-1)?.content,lastToolMessage:(body.messages||[]).filter(m=>m.role==='tool').at(-1)?.content};requests.push(record);ledger()
  const abort=new AbortController();res.once('close',()=>abort.abort())
  const upstream=await fetch(model.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+model.apiKey},body:JSON.stringify(body),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120000)])})
  record.status=upstream.status;ledger()
  if(!upstream.ok){res.writeHead(upstream.status);res.end(JSON.stringify({error:{message:'隔离验证模型请求失败，HTTP '+upstream.status}}));return}
  res.writeHead(200,{'content-type':upstream.headers.get('content-type') || (body.stream?'text/event-stream':'application/json')});for await(const chunk of upstream.body){appendFileSync(resolve(out,'response-'+record.number+'.sse'),chunk,{mode:0o600});res.write(chunk)}res.end()
 }catch(error){if(!res.headersSent)res.writeHead(500);res.end();if(record)record.error=error.name;ledger()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const relay='http://127.0.0.1:'+server.address().port
const configFile=resolve(out,'tauri-real.json')
const reuseId=option('--isolated-identifier')
if(reuseId && (!['long-resume','serial-review','platform-chapter','platform-default'].includes(option('--scenario')) || !/^com\.yichuang\.writing\.pi-ui-validation\.stage2real[a-f0-9]{32}$/.test(reuseId)))throw Error('只允许接续验收专用的隔离数据')

writeFileSync(configFile,JSON.stringify({productName:'Pi 第二步真实模型隔离验收',identifier:reuseId||('com.yichuang.writing.pi-ui-validation.stage2real'+randomUUID().replaceAll('-','')),build:{beforeDevCommand:'',devUrl:origin+'/tests/'+({'platform-default':'pi-platform-real.html','platform-delivery':'pi-platform-real.html','platform-live-rank':'pi-platform-real.html','platform-chapter':'pi-platform-real.html',platform:'pi-platform-real.html','serial-review':'pi-serial-review.html','long-resume':'pi-long-memory-resume.html','long-memory':'pi-long-memory-real.html','prose-style':'pi-prose-real.html','prose-batch':'pi-prose-batch-real.html','prose-new':'pi-prose-real.html',prose:'pi-prose-real.html',control:'pi-control-real.html',rankings:'pi-ranking-real.html'}[option('--scenario')]||'pi-opening-real.html')+'?'+new URLSearchParams({output:out,relay,...(option('--scenario')?{scenario:option('--scenario')}: {}),...(option('--case-filter')?{caseFilter:option('--case-filter')}: {})})}}))
const fd=openSync(resolve(out,'native.log'),'w',0o600)
try{
 child=spawn('pnpm',['tauri','dev','--config',configFile,'--no-watch','--features','local-tests'],{cwd:process.cwd(),stdio:['ignore',fd,fd],detached:true,env:{...process.env,EW_PI_VALIDATION_UNTHROTTLED:'1'}})
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离验收超时')),900000);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('桌面验收进程退出 '+code))});child.once('error',reject)})
 const result=JSON.parse(readFileSync(resolve(out,'real-results.json'),'utf8'))
 console.log(JSON.stringify({output:out,model:model.modelCode,requests:count,automatedChecksPassed:result.passed,manualReviewRequired:true,scenarios:result.results?.map(r=>({name:r.name,automatedChecksPassed:r.passed,error:r.error}))}))
}finally{try{if(child)process.kill(-child.pid,'SIGTERM')}catch{ /* 子进程可能已经正常退出。 */ }closeSync(fd);server.closeAllConnections();server.close();ledger()}
