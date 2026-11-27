import {test} from 'node:test'
import assert from 'node:assert/strict'
import {disconnectSharedResources} from '../src/shared/sharedShutdown.mjs'
test('shutdown stops reconnect first, closes the tunnel last, and tolerates server-closed connections',async()=>{
 const events=[],failure=()=>{throw Error('Connection lost: The server closed the connection.')}
 const warnings=await disconnectSharedResources({stopBackground:()=>events.push('stop'),clearSavedLogin:()=>events.push('clear-login'),waitForSync:()=>events.push('sync'),closeAudit:()=>{events.push('audit');failure()},closePools:()=>{events.push('pools');failure()},closeTunnel:()=>events.push('tunnel'),clearProfile:()=>events.push('clear-profile'),publishDisconnected:()=>events.push('disconnected')})
 assert.deepEqual(events,['stop','clear-login','sync','audit','pools','tunnel','clear-profile','disconnected']);assert.equal(warnings.length,2)
})
test('hung and rejecting background sync cannot prevent disconnect, but a saved-login removal failure is surfaced',async()=>{
 const events=[];const actions={stopBackground:()=>{},clearSavedLogin:()=>{},waitForSync:()=>new Promise(()=>{}),closeAudit:async()=>{},closePools:async()=>{},closeTunnel:()=>events.push('closed'),clearProfile:()=>{},publishDisconnected:()=>events.push('disconnected')}
 const warnings=await disconnectSharedResources(actions,20);assert.equal(warnings[0].error,'清理超时');assert.deepEqual(events,['closed','disconnected'])
 assert.equal((await disconnectSharedResources({...actions,waitForSync:()=>Promise.reject(Error('Connection lost'))},20)).length,1)
 await assert.rejects(()=>disconnectSharedResources({...actions,clearSavedLogin:()=>{throw Error('Cannot clear saved credentials')}}),/Cannot clear/)
})
