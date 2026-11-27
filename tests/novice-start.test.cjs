const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { supportedNode, validateDelivery, validateShared, profiles } = require('../scripts/novice-start.cjs')
const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})
const delivery = () => ({enabled:true,edition:'admin',endpoint:'https://example.invalid:8445',certificateFingerprint:'a'.repeat(64),publicKey})
const shared = () => ({enabled:true,mode:'ssh',host:'',port:3306,user:'fixture-user',password:'',catalog:'mspec_lib2_catalog',auditDatabase:'mspec_lib2_audit',sshDefaults:{host:'example.invalid',port:2222,username:'fixture',hostFingerprint:'b'.repeat(64)}})
test('launcher accepts supported LTS lines and rejects obsolete/incompatible runtimes', () => {
 for(const v of ['v22.13.0','v22.23.0','v24.18.0'])assert(supportedNode(v))
 for(const v of ['v18.20.0','v20.18.0','v22.12.0','v23.0.0'])assert(!supportedNode(v))
})
test('profiles require complete identities and accept fingerprints containing colons',()=>{
 assert.doesNotThrow(()=>validateDelivery(delivery()));assert.doesNotThrow(()=>validateShared(shared()))
 assert.throws(()=>validateDelivery({...delivery(),endpoint:'http://example.invalid'}));assert.throws(()=>validateDelivery({...delivery(),endpoint:'https://user:pass@example.invalid'}));assert.throws(()=>validateDelivery({...delivery(),publicKey:'invalid'}))
 assert.throws(()=>validateDelivery({...delivery(),edition:'customer'}));assert.throws(()=>validateShared({enabled:false}));assert.throws(()=>validateShared({...shared(),sshDefaults:{...shared().sshDefaults,hostFingerprint:''}}))
 assert.doesNotThrow(()=>validateDelivery({...delivery(),certificateFingerprint:Array(32).fill('AA').join(':')}))
})
test('missing private configuration fails before any installer or build can run',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'novice-profile-'))
 try{fs.mkdirSync(path.join(dir,'resources'));fs.writeFileSync(path.join(dir,'resources/shared-server.example.json'),'{"enabled":false}');assert.throws(()=>profiles(dir),/缺少公司连接配置/);assert(!fs.existsSync(path.join(dir,'node_modules')))}finally{fs.rmSync(dir,{recursive:true})}
})
test('shared SSH profiles accept the OpenSSH fingerprint emitted by the application', () => {
  const profile = shared()
  profile.sshDefaults.hostFingerprint = 'SHA256:' + crypto.createHash('sha256').update('test host key').digest('base64').replace(/=+$/, '')
  assert.doesNotThrow(() => validateShared(profile))
  assert.throws(() => validateShared({ ...profile, sshDefaults: { ...profile.sshDefaults, hostFingerprint: 'SHA256:invalid' } }))
})
test('selected private configuration is used without copying or changing credential files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'novice-profile-'))
 try{
  const folder=path.join(dir,'连接配置');fs.mkdirSync(folder);const admin=JSON.stringify(delivery()),db=JSON.stringify(shared())
  fs.writeFileSync(path.join(folder,'admin-profile.json'),'\ufeff'+admin);fs.writeFileSync(path.join(folder,'shared-server.json'),db)
  const selected=profiles(dir);assert.equal(selected.delivery,path.join(folder,'admin-profile.json'));assert.equal(selected.shared,path.join(folder,'shared-server.json'));assert(!fs.existsSync(path.join(dir,'resources')));assert.equal(fs.readFileSync(selected.shared,'utf8'),db)
 }finally{fs.rmSync(dir,{recursive:true})}
})
