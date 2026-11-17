import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import express from 'express';
import { readFile, access } from 'node:fs/promises';
import { convertImage, saveImage, removeImage } from '../src/utils/image.utils.js';
import { uploadImage } from '../src/middlewares/upload.middleware.js';

const raster = format => sharp({ create: { width: 12, height: 10, channels: 3, background: 'red' } })[format]().toBuffer();
test('image formats must agree; decode and dimensions bounded; output WebP strips metadata', async () => {
  for (const [format, ext, mime] of [['jpeg','jpg','image/jpeg'],['png','png','image/png'],['webp','webp','image/webp']]) {
    const buffer = await raster(format);
    const output = await convertImage({ buffer, originalname: `x.${ext}`, mimetype: mime });
    const meta = await sharp(output).metadata();
    assert.equal(meta.format, 'webp'); assert.equal(meta.width, 12); assert.equal(meta.exif, undefined);
  }
  const png = await raster('png');
  for (const file of [
    { buffer: png, originalname: 'x.jpg', mimetype: 'image/jpeg' },
    { buffer: png, originalname: 'x.png', mimetype: 'text/plain' },
    { buffer: png, originalname: 'x.svg', mimetype: 'image/svg+xml' },
    { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), originalname: 'x.png', mimetype: 'image/png' },
    { buffer: png.subarray(0, 40), originalname: 'x.png', mimetype: 'image/png' },
    { buffer: Buffer.alloc(5 * 1024 * 1024 + 1), originalname: 'x.png', mimetype: 'image/png' },
    { buffer: await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer(), originalname: 'x.png', mimetype: 'image/png' },
    { buffer: await sharp({ create: { width: 4001, height: 4001, channels: 3, background: 'red' } }).png().toBuffer(), originalname: 'x.png', mimetype: 'image/png' },
  ]) await assert.rejects(convertImage(file), e => [400,413].includes(e.status));
});
test('animation rejected and multipart admission/input budgets enforced', async t => {
  // Two-frame GIF, accepted by Sharp decoder but never by upload policy.
  const gif = Buffer.from('R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAAoAAAAsAAAAAAEAAQCBAP8AAAAAAAAAAAAACAQAAQQEADs=', 'base64');
  assert.ok((await sharp(gif, { animated: true }).metadata()).pages > 1);
  const animated = await sharp(gif, { animated: true }).webp().toBuffer();
  assert.ok((await sharp(animated, { animated: true }).metadata()).pages > 1);
  await assert.rejects(convertImage({ buffer: animated, originalname: 'x.webp', mimetype: 'image/webp' }));
  const app = express(); app.post('/', uploadImage('image'), (req,res) => res.json({ ok: true }));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}/`;
  const big=new FormData();big.set('image',new Blob([Buffer.alloc(5*1024*1024+1)],{type:'image/png'}),'x.png');
  assert.equal((await fetch(base,{method:'POST',body:big})).status,413);
  for (const fields of [['wrong'],['image','image']]) {
    const form=new FormData();for(const field of fields)form.append(field,new Blob([await raster('png')],{type:'image/png'}),'x.png');
    assert.equal((await fetch(base,{method:'POST',body:form})).status,400);
  }
});
test('multipart admission rejects fifth active request and recovers capacity', async t => {
  const pending = [];
  const app = express(); app.post('/', uploadImage('image'), (req,res) => pending.push(res));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const send=()=>{const form=new FormData();form.set('name','test');return fetch(`http://127.0.0.1:${server.address().port}/`,{method:'POST',body:form});};
  const requests=Array.from({length:4},send);
  const until=Date.now()+3000;while(pending.length<4){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
  assert.equal((await send()).status,429);
  pending.splice(0).forEach(res=>res.json({ok:true}));await Promise.all(requests);
  const next=send();while(!pending.length)await new Promise(r=>setTimeout(r,10));pending.pop().json({ok:true});assert.equal((await next).status,200);
});
test('disconnected clients retain admission until async handlers settle', async t => {
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/configs/prisma.js');
  const { createAccessToken } = await import('../src/utils/auth.utils.js');
  const originalFind = prisma.authSession.findUnique, originalTransaction = prisma.$transaction;
  const pending = [];
  const user = { id: 1, role: 'ADMIN', isActive: true, mustChangePassword: false };
  prisma.authSession.findUnique = async () => ({ id: 'held', userId: 1, user, expiresAt: new Date(Date.now()+60000) });
  prisma.$transaction = () => new Promise(resolve => pending.push(resolve));
  const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(async () => { pending.splice(0).forEach(resolve=>resolve(null)); prisma.authSession.findUnique=originalFind; prisma.$transaction=originalTransaction; await new Promise(r=>server.close(r)); await prisma.$disconnect(); });
  const png=await raster('png');
  const send = signal => { const form=new FormData();form.set('image',new Blob([png],{type:'image/png'}),'x.png');return fetch(`http://127.0.0.1:${server.address().port}/api/auth/profile`,{method:'PUT',headers:{Authorization:`Bearer ${createAccessToken(1,'held')}`},body:form,signal}); };
  const controllers=Array.from({length:4},()=>new AbortController());
  const requests=controllers.map(c=>send(c.signal).catch(()=>null));
  const until=Date.now()+3000;while(pending.length<4){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
  controllers.forEach(c=>c.abort());await Promise.all(requests);await new Promise(r=>setTimeout(r,30));
  const fifthController=new AbortController();
  const fifth=send(fifthController.signal);
  const response=await Promise.race([fifth,new Promise(resolve=>setTimeout(()=>resolve(null),150))]);
  if(!response){fifthController.abort();await fifth.catch(()=>{});}
  assert.equal(response?.status,429);
  pending.splice(0).forEach(resolve=>resolve(null));await new Promise(r=>setTimeout(r,30));
});
test('APNG animation and missing PNG terminal chunk rejected', async () => {
  const { crc32, deflateSync } = await import('node:zlib');
  const chunk = (type,data) => { const body=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([size,body,crc]); };
  const ihdr=Buffer.from('00000001000000010806000000','hex');
  const frame=seq=>{const b=Buffer.alloc(26);b.writeUInt32BE(seq);b.writeUInt32BE(1,4);b.writeUInt32BE(1,8);b.writeUInt16BE(1,20);b.writeUInt16BE(10,22);return b;};
  const actl=Buffer.alloc(8);actl.writeUInt32BE(2);
  const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
  const animated=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('acTL',actl),chunk('fcTL',frame(0)),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('fcTL',frame(1)),chunk('fdAT',Buffer.concat([sequence,deflateSync(Buffer.from([0,0,0,255,255]))])),chunk('IEND',Buffer.alloc(0))]);
  assert.equal((await sharp(animated).metadata()).format,'png');
  await assert.rejects(convertImage({buffer:animated,originalname:'animated.png',mimetype:'image/png'}),{status:400});
  const png=await raster('png');
  for(const n of [1,2,4,8,12]) await assert.rejects(convertImage({buffer:png.subarray(0,png.length-n),originalname:'x.png',mimetype:'image/png'}),{status:400});
});
test('atomic generated files and cleanup ignore arbitrary/external paths', async () => {
  const saved = await saveImage(await raster('webp'), 'cafe');
  try {
    assert.match(saved.url, /\/uploads\/cafe\/[a-f0-9-]{36}\.webp$/);
    assert.equal((await sharp(await readFile(saved.path)).metadata()).format, 'webp');
    await removeImage('https://example.com/uploads/cafe/x.webp');
    await removeImage(saved.url + '?wrong=1');
    await access(saved.path);
  } finally { await removeImage(saved.url); }
  await assert.rejects(access(saved.path));
  await assert.rejects(saveImage(Buffer.from('x'), '../escape'));
});
test('image server exposes generated WebP paths only, never API or other files', async t => {
  const { imageApp } = await import('../src/image.app.js');
  const { app } = await import('../src/app.js');
  const imageServer = imageApp.listen(0, '127.0.0.1');
  const apiServer = app.listen(0, '127.0.0.1');
  await Promise.all([imageServer, apiServer].map(server => new Promise(resolve => server.once('listening', resolve))));
  t.after(async () => { await Promise.all([imageServer, apiServer].map(server => new Promise(resolve => server.close(resolve)))); });
  const saved = await saveImage(await raster('webp'), 'cafe');
  t.after(() => removeImage(saved.url));
  const pathname = new URL(saved.url).pathname;
  const base = `http://127.0.0.1:${imageServer.address().port}`;
  const res = await fetch(base + pathname);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/webp'); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format, 'webp');
  assert.equal((await fetch(`http://127.0.0.1:${apiServer.address().port}${pathname}`)).status, 404);
  for (const uri of ['/api/auth/me','/uploads/', '/uploads/.env','/uploads/cafe/a.png', '/uploads/cafe/%2e%2e%2f.env', '/uploads/user/01/x.webp', pathname + '/extra']) assert.equal((await fetch(base + uri)).status, 404, uri);
  assert.equal((await fetch(base + pathname, { method: 'POST' })).status, 404);
});
test('multipart boundaries preserve booleans and reject ambiguous fields and image URLs', async t => {
  const app = express(); app.use(express.json());
  app.post('/', uploadImage('image'), (req,res) => res.json({ body: req.body, image: Boolean(req.image) }));
  const server = app.listen(0,'127.0.0.1'); await new Promise(r => server.once('listening',r));
  t.after(() => new Promise(r => server.close(r)));
  const send = async body => { const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { method:'POST', body }); return { status:res.status, body:await res.json() }; };
  const form = new FormData(); form.set('isActive','false'); form.set('image',new Blob([await raster('png')],{type:'image/png'}),'../../evil.PNG');
  const good = await send(form); assert.equal(good.status,200); assert.equal(good.body.body.isActive,false); assert.equal(good.body.image,true);
  for (const entries of [[['isActive','False']],[['name','a'],['name','b']],[['name','\ufffd']],[['imageUrl','https://example.com/x']],[['imageUrl','null']]]) {
    const data = new FormData(); for (const [key,value] of entries)data.append(key,value);
    assert.equal((await send(data)).status,400);
  }
  const conflict = new FormData(); conflict.set('imageUrl',''); conflict.set('image',new Blob([await raster('png')],{type:'image/png'}),'x.png'); assert.equal((await send(conflict)).status,400);
});
