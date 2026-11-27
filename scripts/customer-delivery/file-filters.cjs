const {ionModePredicate}=require('../../src/shared/ionMode.mjs')
const {fail}=require('./policy.cjs')
// Fixed JSON paths and bound values only. Each condition applies to the same
// record; zero/negative polarity must not be treated as an absent filter.
function nativeFileFilters(input){
 const clauses=[],params=[],exists=(array,condition)=>`EXISTS(SELECT 1 FROM json_each(payload,'$.${array}') a WHERE ${condition})`
 if(input.auditState)fail('文件库尚未建立自动检查索引，请清空检查状态或单独选择已检查的数据库')
 if(input.sourceIds?.length)fail('文件库来源请按文字查询，不支持其他数据库的来源编号')
 if(input.polarity!==undefined&&input.polarity!==null&&input.polarity!==''){
  const has=p=>'('+exists('ms',"json_extract(a.value,'$.polarity')="+p)+' OR '+exists('spectra',"json_extract(a.value,'$.polarity')="+p)+')';clauses.push(ionModePredicate(input.polarity,has(1),has(0)))
 }
 if(input.adduct){const v=String(input.adduct).trim().toLowerCase();if(v.length>200)fail('加合离子查询过长');clauses.push('('+exists('ms',"instr(lower(coalesce(json_extract(a.value,'$.adduct'),'')),?)>0")+' OR '+exists('spectra',"instr(lower(coalesce(json_extract(a.value,'$.adduct'),'')),?)>0")+')');params.push(v,v)}
 if(input.spectrumKind){if(!['numeric','image'].includes(input.spectrumKind))fail('谱图形式无效');clauses.push(exists('spectra',"json_extract(a.value,'$.spectrum_type')=?"));params.push(input.spectrumKind)}
 if(input.sourceQuery){const v=String(input.sourceQuery).trim().toLowerCase();if(v.length>200)fail('来源查询过长');clauses.push(exists('sources',"instr(lower(coalesce(json_extract(a.value,'$.name'),'')),?)>0"));params.push(v)}
 const types={spectrum:"coalesce(json_array_length(payload,'$.spectra'),0)>0 OR coalesce(json_array_length(payload,'$.ms'),0)>0",numeric:exists('chromatograms',"coalesce(json_array_length(a.value,'$.points'),0)>0"),image:exists('chromatograms',"length(coalesce(json_extract(a.value,'$.image_base64'),''))>0"),measurement:exists('experiments',"json_extract(a.value,'$.measurement') IS NOT NULL"),response:exists('experiments',"json_extract(a.value,'$.ratio') IS NOT NULL")}
 if(input.dataTypes!==undefined&&(!Array.isArray(input.dataTypes)||input.dataTypes.some(t=>!types[t])))fail('数据类型筛选无效')
 for(const t of new Set(input.dataTypes||[]))clauses.push('('+types[t]+')')
 if(input.identityStatus){if(!['structure_consistent','identity_conflict','unresolved','source_parameters_unverified','reference_only_no_spectrum'].includes(input.identityStatus))fail('身份状态无效');clauses.push("json_extract(payload,'$.compound.properties.identity_status')=?");params.push(input.identityStatus)}
 return{clauses,params}
}
module.exports={nativeFileFilters}
