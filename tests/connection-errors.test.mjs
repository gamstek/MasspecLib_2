import test from 'node:test'
import assert from 'node:assert/strict'
import {connectionError} from '../src/shared/connectionErrors.mjs'
test('Connection diagnostics identify the failed stage without exposing connection secrets',()=>{
 assert.match(connectionError({code:'ECONNREFUSED'},'connect',true),/SSH已连接.*数据库服务未响应/)
 assert.match(connectionError({errno:1045},'connect',true),/数据库账号验证失败/)
 assert.match(connectionError({code:'ETIMEDOUT'}),/连接超时/)
 assert.match(connectionError(new Error('SELECT secret password'),'catalog'),/数据库目录/)
 assert.match(connectionError({},'local'),/本地数据库目录同步失败/)
 assert(!connectionError(new Error('private-password'),'catalog').includes('private-password'))
})
