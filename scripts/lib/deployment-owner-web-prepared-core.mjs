import assert from 'node:assert/strict';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,realpath,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {readD1Migrations} from '@cloudflare/vitest-plugin';

const WORKER='apps/eliotr-web/dist/eliotr_core',CLIENT='apps/eliotr-web/dist/client';
// Exact existing development-only Core profile; all production auth guards remain active.
const ISSUER=['https://owner-e2e','.cloudflareaccess.com'].join(''),AUDIENCE='owner-e2e-audience';
const GETS=new Set(['/api/v1/system/health','/api/v1/system/session','/api/v1/research/projects','/api/v1/system/research-configuration','/api/v1/research/runs']);
const sha=b=>createHash('sha256').update(b).digest('hex');

/** Genuine prepared Core, disposable local D1/R2, RS256/JWKS, no product seed or provider egress. */
export async function createPreparedCoreStartupRuntime({root,sourceCommit,signal,remaining}) {
 root=path.resolve(root);
 const require=createRequire(await realpath(path.join(root,'node_modules/wrangler/package.json')));
 const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
 const workerDir=path.join(root,WORKER),clientDir=path.join(root,CLIENT),pins=[];
 async function pinned(relative,limit=32*1024*1024){
  const file=path.join(root,relative),before=await lstat(file);
  assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=limit);
  assert.equal(await realpath(file),file);
  const bytes=await readFile(file),after=await lstat(file);
  assert.equal(before.size,bytes.length);assert.equal(before.mtimeMs,after.mtimeMs);
  const pin={path:relative,byte_length:bytes.length,sha256:sha(bytes)};pins.push(pin);return bytes;
 }
 const config=JSON.parse(await pinned(WORKER+'/wrangler.json'));
 assert.equal(config.name,'eliotr-core');assert.equal(config.main,'index.js');assert.equal(config.no_bundle,true);
 assert.equal(path.resolve(workerDir,config.assets.directory),clientDir);
 assert.equal(config.assets.binding,'ASSETS');assert.equal(config.vars.DEPLOYMENT_GENERATION,'git-'+sourceCommit.slice(0,12));
 assert(Array.isArray(config.assets.run_worker_first)&&config.assets.run_worker_first.includes('/api/*'));
 const modules=[];
 async function moduleInventory(prefix){
  for(const entry of (await readdir(path.join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   assert(!entry.isSymbolicLink());const relative=prefix+'/'+entry.name;
   if(entry.isDirectory())await moduleInventory(relative);
   else if(/\.m?js$/.test(entry.name)){
    const bytes=await pinned(relative),contents=bytes.toString('utf8');assert(bytes.equals(Buffer.from(contents)));
    modules.push({type:'ESModule',path:path.join(root,relative),contents});assert(modules.length<=512);
   }
  }
 }
 await moduleInventory(WORKER);
 const graph=JSON.parse(await pinned(WORKER+'/owner-worker-graph.json'));
 assert.deepEqual(modules.map(x=>path.relative(workerDir,x.path).split(path.sep).join('/')).sort(),graph.chunks.map(x=>x.fileName).sort(),'Native runtime must use every and only observed emitted chunk');
 const entry=modules.find(x=>x.path===path.join(workerDir,'index.js'));assert(entry);
 modules.splice(modules.indexOf(entry),1);modules.unshift(entry);
 const pair=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await webcrypto.subtle.exportKey('jwk',pair.publicKey),kid:'prepared-startup-key',alg:'RS256',use:'sig',key_ops:['verify']};
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),issued=Math.floor(Date.now()/1000)-1;
 const header=encode({alg:'RS256',kid:jwk.kid,typ:'JWT'}),payload=encode({iss:ISSUER,aud:[AUDIENCE],sub:'prepared-startup-owner',type:'app',nbf:issued,iat:issued,exp:issued+600});
 const signature=await webcrypto.subtle.sign({name:'RSASSA-PKCS1-v1_5'},pair.privateKey,new TextEncoder().encode(header+'.'+payload));
 const token=header+'.'+payload+'.'+Buffer.from(signature).toString('base64url');
 const jwksRequests=[];
 const jwks=createServer((request,response)=>{
  jwksRequests.push({method:request.method,path:request.url});
  if(request.method!=='GET'||request.url!=='/cdn-cgi/access/certs'){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':'application/json','cache-control':'max-age=60'});response.end(JSON.stringify({keys:[jwk]}));
 });
 let mf,disposed=false;
 async function dispose(){
  if(disposed)return;disposed=true;
  try{if(mf)await mf.dispose();}finally{jwks.closeAllConnections();if(jwks.listening)await new Promise((resolve,reject)=>jwks.close(error=>error?reject(error):resolve()));}
 }
 try{
  jwks.listen(0,'127.0.0.1');await once(jwks,'listening');
  const jwksPort=jwks.address().port,tag='prepared-startup-'+randomUUID();
  const overlay={ENVIRONMENT:'development',DEPLOYMENT_GENERATION:'local-'+tag,ACCESS_TEAM_DOMAIN:ISSUER,ACCESS_AUDIENCE:AUDIENCE,ACCESS_SERVICE_PRINCIPALS:'',ACCESS_TEST_JWKS_URL:'http://127.0.0.1:'+jwksPort+'/cdn-cgi/access/certs',AI_GATEWAY_REASONING_URL:'https://provider-disabled.invalid/reasoning',AI_GATEWAY_RETRIEVAL_URL:'https://provider-disabled.invalid/retrieval'};
  const options=convertV4MiniflareOptions({workers:[{
   name:'core',rootPath:workerDir,modulesRoot:workerDir,modules,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
   outboundService:{name:'startup-local-egress'},d1Databases:{CORE_DB:tag+'-core',SEARCH_DB:tag+'-search'},r2Buckets:{WORK_BUCKET:tag+'-work',EVIDENCE_BUCKET:tag+'-evidence'},
   bindings:{...config.vars,...overlay},assets:{directory:clientDir,binding:'ASSETS',routerConfig:{has_user_worker:true},run_worker_first:config.assets.run_worker_first,assetConfig:{not_found_handling:config.assets.not_found_handling}},
   durableObjects:{RESEARCH_SESSION:{className:'ResearchSession',useSQLite:true}},workflows:{RESEARCH_WORKFLOW:{name:tag+'-workflow',className:'ResearchWorkflow'}},queueProducers:{JOB_QUEUE:tag+'-jobs'}
  },{name:'startup-local-egress',modules:true,script:`const port=${JSON.stringify(String(jwksPort))};export default {async fetch(request,env){const u=new URL(request.url);if(request.method!=='GET'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.port!==port||u.pathname!=='/cdn-cgi/access/certs'||u.search||u.hash||u.username||u.password)return new Response('Forbidden',{status:403});return env.LOCAL_JWKS_NETWORK.fetch(request);}};`,serviceBindings:{LOCAL_JWKS_NETWORK:{network:{allow:['127.0.0.1/32']}}}}],host:'127.0.0.1',port:0,inspectorPort:0});
  mf=new Miniflare(options);
  const migrations=[];
  for(const [binding,folder]of [['CORE_DB','core'],['SEARCH_DB','search']]){
   const database=await mf.getD1Database(binding,'core');
   const migrationFiles=(await readdir(path.join(root,'infra/d1/'+folder+'/migrations'))).filter(name=>name.endsWith('.sql')).sort();
   for (const filename of migrationFiles) await pinned('infra/d1/'+folder+'/migrations/'+filename);
   const list=await readD1Migrations(path.join(root,'infra/d1/'+folder+'/migrations'));
   assert.deepEqual(list.map(migration=>migration.name).sort(),migrationFiles,'Applied migrations must equal pinned SQL filenames');
   for(const migration of list){await database.batch(migration.queries.map(sql=>database.prepare(sql)));}
   migrations.push({binding,count:list.length,files:migrationFiles});
  }
  const baseUrl=await mf.ready;assert.equal(baseUrl.hostname,'127.0.0.1');assert.equal(baseUrl.protocol,'http:');
  const database=await mf.getD1Database('CORE_DB','core');
  async function empty(){for(const table of ['research_workflow_run','research_workflow_attempt','artifact_draft_binding']){const row=await database.prepare('SELECT COUNT(*) AS count FROM '+table).first();assert.equal(row.count,0,'Startup profile must not create scientific work');}}
  await empty();
  async function request(pathname,jwt){
   assert(GETS.has(pathname)&&!signal.aborted);
   const response=await fetch(baseUrl.origin+pathname,{method:'GET',headers:{Accept:'application/json',...(jwt?{'cf-access-jwt-assertion':jwt}:{})},redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(30_000,remaining())))])});
   const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<=16*1024*1024);
   return {status:response.status,contentType:response.headers.get('content-type')??'',bytes};
  }
  const missing=await request('/api/v1/system/session');assert.equal(missing.status,401,'Missing JWT response: '+missing.bytes.toString('utf8').slice(0,256));
  const forged=token.slice(0,token.lastIndexOf('.')+1)+Buffer.alloc(256).toString('base64url');
  const invalid=await request('/api/v1/system/session',forged);assert.equal(invalid.status,401);
  return {get:pathname=>request(pathname,token),dispose,async evidence(){
   await empty();assert(jwksRequests.length>0);assert(jwksRequests.every(x=>x.method==='GET'&&x.path==='/cdn-cgi/access/certs'));
   for(const pin of pins){
    const filename=path.join(root,pin.path),before=await lstat(filename);
    assert(before.isFile()&&!before.isSymbolicLink());assert.equal(await realpath(filename),filename);
    assert.equal(before.size,pin.byte_length,'Prepared runtime input size drifted');
    const bytes=await readFile(filename),after=await lstat(filename);
    assert.equal(bytes.length,pin.byte_length);assert.equal(before.mtimeMs,after.mtimeMs);
    assert.equal(sha(bytes),pin.sha256,'Prepared runtime bytes drifted');
   }
   return {protocol:'eliotr.local-prepared-core-startup-runtime.v1',source_commit:sourceCommit,scope:'LOCAL_PREPARED_CORE_EMPTY_D1_R2_SIGNED_JWT_ONLY_NOT_LIVE',pins,migrations,auth:{missing:401,invalid_signature:401,jwks_requests:jwksRequests.length},run_and_draft_tables_empty:true,local_overlay:overlay,provider_execution:'NOT_RUN',remote_mutations:0};
  }};
 }catch(error){await dispose();throw error;}
}

