import fs from 'node:fs'
import path from 'node:path'
const [catalogFile,output]=process.argv.slice(2)
if(!catalogFile||!output)throw new Error('Usage: create-test-fixtures <catalog.json> <new output>')
fs.mkdirSync(output,{recursive:true})
if(fs.existsSync(path.join(output,'groups.ndjson')))throw new Error('Output exists')
const taxonomyCatalog=JSON.parse(fs.readFileSync(catalogFile,'utf8'))
const groups=[0,1].map(i=>({
 source:{namespace:'synthetic-test:'+i,key:'test-object:'+i,name:i?'界面测试-中药规范':'界面测试-中药药典',sourceType:'local',provider:'MasspecLib2 功能测试',location:'Synthetic fixtures only; not a pharmacopoeia extract',license:'仅用于软件功能验证'},
 compound:{main_name:'【虚构测试】验证对象'+(i?'乙':'甲'),name_zh:'【虚构测试】验证对象'+(i?'乙':'甲'),name_en:'SYNTHETIC TEST '+(i?'B':'A'),name:[],properties:{synthetic_test:true,warning:'虚构数值；不得作为真实化合物或检测方法使用'}},
 classifications:(i?['drugs']:['insecticides','herbicides','pfas']).map(category_code=>({namespace:taxonomyCatalog[0].namespace,category_code,evidence:[{synthetic_test:true}]})),
 methods:[{localId:'ms:test',scan_mode:i?'SRM':'MRM',q1:'200.123',q3:'100.056',ce:-15,ce_unit:'eV',energy_type:'fixed',dp:0,cxp:5,polarity:i?0:1,adduct:i?'[M-H]-':'[M+H]+',ion_source:'ESI',transition_role:i?'qualifier':'quantifier',conditions:{synthetic_test:true,source_parameters:{ionization_voltage:'3.5 kV'}}}],
 lcMethods:[{localId:'lc:test',column_type:'虚构测试柱',column_length_mm:'50',column_inner_diameter_mm:'2',column_particle_size_um:'1.8',column_temperature_c:'35',retention_time:'1.5',retention_time_unit:'min',phase_A:'测试水相',phase_B:'测试有机相',elution_mode:'gradient',program_text:'虚构梯度，仅用于界面验证',items:[{time:'0',percentage_A:'95',percentage_B:'5',flow_rate:'0.3',time_unit:'min',flow_rate_unit:'mL/min'},{time:'5',percentage_A:'5',percentage_B:'95',flow_rate:'0.3',time_unit:'min',flow_rate_unit:'mL/min'}],conditions:{synthetic_test:true}}],
 spectra:[{localId:'sp:test',kind:'numeric',spectrum_type:'MS2',precursor_mz:'200.123',peaks:[{mz:'100.056',intensity:'1000'},{mz:'150.075',intensity:'250'}],polarity:i?0:1,adduct:i?'[M-H]-':'[M+H]+',collision_energy:{value:'-15',unit:'eV'},nature:'synthetic-test',methodLocalIds:['ms:test'],conditions:{synthetic_test:true}}],
 raw:{synthetic_test:true,exclusion:'Keep this database disabled during real spectral searches'}
}))
fs.writeFileSync(path.join(output,'groups.ndjson'),groups.map(g=>JSON.stringify(g)).join('\n')+'\n')
fs.writeFileSync(path.join(output,'catalog.json'),JSON.stringify(taxonomyCatalog))
fs.writeFileSync(path.join(output,'staging-export-report.json'),JSON.stringify({mappingVersion:'public-synthetic-ui-tests-v1',targetSchemaVersion:4,mode:'synthetic-fixtures',convertedGroups:2,spectra:2,peaks:4,methods:2,lcMethods:2,classificationLinks:4,errors:[],warnings:[],scope:'Fictional functional fixtures; excluded from public source counts'}))
