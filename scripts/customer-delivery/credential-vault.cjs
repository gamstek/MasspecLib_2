const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
class CredentialVault {
  constructor(file){this.file=path.resolve(file)}
  key(){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});if(!fs.existsSync(this.file)){try{fs.writeFileSync(this.file,crypto.randomBytes(32),{mode:0o600,flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}}if(fs.lstatSync(this.file).isSymbolicLink())throw Error('凭据密钥文件无效');const key=fs.readFileSync(this.file);if(key.length!==32)throw Error('凭据密钥文件损坏');return key}
  seal(password,context){const key=this.key(),iv=crypto.randomBytes(12);try{const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));const data=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]).toString('base64');return{version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data}}finally{key.fill(0)}}
  open(secret,context){if(!secret||secret.version!==1)throw Object.assign(Error('此凭据未加密留存，请重新设置'),{status:409});const key=this.key();try{const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(secret.iv,'base64'));decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(secret.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(secret.data,'base64')),decipher.final()]).toString('utf8')}catch{throw Object.assign(Error('无法解密凭据，请检查密钥或重新设置'),{status:409})}finally{key.fill(0)}}
}
module.exports={CredentialVault}
