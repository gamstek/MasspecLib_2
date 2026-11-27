import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
export class LocalReviews {
  constructor(root, tenantId) { if(!tenantId)throw Error('缺少客户身份');this.file=path.join(root,'local-reviews',crypto.createHash('sha256').update(tenantId).digest('hex')+'.json') }
  read() { if(!fs.existsSync(this.file))return[];const rows=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(rows))throw Error('本机复核记录损坏');return rows }
  list(releaseId, recordId) { return this.read().filter(r=>r.releaseId===releaseId&&r.recordId===recordId) }
  add(releaseId,record,input,reviewer) {
    if(!record?.checks?.some(c=>c.id===input.checkId)||!['reviewed','retest','exclude'].includes(input.action)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw Error('请选择有效检查记录并填写复核依据')
    const rows=this.read(),row={id:crypto.randomUUID(),releaseId,recordId:record.id,checkId:input.checkId,action:input.action,reason:input.reason.trim(),reviewer,at:new Date().toISOString()};rows.push(row)
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.'+crypto.randomUUID()+'.tmp'
    try{fs.writeFileSync(temp,JSON.stringify(rows),{mode:0o600,flag:'wx'});fs.renameSync(temp,this.file)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
    return row
  }
}
