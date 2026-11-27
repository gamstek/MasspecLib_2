export const personalHeaders=['类别','亚类','化合物名称','英文名','CAS号','分子式','离子源类型及极性','MRM1_母离子_mz','MRM1_子离子_mz','MRM2_母离子_mz','MRM2_子离子_mz','碰撞能1','碰撞能2','碰撞能单位','保留时间(min)','来源']
export const personalPolicy={presentation:{mode:'table'},fields:{personal:personalHeaders}}
const show=value=>value==null||value===''?'—':typeof value==='object'?JSON.stringify(value):String(value)
export function displayColumns(manifest,records=[]){
 const policy=manifest?.policy||{},all=Object.entries(policy.fields||{}).flatMap(([group,keys])=>keys.map(key=>({id:group+'.'+key,group,key,label:manifest?.fieldLabels?.[group]?.[key]||key})))
 const list=policy.presentation?.listFields||[]
 if(policy.presentation?.mode==='table'&&policy.presentation?.preset==='mrm16'){
  const allowed=new Set(all.map(c=>c.id)),columns=[],used=new Set()
  const add=(group,key,label,extra={})=>{const id=group+'.'+key;if(!allowed.has(id))return;used.add(id);columns.push({id:id+(extra.index!=null?':'+extra.index:extra.part!=null?':'+extra.part:''),group,key,label,...extra})}
  add('classification','source_labels','类别',{part:0});add('classification','source_labels','亚类',{part:1});for(const [key,label]of [['main_name','化合物名称'],['name_en','英文名'],['cas','CAS号'],['formula','分子式']])add('compound',key,label)
  if(allowed.has('ms.ion_source')){add('ms','ion_source','离子源类型及极性',{ion:true,includePolarity:allowed.has('ms.polarity')});if(allowed.has('ms.polarity'))used.add('ms.polarity')}
  const count=Math.max(2,manifest.layout?.maxMethods||0,...records.map(r=>r.ms?.length||0))
  for(let i=0;i<count;i++){add('ms','q1',`MRM${i+1}_母离子_mz`,{index:i});add('ms','q3',`MRM${i+1}_子离子_mz`,{index:i})}for(let i=0;i<count;i++)add('ms','ce',`碰撞能${i+1}`,{index:i});add('ms','ce_unit','碰撞能单位');add('lc','retention_time','保留时间(min)');add('source','name','来源')
  const priority=new Map((policy.presentation.columns||[]).map((id,i)=>[id,i]));return [...columns,...all.filter(c=>!used.has(c.id))].sort((a,b)=>(priority.get(a.group+'.'+a.key)??Infinity)-(priority.get(b.group+'.'+b.key)??Infinity))
 }
 const ordered=policy.presentation?.mode!=='table'&&list.length?list.map(id=>all.find(c=>c.id===id)).filter(Boolean):[...(policy.presentation?.columns||[]).map(id=>all.find(c=>c.id===id)).filter(Boolean),...all.filter(c=>!(policy.presentation?.columns||[]).includes(c.id))];return ordered
}
export function detailManifest(manifest){const ids=manifest?.policy?.presentation?.detailFields||[];if(!ids.length)return manifest;const fields=Object.fromEntries(Object.entries(manifest.policy.fields).map(([g,keys])=>[g,keys.filter(k=>ids.includes(g+'.'+k))]));return{...manifest,policy:{...manifest.policy,fields,features:{...manifest.policy.features,spectra:fields.ms?.length>0||fields.spectrum?.length>0,lc:fields.lc?.length>0,chromatograms:fields.chromatogram?.length>0,experiments:fields.experiment?.length>0}}}}
export function fieldValue(record,column){
 const {group,key}=column
 if(column.part!=null){const paths=(record.classification?.source_labels||[]).map(label=>label.split(' / '));return [...new Set(paths.map(path=>path[column.part]).filter(Boolean))].join('；')||'—'}
 if(group==='personal')return record.sanming?.[key]??''
 if(group==='classification'){if(key==='source_labels')return(record.classification?.source_labels||[]).join('；');if(key==='status')return(record.classification?.items||[]).map(i=>i.review_status||'待确认').join('；');const catalog=new Map((record.classification?.catalog||[]).map(c=>[JSON.stringify([c.namespace,c.category_code]),c]));return(record.classification?.items||[]).map(i=>{let c=catalog.get(i.key);const path=[];while(c){path.unshift(c.category_name);c=c.parent_code?catalog.get(JSON.stringify([c.namespace,c.parent_code])):null}return path.join(' → ')}).join('；')}
 if(group==='compound')return show(record.compound?.[key])
 const list=record[({spectrum:'spectra',source:'sources',chromatogram:'chromatograms',experiment:'experiments'})[group]||group]||[]
 if(column.index!=null)return show(list[column.index]?.[key])
 if(column.ion)return [...new Set(list.map(m=>[m.ion_source,column.includePolarity?(m.polarity===1?'正离子':m.polarity===0?'负离子':null):null].filter(Boolean).join(' / ')))].filter(Boolean).join('；')
 if(group==='lc'&&key==='retention_time_unit')return list.map((m,i)=>`${i+1}. min${m.retention_time_unit==='s'?'（原始单位：s）':''}`).join('\n')
 if(group==='lc'&&key==='retention_time')return list.map((m,i)=>`${i+1}. `+(m.retention_times?.length?m.retention_times.map(t=>t.unit==='s'?t.value/60:t.value).join('/'):m.retention_time_unit==='s'?show(m.retention_time==null?null:m.retention_time/60):show(m.retention_time))).join('\n')
 return list.map((value,i)=>`${i+1}. ${show(key==='ce_unit_source'?(value[key]==='default'?'默认':value[key]==='explicit'?'原文注明':value[key]):key==='polarity'?(value[key]===1?'正离子':value[key]===0?'负离子':value[key]):value[key])}`).join('\n')
}
export function imageValues(record,column){if(!column.key.endsWith('base64'))return[];const values=column.group==='compound'?[record.compound?.[column.key]]:(record[({spectrum:'spectra',chromatogram:'chromatograms',experiment:'experiments'})[column.group]||column.group]||[]).map(row=>row[column.key]);return values.filter(v=>typeof v==='string'&&v).map(v=>v.startsWith('data:image/')?v:'data:image/png;base64,'+v)}

export function personalDisplayPolicy(policy,records=[]){
 const headers=[...new Set([...personalHeaders,...records.flatMap(r=>Object.keys(r.sanming||{}))])]
 if(policy?.presentation?.mode!=='table')return {...personalPolicy,fields:{personal:headers}}
 const f=policy.fields||{},has=(g,k)=>(f[g]||[]).includes(k),mapping=[['classification','source_labels'],['classification','source_labels'],['compound','main_name'],['compound','name_en'],['compound','cas'],['compound','formula'],['ms','ion_source'],['ms','q1'],['ms','q3'],['ms','q1'],['ms','q3'],['ms','ce'],['ms','ce'],['ms','ce_unit'],['lc','retention_time'],['source','name']]
 return {presentation:{mode:'table'},fields:{personal:headers.filter((h,i)=>i>=16?(/母离子/.test(h)?has('ms','q1'):/子离子/.test(h)?has('ms','q3'):/^碰撞能[0-9]+$/.test(h)?has('ms','ce'):false):i===2||has(...mapping[i])||i===6&&has('ms','polarity')||i===14&&has('lc','retention_times'))}}
}