// Re-admission validates retained bytes and their current inputs, not an attestation
// that JSON alone proves execution. Only the owning observer creates this evidence.
export async function readPreparedCoreRuntimeProof(root, descriptor, sourceCommit) {
 root=path.resolve(root);
 const safe=p=>typeof p==='string'&&!path.isAbsolute(p)&&!/[\\:]/u.test(p)&&
  !p.split('/').some(part=>!part||part==='.'||part==='..');
 const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
 const validPin=pin=>exactKeys(pin,['path','byte_length','sha256'])&&safe(pin.path)&&
  Number.isSafeInteger(pin.byte_length)&&pin.byte_length>0&&pin.byte_length<=32*1024*1024&&/^[a-f0-9]{64}$/u.test(pin.sha256);
 async function pinnedBytes(pin) {
  assert(validPin(pin),'Invalid prepared Core pin');
  const file=path.resolve(root,pin.path),before=await lstat(file);
  assert(before.isFile()&&!before.isSymbolicLink());assert.equal(await realpath(file),file);
  assert.equal(before.size,pin.byte_length);
  const bytes=await readFile(file),after=await lstat(file);
  assert.equal(bytes.length,pin.byte_length);assert.equal(sha(bytes),pin.sha256);
  assert.equal(before.mtimeMs,after.mtimeMs);return bytes;
 }
 assert(validPin(descriptor)&&descriptor.byte_length<=1024*1024&&
  /^\.eliotr-state\/owner-web-startup-[a-f0-9-]{36}\/native-core\.json$/u.test(descriptor.path),'Invalid native proof descriptor');
 const proof=JSON.parse((await pinnedBytes(descriptor)).toString('utf8'));
 assert(exactKeys(proof,['protocol','source_commit','scope','pins','migrations','auth','run_and_draft_tables_empty','local_overlay','provider_execution','remote_mutations']));
 assert.equal(proof.protocol,'eliotr.local-prepared-core-startup-runtime.v1');
 assert.equal(proof.source_commit,sourceCommit);assert(/^[a-f0-9]{40}$/u.test(sourceCommit));
 assert.equal(proof.scope,'LOCAL_PREPARED_CORE_EMPTY_D1_R2_SIGNED_JWT_ONLY_NOT_LIVE');
 assert.equal(proof.run_and_draft_tables_empty,true);assert.equal(proof.provider_execution,'NOT_RUN');assert.equal(proof.remote_mutations,0);
 assert(exactKeys(proof.auth,['missing','invalid_signature','jwks_requests']));
 assert.equal(proof.auth.missing,401);assert.equal(proof.auth.invalid_signature,401);
 assert(Number.isSafeInteger(proof.auth.jwks_requests)&&proof.auth.jwks_requests>0&&proof.auth.jwks_requests<=512);
 const overlay=proof.local_overlay;
 assert(exactKeys(overlay,['ENVIRONMENT','DEPLOYMENT_GENERATION','ACCESS_TEAM_DOMAIN','ACCESS_AUDIENCE','ACCESS_SERVICE_PRINCIPALS','ACCESS_TEST_JWKS_URL','AI_GATEWAY_REASONING_URL','AI_GATEWAY_RETRIEVAL_URL']));
 assert.equal(overlay.ENVIRONMENT,'development');assert.equal(overlay.ACCESS_TEAM_DOMAIN,ISSUER);assert.equal(overlay.ACCESS_AUDIENCE,AUDIENCE);
 assert.equal(overlay.ACCESS_SERVICE_PRINCIPALS,'');
 assert(/^local-prepared-startup-[a-f0-9-]{36}$/u.test(overlay.DEPLOYMENT_GENERATION));
 const jwks=new URL(overlay.ACCESS_TEST_JWKS_URL);
 assert.equal(jwks.protocol,'http:');assert.equal(jwks.hostname,'127.0.0.1');
 assert.equal(jwks.pathname,'/cdn-cgi/access/certs');assert(!jwks.search&&!jwks.hash&&!jwks.username&&!jwks.password&&jwks.port);
 assert.equal(overlay.AI_GATEWAY_REASONING_URL,'https://provider-disabled.invalid/reasoning');
 assert.equal(overlay.AI_GATEWAY_RETRIEVAL_URL,'https://provider-disabled.invalid/retrieval');
 assert(Array.isArray(proof.pins)&&proof.pins.length>2&&proof.pins.length<=1024);
 const expected=new Set([WORKER+'/wrangler.json',WORKER+'/owner-worker-graph.json']);
 async function inventory(prefix,extension) {
  const names=[];
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})) {
   assert(!entry.isSymbolicLink());const relative=prefix+'/'+entry.name;
   if(entry.isDirectory())names.push(...await inventory(relative,extension));
   else if(extension.test(entry.name)){assert(entry.isFile());names.push(relative);}
  }
  return names;
 }
 const modules=await inventory(WORKER,/\.m?js$/u);
 assert(modules.length>0&&modules.length<=512,'Prepared module inventory exceeds creator bounds');
 modules.forEach(p=>expected.add(p));
 assert(Array.isArray(proof.migrations)&&proof.migrations.length===2);
 for(const [index,binding,folder]of [[0,'CORE_DB','core'],[1,'SEARCH_DB','search']]) {
  const paths=await inventory('infra/d1/'+folder+'/migrations',/\.sql$/u);
  assert(paths.length>0);assert.deepEqual(proof.migrations[index],{binding,count:paths.length,files:paths.map(p=>path.basename(p)).sort()});
  paths.forEach(p=>expected.add(p));
 }
 const pins=new Map();
 for(const pin of proof.pins){assert(validPin(pin)&&expected.has(pin.path)&&!pins.has(pin.path));pins.set(pin.path,await pinnedBytes(pin));}
 assert.equal(pins.size,expected.size,'Prepared Core input inventory is incomplete');
 const config=JSON.parse(pins.get(WORKER+'/wrangler.json').toString('utf8'));
 assert.equal(config.name,'eliotr-core');assert.equal(config.main,'index.js');assert.equal(config.no_bundle,true);
 assert.equal(config.vars.DEPLOYMENT_GENERATION,'git-'+sourceCommit.slice(0,12));
 assert.equal(config.assets.binding,'ASSETS');assert.equal(path.resolve(root,WORKER,config.assets.directory),path.resolve(root,CLIENT));
 assert(config.assets.run_worker_first.includes('/api/*'));
 const graph=JSON.parse(pins.get(WORKER+'/owner-worker-graph.json').toString('utf8'));
 assert.deepEqual(modules.map(p=>p.slice(WORKER.length+1)).sort(),graph.chunks.map(chunk=>chunk.fileName).sort());
 return proof;
}
