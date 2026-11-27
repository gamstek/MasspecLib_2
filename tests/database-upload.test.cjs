const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { randomUUID } = require('node:crypto')
const { createService } = require('../scripts/customer-delivery/server.cjs')
const { FileLibraries } = require('../scripts/customer-delivery/file-libraries.cjs')
const { fixture } = require('./fixtures/lds-fixture.cjs')

test('SQLite upload writes a complete validated file and only registers it after explicit publication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'masspec-upload-test-'))
  const fileLibraryRoot = path.join(directory, 'catalog')
  const databaseUploadRoot = path.join(directory, 'uploads')
  const store = {
    data:{}, mutate:async fn=>fn(), event(){},
    authenticate(token) { return { id:token, role:token==='customer'?'customer':'admin' } }
  }
  const service = createService({ directory, fileLibraryRoot, databaseUploadRoot, store, requirePublication:true })
  const server = http.createServer(service.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const prefix = '/admin/file-sources/upload/'
  const request = async (method, route, body, token='one') => {
    const raw = Buffer.isBuffer(body)
    const response = await fetch(base + route, {
      method, headers:{ Authorization:'Bearer '+token, 'Content-Type':raw?'application/octet-stream':'application/json' },
      body:raw?body:body===undefined?undefined:JSON.stringify(body)
    })
    return { status:response.status, data:await response.json() }
  }
  const files = new FileLibraries(fileLibraryRoot)
  try {
    const obsolete = await request('POST','/admin/publication/'+randomUUID(),{
      method:'POST',route:'/admin/file-sources/convert',body:{libraryId:'existing'}
    })
    assert.equal(obsolete.status,409)
    assert.match(obsolete.data.error,/上传数据库/)
    const original = fs.readFileSync(fixture(directory))
    const spec = { filename:'项目谱库.sqlite', bytes:original.length }
    assert.equal((await request('POST', prefix+'start', spec, 'customer')).status,403)
    assert.equal((await request('POST', prefix+'start', {...spec,filename:'../逃逸.sqlite'})).status,400)
    assert.equal((await request('POST', prefix+'start',{...spec,bytes:2**31+1})).status,413)
    const begin = await request('POST', prefix+'start', spec)
    assert.equal(begin.status,201)
    const url=prefix+begin.data.id
    assert.equal((await request('PUT',url+'?offset=0',original.subarray(0,128),'two')).status,404)
    assert.equal((await request('POST',url)).status,409)
    assert.equal((await request('PUT',url+'?offset=0',Buffer.alloc(128))).status,400)
    assert.equal((await request('PUT',url+'?offset=0',original.subarray(0,512))).data.received,512)
    assert.equal((await request('PUT',url+'?offset=0',original.subarray(0,512))).status,409)
    const rest = await request('PUT',url+'?offset=512',original.subarray(512))
    assert.equal(rest.data.received,original.length)
    const finish=await request('POST',url)
    assert.equal(finish.data.status,'ready')
    const publishedFile = finish.data.directory
    assert.equal(path.dirname(path.dirname(publishedFile)), databaseUploadRoot)
    assert.deepEqual(fs.readFileSync(publishedFile),original)
    const scan=await request('POST','/admin/file-sources/scan',{directory:databaseUploadRoot})
    assert.deepEqual(scan.data.map(report=>report.directory),[publishedFile])
    assert.equal(files.list().length,0)
    const register='/admin/file-sources/register', body={directory:publishedFile}
    assert.equal((await request('POST',register,body)).status,409)
    const publish=await request('POST','/admin/publication/'+randomUUID(),{method:'POST',route:register,body})
    assert.equal(publish.status,201,JSON.stringify(publish))
    assert.equal(files.list()[0].origin,publishedFile)

    const invalid=Buffer.alloc(1000)
    Buffer.from('SQLite format 3\0').copy(invalid)
    const bad=await request('POST',prefix+'start',{...spec,bytes:invalid.length})
    const badUrl=prefix+bad.data.id
    assert.equal((await request('PUT',badUrl+'?offset=0',invalid)).status,200)
    assert.equal((await request('POST',badUrl)).data.status,'error')
    assert.equal(fs.existsSync(path.join(databaseUploadRoot,bad.data.id)),false)

    const cancelled=await request('POST',prefix+'start',spec)
    assert.equal((await request('DELETE',prefix+cancelled.data.id)).status,200)
    assert.equal(fs.existsSync(path.join(databaseUploadRoot,cancelled.data.id)),false)
  } finally {
    service.closeUpdates()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory,{recursive:true,force:true})
  }
})
