import { createHash } from 'node:crypto'
import { columnParticleSize } from '../../src/shared/scientificDisplay.ts'
export const MAPPING_VERSION = 'unified-20261015-to-ml2-4-v1'
export const TAXONOMY_NAMESPACE = 'unified-consolidated-v2'
export function json(value, fallback = null) { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback }
export function scalar(value) { return value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value) }
export function number(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value) }
function short(value, label, warnings, max = 255) {
 const text = scalar(value)
 if (text == null) return null
 if (text.length > max) { warnings.push({ field: label, reason: `超过${max}字符；完整原值保存在raw`, length: text.length }); return text.slice(0, max) }
 return text
}
export function catalogFromRows(rows) {
 const codes = new Map(rows.map(x => [String(x.category_id), x.category_code]))
 return rows.map(x => ({ namespace: TAXONOMY_NAMESPACE, category_code: x.category_code, category_name: x.category_name,
  axis: x.axis, parent_code: x.parent_id == null ? null : codes.get(String(x.parent_id)), description: x.description, status: x.status }))
}
export function energy(value, documentedUnit) {
 const raw = scalar(value), match = raw?.match(/^\s*([-+]?\d+(?:\.\d+)?)\s*(?:\(\s*([^()]+)\s*\)|\s+(eV|NCE|V|normalized))?\s*$/i)
 const unit = documentedUnit || match?.[2] || match?.[3] || null
 return { raw, value: match ? match[1] : null, unit, energy_type: /^(NCE|normalized)$/i.test(unit ?? '') ? 'normalized' : null }
}
export function polarity(value) { return /^(positive|pos|\+)$/i.test(value ?? '') ? 1 : /^(negative|neg|-)$/i.test(value ?? '') ? 0 : null }
export function decimal(value, maxScale = 10) {
 if (value == null || value === '') return null
 const text=String(value)
 if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) || (text.split('.')[1]?.length ?? 0)>maxScale || text.replace(/^[+-]/,'').split('.')[0].length>10) return null
 return text
}
export function liquid(values, recordId) {
 if (!['column','retention_time','mobile_phase','gradient'].some(k => values[k] != null)) return null
 const column=scalar(values.column), method={ localId:'lc:'+recordId, chromatographic_column_mode: column?.slice(0,255),
  retention_time: number(values.retention_time), retention_time_unit: values.retention_time_unit || null,
  program_text:scalar(values.gradient), conditions:{ record_ids:[recordId], original_values:Object.fromEntries(['column','retention_time','retention_time_unit','mobile_phase','gradient'].filter(k=>values[k]!=null).map(k=>[k,values[k]])) }, items:[] }
 // Unknown source units remain explicitly unspecified rather than taking the UI's manual-entry min default.
 const dims=column?.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*mm\b/i)
 if(dims){method.column_type=dims[1].trim(); method.column_length_mm=dims[2];method.column_inner_diameter_mm=dims[3]}
 method.column_particle_size_um=columnParticleSize({chromatographic_column_mode:column})
 const mobile=Array.isArray(values.mobile_phase)?values.mobile_phase:[values.mobile_phase]
 for(const item of mobile){ const m=scalar(item)?.match(/^(?:SOLVENT\s+)?([AB])\s+(.+)$/i);if(m)method['phase_'+m[1].toUpperCase()]=m[2] }
 // Parse only explicit A:B at t min notation. Arbitrary source programs remain verbatim.
 for(const m of (scalar(values.gradient)??'').matchAll(/(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\s+at\s+(\d+(?:\.\d+)?)\s*min\b/gi))
  method.items.push({time:m[3],time_unit:'min',percentage_A:m[1],percentage_B:m[2],step_order:method.items.length})
 if(method.items.length>1)method.elution_mode='gradient'
 return method
}
export function sourceFor(record, values, file, publicRecord, publicSources) {
 if(publicRecord){ const src=publicSources.get(String(publicRecord.import_source_id));if(src)return {namespace:src.namespace,name:src.source_name,source_type:'public',location:src.location,version:short(src.version,'source.version',[]),license:src.license} }
 const accession=String(values.source_record_id??record.source_record_id??'')
 const massbank=accession.match(/^MSBNK-([^-]+)-/)
 if(massbank)return { namespace:'massbank:'+massbank[1],name:'MassBank / '+massbank[1],source_type:'public',location:file?.path??null,version:file?.sha256??null,license:values.source_license??null }
 return { namespace:'source-file:'+String(file?.sha256??record.file_id).slice(0,64),name:(file?.path??'来源文件 '+record.file_id).split(/[\\/]/).pop(),source_type:'unknown',location:file?file.archive+'!/'+file.path:null,version:file?.sha256??null,license:values.source_license??null }
}
export function convertCompound(compound, records, identifiers, evidence, categories, files, publicRecords, publicSources, fieldEvidence = []) {
 const warnings=[], spectra=[],methods=[],lcMethods=[],provenance=[],lcIndex=new Map()
 const unique=(values)=>[...new Set(values.filter(x=>x!=null&&x!==''))]
 const names=unique(identifiers.filter(x=>x.identifier_type==='name').map(x=>x.identifier_value))
 const sourceFormulas=unique(identifiers.filter(x=>/^(formula|molecular_formula)$/.test(x.identifier_type)).map(x=>x.identifier_value))
 const casValues=unique(identifiers.filter(x=>/^(cas|cas_number|casrn)$/i.test(x.identifier_type)).map(x=>x.identifier_value))
 const zh=unique(records.map(x=>x.name_zh)),en=unique(records.map(x=>x.name_en))
 const categoryCodes=new Map(categories.map(x=>[String(x.category_id),x.category_code])), classified=new Map()
 for(const row of evidence){const code=categoryCodes.get(String(row.category_id));if(!code)throw new Error('分类证据引用未知节点 '+row.category_id);if(!classified.has(code))classified.set(code,[]);classified.get(code).push(row)}
 for(const record of records){
  if(record.peaks_json==null)throw new Error('缺少精度修正版峰数组 '+record.record_id)
  const peaks=json(record.peaks_json,[])
  if(peaks.length!==Number(record.exact_peak_count)||peaks.length!==Number(record.peak_count))throw new Error('谱峰数量不一致 '+record.record_id)
  if(record.peaks_sha256 && createHash('sha256').update(JSON.stringify(peaks)).digest('hex')!==record.peaks_sha256)throw new Error('谱峰原文哈希不一致 '+record.record_id)
  const payload=json(record.payload_json),values=payload.values??{},id=String(record.record_id), msLevel=number(values.ms_level??record.ms_level)
  if(record.cas)casValues.push(record.cas)
  if(record.formula)sourceFormulas.push(record.formula)
  const collision=energy(msLevel===1?null:values.collision_energy,msLevel===1?null:values.collision_energy_unit??values.collision_energy_unit_documented)
  const conditions={source_record_id:values.source_record_id??record.source_record_id,ms_level:msLevel,instrument_type:values.instrument_type??null,
   ion_source:values.ion_source??null,fragmentation_mode:values.fragmentation_method??null,source_parameters:values.source_parameters??null,
   precursor_original:values.precursor_mz??null, original_values:values,identity_status:record.identity_status,identity_flags:json(record.identity_flags_json,[])}
  // q3 is populated only when a fixed product ion is explicitly supplied, never from the base peak.
  const q3=number(values.q3_mz),q1=number(values.q1_mz??values.precursor_mz??record.precursor_mz)
  methods.push({localId:'ms:'+id,ms_mode:short(values.instrument??values.instrument_type,'instrument',warnings),scan_mode:msLevel?'MS'+msLevel:values.acquisition_mode??null,
   q1,q3,ce:collision.value,ce_unit:collision.unit,energy_type:collision.energy_type,dp:number(values.dp),cxp:number(values.cxp),
   polarity:polarity(values.polarity??record.polarity),ion_source:short(values.ion_source,'ion_source',warnings),adduct:short(values.adduct,'adduct',warnings),transition_role:'unspecified',conditions})
  const rawPrecursor=record.payload_json.match(/"precursor_mz"\s*:\s*(?:"([^"\\]*)"|([-+\d.eE]+))/)?.slice(1).find(Boolean)??scalar(values.precursor_mz??record.precursor_mz)
  const precursor=decimal(rawPrecursor)
  if(rawPrecursor!=null&&precursor==null)warnings.push({record_id:id,field:'precursor_mz',reason:'超出DECIMAL(20,10)或不是单一十进制数；原值保留在conditions及raw'})
  spectra.push({localId:'sp:'+id,kind:'numeric',peaks:peaks.map(p=>({mz:p[0],intensity:p[1]})),spectrum_type:msLevel?'MS'+msLevel:null,
   precursor_mz:precursor,polarity:polarity(values.polarity??record.polarity),adduct:short(values.adduct,'adduct',warnings),collision_energy:msLevel===1?null:collision,
   nature:values.spectrum_nature==='measured'?'measured':values.spectrum_nature==='predicted'?'predicted':'unknown',
   conditions,methodLocalIds:['ms:'+id],raw:{record_id:id,payload_json:record.payload_json,peaks_sha256:record.peaks_sha256,raw_sha256:record.raw_sha256}})
  let lc=liquid(values,id)
  if(lc){
   const { localId, conditions, ...settings }=lc
   const signature=JSON.stringify({...settings,original_values:conditions.original_values})
   const existing=lcIndex.get(signature)
   if(existing){existing.conditions.record_ids.push(record.record_id);lc=existing}
   else {lcMethods.push(lc);lcIndex.set(signature,lc)}
  }
  const file=files.get(String(record.file_id)), pub=publicRecords.get(id), library=sourceFor(record,values,file,pub,publicSources)
  const origin={source_key:short(values.source_record_id??record.source_record_id??'record:'+id,'source_key',warnings,191),library,
   raw:{record_id:id,file_id:record.file_id,file_sha256:file?.sha256??null,public_record_id:pub?.import_record_id??null,source_payload_sha256:record.payload_sha256,raw_reference:'source group raw.source_files/public_records and spectrum.raw.payload_json'}}
  for(const [appliesTo,entityId] of [['spectrum','sp:'+id],['ms_method','ms:'+id],...(lc?[['lc_method',lc.localId]]:[])]) provenance.push({appliesTo,entityId,source_record:origin})
 }
 const cas=unique(casValues), formulas=unique(sourceFormulas)
 const properties={identity_status:compound.identity_status,record_kind:'spectral_identity_group',identity_flags:json(compound.flags_json,[]),
  source_cas_values:cas,source_formula_values:formulas,derived_formula:compound.derived_formula,formula_origin:formulas.length===1?'source_reported':formulas.length?'conflicting_source_values':'missing_source_value',
  original_spectrum_count:compound.spectrum_count,conversion_warnings:warnings,field_evidence:fieldEvidence}
 return {source:{namespace:'database-record:unified-20261015',key:String(compound.identity_key),name:'统一谱库内部身份分组',sourceType:'unknown'},
  compound:{main_name:short(compound.main_name,'main_name',warnings),name_zh:zh.length===1?short(zh[0],'name_zh',warnings):null,name_en:en.length===1?short(en[0],'name_en',warnings):null,
   name:names.map(name=>({name,area:''})),cas:cas.length===1?short(cas[0],'cas',warnings):null,formula:formulas.length===1?short(formulas[0],'formula',warnings):null,
   identifiers:{source:identifiers,canonical_smiles:compound.canonical_smiles,derived_inchikey:compound.derived_inchikey},properties},
  classifications:[...classified].map(([category_code,evidence])=>({namespace:TAXONOMY_NAMESPACE,category_code,evidence})),
  methods,lcMethods,spectra,provenance,raw:{source_compound:compound,mapping_version:MAPPING_VERSION,source_files:[...new Set(records.map(x=>String(x.file_id)))].map(id=>files.get(id)),public_records:records.map(x=>publicRecords.get(String(x.record_id))).filter(Boolean)}}
}
