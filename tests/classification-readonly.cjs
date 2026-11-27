// Explicit opt-in smoke check. Reads registered libraries, writes only its new report/control directory.
const fs=require('node:fs'),path=require('node:path'),mysql=require('mysql2/promise')
const {ClassificationService}=require('../scripts/customer-delivery/classification.cjs')
const {classificationPlan,classificationWhere,displayLibrary}=require('../src/shared/classification.mjs')
async function main(){
 const config=JSON.parse(fs.readFileSync('/workspace/mysql-masspeclib2/customer-delivery/config.json','utf8'))
 const credentials=JSON.parse(fs.readFileSync(config.databaseCredentials,'utf8'))
 const connect=async()=>{const c=await mysql.createConnection({socketPath:config.socketPath,user:credentials.user,password:credentials.password,multipleStatements:false,supportBigNumbers:true,bigNumberStrings:true});await c.query('SET SESSION TRANSACTION READ ONLY');return c}
 const output=path.resolve('outputs/classification-readonly-check');fs.mkdirSync(output,{recursive:true})
 const service=new ClassificationService(output,connect),state=await service.state('isolated-readonly-check')
 const c=await connect(),report={libraries:[],localCategories:state.catalog.length,mode:'read-only input SQL; independent temporary classification metadata',countBasis:'non-deleted/non-trash compound records within each registered library; not cross-library deduplicated'}
 try{
  for(const l of state.libraries){
   await c.query('USE `'+l.database_name+'`')
   const [[total]]=await c.query('SELECT COUNT(*) n FROM compounds c WHERE COALESCE(c.is_delete,0)=0 AND COALESCE(c.is_in_trash,0)=0')
   const f=classificationWhere(classificationPlan(state,l,state.catalog,'@pending'))
   const [[pending]]=await c.query('SELECT COUNT(*) n FROM compounds c WHERE COALESCE(c.is_delete,0)=0 AND COALESCE(c.is_in_trash,0)=0 AND ('+f.where+')',f.params)
   if(Number(pending.n)>Number(total.n))throw Error('invalid pending count')
   report.libraries.push({database:l.database_name,title:displayLibrary(l,state.libraries),role:state.roles[l.database_name]||'project',records:Number(total.n),pending:Number(pending.n),originalCategories:l.categories.length})
  }
 }finally{await c.end()}
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}
main().catch(e=>{console.error(e.code||e.message);process.exitCode=1})
