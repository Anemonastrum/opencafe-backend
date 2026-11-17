import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
const port = async () => { const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n; };
const launch = env => {
  const environment = {...process.env,NODE_ENV:'development',JWT_SECRET:'offline-server-check-secret-at-least-32-bytes',...env};
  delete environment.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--import','tsx','src/server.js'],{env:environment,stdio:['ignore','pipe','pipe']});
  let text='';child.stdout.on('data',b=>{text+=b;});child.stderr.on('data',b=>{text+=b;});
  const ended=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal,text})));
  return {child,ended,text:()=>text};
};
const wait = async fn => {const until=Date.now()+10000;while(!fn()){assert.ok(Date.now()<until,'Server readiness timeout');await new Promise(r=>setTimeout(r,30));}};
test('two listeners start and stop together; occupied or equal port fails closed',async()=>{
  const api=await port(),image=await port();assert.notEqual(api,image);
  const args={HOST:'127.0.0.1',PORT:String(api),IMAGE_HOST:'127.0.0.1',IMAGE_PORT:String(image),IMAGE_BASE_URL:`http://localhost:${image}`};
  const run=launch(args);
  try {
    await wait(()=>run.text().includes('Image server listening'));
    assert.equal((await fetch(`http://127.0.0.1:${api}/api/auth/me`)).status,401);
    assert.equal((await fetch(`http://127.0.0.1:${image}/api/auth/me`)).status,404);
  }finally{run.child.kill('SIGTERM');}
  assert.equal((await run.ended).code,0);
  await assert.rejects(fetch(`http://127.0.0.1:${api}/`));await assert.rejects(fetch(`http://127.0.0.1:${image}/`));
  const equal=launch({...args,IMAGE_PORT:String(api)});const eq=await equal.ended;assert.notEqual(eq.code,0);
  const busy=createServer();await new Promise(r=>busy.listen(image,'127.0.0.1',r));
  try {const failed=launch(args);const result=await failed.ended;assert.notEqual(result.code,0);await assert.rejects(fetch(`http://127.0.0.1:${api}/`));}
  finally{await new Promise(r=>busy.close(r));}
});
