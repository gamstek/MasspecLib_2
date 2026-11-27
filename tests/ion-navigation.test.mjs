import {test} from 'node:test';import assert from 'node:assert/strict';import {ION_NAVIGATION_OPTIONS,ionModeFromRoute,ionModeQuery,ionNavigationTarget,ionFilterLabel} from '../src/shared/ionNavigation.mjs';
test('ion navigation preserves selected database scope and distinguishes negative zero from no filter',()=>{const query={db:['file:one','file:two'],ionMode:'1'};const negative=ionNavigationTarget(query,0);assert.equal(negative.path,'/-1');assert.deepEqual(negative.query.db,query.db);assert.equal(ionModeFromRoute(negative.query.ionMode),0);assert.equal(ionFilterLabel(0),'负离子');assert.equal(query.ionMode,'1');assert.deepEqual(ION_NAVIGATION_OPTIONS.map(x=>x.value),[1,0])});
test('navigation, advanced filter and clear share one route state without losing both or unspecified modes',()=>{for(const mode of [0,1,2,3])assert.equal(ionModeFromRoute(ionModeQuery(mode)),mode);for(const bad of [null,undefined,'','negative','1 OR 1=1',['1'],'4',0])assert.equal(ionModeFromRoute(bad),undefined);assert.equal(ionModeQuery(undefined),undefined);assert.equal(ionModeFromRoute(ionNavigationTarget({db:'file:one',ionMode:'0'},undefined).query.ionMode),undefined)});

test('nav badges reuse completed unfiltered ion results for their exact database scope',async()=>{
  const {ionCountLabel,ionCountFromList}=await import('../src/shared/ionNavigation.mjs')
  const negative=ION_NAVIGATION_OPTIONS[1]
  assert.equal(ionCountLabel(negative),negative.label)
  const filters={polarity:0,connectionIds:['file:two','file:one'],page:5,pageSize:50}
  const count=ionCountFromList(filters,{total:0,complete:true})
  assert.deepEqual(count,{scope:'["file:one","file:two"]',mode:0,total:0,complete:true})
  assert.equal(ionCountLabel(negative,count),negative.label+' (0)')
  assert.equal(ionCountFromList(filters,{total:7,complete:false}).complete,false)
  assert.equal(ionCountFromList({...filters,polarity:3},{total:7}),undefined)
  assert.equal(ionCountFromList(filters,{total:-1}),undefined)
  for(const filter of [{keyword:'test'},{sourceQuery:'source'},{sourceIds:['4']},{adduct:'H+'},{spectrumKind:'image'},
    {dataTypes:['spectrum']},{auditState:'pending'},{classId:42},{identityStatus:'unresolved'},{favoriteOnly:true},{trashOnly:true}]) {
    assert.equal(ionCountFromList({...filters,...filter},{total:7}),undefined)
  }
});
