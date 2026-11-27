const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Store,passwordHash,verifyPassword}=require('./store.cjs'),{CredentialVault}=require('./credential-vault.cjs'),crypto=require('node:crypto'),{encryptOffline,decryptOffline}=require('../../src/shared/offlineAccess.mjs');
test('customer credentials accept exactly 8–20 characters, reject outside bounds and retain legacy password verification',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'customer-password-')),store=new Store(root),vault=new CredentialVault(path.join(root,'key'));
 try{for(const n of [7,21])await assert.rejects(()=>store.createAccessCredentials({username:'client',customerName:'test',mode:'offline',password:'x'.repeat(n),passwordConfirm:'x'.repeat(n)},'admin',vault),/8–20/);
 for(const n of [8,20]){const p='x'.repeat(n);const result=await store.createAccessCredentials({username:'client',customerName:'test',mode:'offline',password:p,passwordConfirm:p},'admin',vault);assert(result.access.offlineCredentialId);assert(await verifyPassword(p,await passwordHash(p)))}
 const old='legacy-password-longer-than-twenty';assert(await verifyPassword(old,await passwordHash(old)));
 const pair=crypto.generateKeyPairSync('ed25519'),data={format:'MasspecLib2-delivery',tenantId:'t',manifest:{id:'r'},records:[]};for(const p of ['12345678',old]){const payload=await encryptOffline(data,'client',p),envelope={payload,signature:crypto.sign(null,Buffer.from(JSON.stringify(payload)),pair.privateKey).toString('base64')};assert.equal((await decryptOffline(envelope,'client',p,pair.publicKey,'t')).manifest.id,'r')}
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
