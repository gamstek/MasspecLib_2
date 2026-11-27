function normalizePresentation(input,fields){
 if(input==null)return{mode:'standard',listFields:[],detailFields:[]}
 if(!input||typeof input!=='object'||Array.isArray(input)||!['standard','table'].includes(input.mode))throw Object.assign(Error('显示方式无效'),{status:400})
 const allowed=new Set(Object.entries(fields).flatMap(([group,keys])=>keys.map(key=>group+'.'+key)))
 const pick=(value,label)=>{if(value===undefined)return[];if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!allowed.has(id)))throw Object.assign(Error(label+'包含未授权字段'),{status:400});return [...new Set(value.length?['compound.main_name',...value]:value)]}
 if(input.preset!=null&&!['mrm16','custom'].includes(input.preset))throw Object.assign(Error('表格预设无效'),{status:400})
 return{mode:input.mode,preset:input.preset||'custom',listFields:pick(input.listFields,'列表字段'),detailFields:pick(input.detailFields,'详情字段'),columns:pick(input.columns,'列顺序')}
}
module.exports={normalizePresentation}
