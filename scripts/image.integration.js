import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
assert.equal(process.env.DATABASE_NAME, 'pos_auth_test');
assert.equal(process.env.AUTH_TEST_DATABASE_ACK, `${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 3306}/pos_auth_test`);
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/configs/prisma.js');
const { hashPassword } = await import('../src/utils/auth.utils.js');
const { imageConfig, removeImage } = await import('../src/utils/image.utils.js');
const exists = url => access(path.join(imageConfig.root, new URL(url).pathname.slice('/uploads/'.length)));

test('real multipart cafe/user lifecycle, rollback, authorization and replacement races', async () => {
  assert.equal(await prisma.cafeSetting.count(), 0, 'Requires isolated test schema without cafe settings');
  const ids = [], urls = [], password = 'Image fixture password!', prefix = 'image_' + randomBytes(5).toString('hex');
  const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const request = async (route,method,body,token) => {
    const form = body instanceof FormData;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(!form && body ? {'Content-Type':'application/json'}:{})},body:body===undefined?undefined:form?body:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};
  };
  const png = await sharp({create:{width:24,height:16,channels:3,background:'blue'}}).png().toBuffer();
  const form = (field,fields={}) => { const data=new FormData();for(const [key,val]of Object.entries(fields))data.set(key,String(val));data.set(field,new Blob([png],{type:'image/png'}),'../../image.PNG');return data; };
  let cafeOwned = false;
  try {
    const admin = await prisma.user.create({data:{name:'Image admin',username:prefix,passwordHash:await hashPassword(password),role:'ADMIN'}});ids.push(admin.id);
    const login=await request('/api/auth/login','POST',{username:prefix,password});const token=login.body.accessToken;
    const created=await request('/api/admin/users','POST',form('image',{name:'Cashier',username:prefix+'_cashier',password}),token);
    assert.equal(created.status,201);ids.push(created.body.user.id);const cashierId=created.body.user.id;
    const initial=created.body.user.imageUrl;urls.push(initial);assert.match(initial,new RegExp(`/uploads/user/${cashierId}/`));await exists(initial);
    const duplicate=await request('/api/admin/users','POST',form('image',{name:'Duplicate',username:prefix+'_cashier',password}),token);assert.equal(duplicate.status,409);
    const own=await request('/api/auth/profile','PUT',form('image'),token);assert.equal(own.status,200);urls.push(own.body.user.imageUrl);await exists(own.body.user.imageUrl);
    const replace=await request('/api/auth/profile','PUT',form('image'),token);assert.equal(replace.status,200);urls.push(replace.body.user.imageUrl);await assert.rejects(exists(own.body.user.imageUrl));
    assert.equal((await request('/api/auth/profile','PUT',{imageUrl:'https://example.com/a'},token)).status,400);
    assert.equal((await request('/api/auth/profile','PUT',{imageUrl:null},token)).status,200);await assert.rejects(exists(replace.body.user.imageUrl));
    const cafe=await request('/api/cafe','POST',form('logo',{name:'Fixture cafe',address:'Fixture street',taxEnabled:true,taxInclusive:false}),token);
    assert.equal(cafe.status,201);cafeOwned=true;urls.push(cafe.body.cafeSetting.logoUrl);assert.equal(cafe.body.cafeSetting.taxEnabled,true);assert.equal(cafe.body.cafeSetting.taxInclusive,false);
    const cafeEdit=await request('/api/cafe','PUT',form('logo'),token);assert.equal(cafeEdit.status,200);urls.push(cafeEdit.body.cafeSetting.logoUrl);await assert.rejects(exists(cafe.body.cafeSetting.logoUrl));
    const edit=await request(`/api/admin/cashiers/${cashierId}`,'PUT',form('image',{isActive:false}),token);assert.equal(edit.status,200);urls.push(edit.body.cashier.imageUrl);assert.equal(edit.body.cashier.isActive,false);await assert.rejects(exists(initial));
    // Failed database update must remove new file and retain old image.
    const folder = path.join(imageConfig.root, `user/${cashierId}`);
    const filesBefore = await readdir(folder);
    const original=prisma.$transaction;
    prisma.$transaction=(callback,options)=>original.call(prisma,async tx=>{const result=await callback(tx);throw new Error('Forced rollback');},options);
    try { assert.equal((await request(`/api/admin/cashiers/${cashierId}`,'PUT',form('image'),token)).status,500); }
    finally { prisma.$transaction=original; }
    assert.deepEqual(await readdir(folder), filesBefore);
    await exists(edit.body.cashier.imageUrl);assert.equal((await prisma.user.findUnique({where:{id:cashierId}})).imageUrl,edit.body.cashier.imageUrl);
    const results=await Promise.all([request(`/api/admin/cashiers/${cashierId}`,'PUT',form('image'),token),request(`/api/admin/cashiers/${cashierId}`,'PUT',form('image'),token)]);
    for(const result of results){assert.equal(result.status,200);urls.push(result.body.cashier.imageUrl);}
    const current=(await prisma.user.findUnique({where:{id:cashierId}})).imageUrl;await exists(current);
    for(const result of results)if(result.body.cashier.imageUrl!==current)await assert.rejects(exists(result.body.cashier.imageUrl));
    assert.equal((await request('/api/auth/profile','PUT',form('image'))).status,401);
    // Pause before transaction to prove middleware-time authority cannot publish after revocation.
    let entered,release;const held=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
    prisma.$transaction=async(...args)=>{entered();await gate;return original.apply(prisma,args);};
    const pending=request('/api/auth/profile','PUT',form('image'),token);await held;
    await prisma.authSession.updateMany({where:{userId:admin.id},data:{revokedAt:new Date()}});release();
    try{assert.equal((await pending).status,401);}finally{prisma.$transaction=original;}
    const signed=await request('/api/auth/login','POST',{username:prefix,password});
    assert.equal((await request('/api/cafe','DELETE',undefined,signed.body.accessToken)).status,200);cafeOwned=false;await assert.rejects(exists(cafeEdit.body.cafeSetting.logoUrl));
  } finally {
    if(cafeOwned)await prisma.cafeSetting.delete({where:{id:1}});
    await prisma.user.deleteMany({where:{id:{in:ids}}});for(const url of urls)await removeImage(url);
    await new Promise(r=>server.close(r));await prisma.$disconnect();
  }
});
