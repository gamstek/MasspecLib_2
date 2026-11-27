"""Convert audited SQLite into app-native CompoundGroup NDJSON; no DB connection."""
from pathlib import Path
import argparse,sqlite3,json,hashlib,re,collections,itertools
from decimal import Decimal,InvalidOperation
P=argparse.ArgumentParser();P.add_argument('--input',required=True);P.add_argument('--output',required=True);P.add_argument('--sample',type=int,default=0);a=P.parse_args()
DB=Path(a.input).resolve();OUT=Path(a.output).resolve();OUT.mkdir(parents=True,exist_ok=True)
if (OUT/'groups.ndjson').exists():raise SystemExit('Output exists; choose new directory')
c=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
NS='public-application-v1';catalog=[{'namespace':NS,'category_code':r['category_id'],'category_name':r['name_zh'],'parent_code':r['parent_id'],'axis':'unresolved' if r['category_id']=='pending' else 'application','status':'active'} for r in c.execute('SELECT * FROM categories')]
resources={r['resource_id']:dict(r) for r in c.execute('SELECT * FROM resources')};files={r['file_key']:dict(r) for r in c.execute('SELECT * FROM source_files')}
assignments=collections.defaultdict(list)
for r in c.execute('SELECT ce.*,q.group_key FROM classification_evidence ce JOIN quality q ON q.record_key=ce.record_key WHERE q.usable=1'):
 assignments[r['group_key']].append({'category_code':r['category_id'],'evidence_type':r['evidence_type'],'evidence':r['evidence'],'review_status':r['review_status'],'source_record_key':r['record_key']})
def jd(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'),allow_nan=False)
def sha(x):return hashlib.sha256(jd(x).encode()).hexdigest()
def num(x):
 try:
  v=Decimal(str(x));return str(v) if v.is_finite() else None
 except (InvalidOperation,ValueError):return None
def scalar(x):return str(x).strip() if isinstance(x,(str,int,float)) and str(x).strip() else None
def short(x):return scalar(x)[:255] if scalar(x) else None
def energy(v):
 raw=scalar(v.get('collision_energy'));unit=scalar(v.get('collision_energy_unit'))
 if raw is None:return None
 m=re.fullmatch(r'\s*([+-]?\d+(?:\.\d+)?)\s*(?:\(\s*([^()]+)\s*\)|\s*(eV|NCE|V|normalized))?\s*',raw,re.I)
 unit=unit or (m[2] or m[3] if m else None)
 return {'raw':raw,'value':m[1] if m else None,'unit':unit,'scale':unit,'energy_type':'normalized' if (unit or '').lower() in ['nce','normalized'] else None}
def origin(r,v):
 source=json.loads(r['source_json']);f=files[r['file_key']];ids=json.loads(f['resource_ids_json']);rid=next((i for i in ids if i not in [3,4]),ids[0] if ids else 0);res=resources.get(rid,{})
 acc=str(r['source_record_id'] or v.get('source_record_id') or '');m=re.match('MSBNK-([^-]+)-',acc)
 namespace='massbank:'+m[1] if m else ('nist.dimspec.pfas' if rid==28 else 'public-resource:'+str(rid))
 name='MassBank / '+m[1] if m else res.get('name',f['name']).split(' / ')[-1]
 if rid==2:name='MoNA'
 return {'namespace':namespace,'name':name,'sourceType':'public','provider':source.get('provider') or res.get('provider'),'location':res.get('entry_url') or f['download_url'],'version':None,'license':scalar(v.get('source_license'))},source

def liquid(v,key):
 if not any(v.get(x) is not None for x in ['column','retention_time','phase_a','phase_b','gradient','flow_rate','column_temperature']):return None
 rt=num(v.get('retention_time'));unit=v.get('retention_time_unit') or 'unspecified';ci=v.get('column_info') or {}
 result={'localId':'lc:'+key,'lc_mode':short(v.get('instrument_type')),'chromatographic_column_mode':short(v.get('column')),'column_type':short(ci.get('type')),'column_length_mm':num(ci.get('length_mm')),'column_inner_diameter_mm':num(ci.get('inner_diameter_mm')),'column_particle_size_um':num(ci.get('particle_size_um')),'column_temperature_c':num(v.get('column_temperature')),'retention_time':rt,'retention_time_unit':unit,'phase_A':v.get('phase_a'),'phase_B':v.get('phase_b'),'program_text':scalar(v.get('gradient')),'items':[],'conditions':{'original_values':{k:v[k] for k in ['column','retention_time','retention_time_unit','flow_rate','mobile_phase','column_temperature'] if v.get(k) is not None},'record_keys':[key]}}
 flow=re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*mL\s*(?:/\s*min|min(?:\^?-?1)?)\s*',scalar(v.get('flow_rate')) or '',re.I)
 for m in re.finditer(r'(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\s+at\s+(\d+(?:\.\d+)?)\s*min\b',scalar(v.get('gradient')) or '',re.I):
  if Decimal(m[1])+Decimal(m[2])!=100:continue
  result['items'].append({'time':m[3],'time_unit':'min','percentage_A':m[1],'percentage_B':m[2],'flow_rate':flow[1] if flow else None,'flow_rate_unit':'mL/min' if flow else None,'step_order':len(result['items'])})
 if len(result['items'])>1:result['elution_mode']='gradient'
 return result

def convert(g,rows):
 vals=[json.loads(r['values_json']) for r in rows];names=list(dict.fromkeys(scalar(v.get('compound_name')) for v in vals if scalar(v.get('compound_name'))));conflicts=[]
 def one(field):
  values=list(dict.fromkeys(scalar(v.get(field)) for v in vals if scalar(v.get(field))))
  if len(values)>1 and field in ['formula','cas']:conflicts.append({'field':field,'values':values});return None
  return short(values[0]) if values else None
 firstlib,_=origin(rows[0],vals[0]);compound={'main_name':one('name_zh') or one('name_en') or short(names[0] if names else g),'name_zh':one('name_zh'),'name_en':one('name_en'),'name':[{'name':n,'area':''} for n in names],'cas':one('cas'),'formula':one('formula'),'identifiers':{'inchikey':g[3:] if g.startswith('IK:') else None},'properties':{'identity_basis':'exact_full_inchikey' if g.startswith('IK:') else 'source_record_only','identity_group_key':g,'identity_conflicts':conflicts,'source_record_count':len(rows),'quality_snapshot':str(DB),'translations_generated':False}}
 # Supplement only unambiguous CAS/formula from exact full-InChIKey metadata; preserve evidence.
 metadata=[]
 if g.startswith('IK:'):
  for m in c.execute('SELECT metadata_key,compound_name,cas,formula,source_json FROM metadata_records WHERE inchikey=?',(g[3:],)):
   metadata.append(dict(m))
  for field in ['formula','cas']:
   values={m[field] for m in metadata if m[field]}
   if compound[field] is None and len(values)==1 and not any(x['field']==field for x in conflicts):
    value=next(iter(values))
    if field=='cas':
     s=value.replace('-','')
     if not re.fullmatch(r'\d{2,7}-\d{2}-\d',value) or sum(int(x)*i for i,x in enumerate(reversed(s[:-1]),1))%10!=int(s[-1]):continue
    compound[field]=short(value);compound['properties'].setdefault('metadata_enrichment',[]).append({'field':field,'value':value,'match':'exact_full_inchikey','metadata_keys':[m['metadata_key'] for m in metadata if m[field]==value]})
 group={'source':{**firstlib,'key':g},'compound':compound,'classifications':[],'methods':[],'lcMethods':[],'spectra':[],'provenance':[],'raw':{'identity_key':g,'metadata_references':metadata,'staging_snapshot':str(DB)}}
 cats=collections.defaultdict(list)
 for e in assignments.get(g,[]):cats[e['category_code']].append(e)
 if not cats:cats['pending']=[{'reason':'No source-supported application category; no forced assignment'}]
 group['classifications']=[{'namespace':NS,'category_code':k,'evidence':e} for k,e in cats.items()]
 seen={};duplicates=0;lc_seen={};origins=set()
 for r,v in zip(rows,vals):
  key=r['record_key'];lib,source=origin(r,v);peaks=json.loads(r['peaks_json']);en=energy(v);mslevel=v.get('ms_level');origin_record={'source_key':str(r['source_record_id'] or key)[:191],'library':lib,'raw':{'record_key':key,'file_sha256':source.get('file_sha256'),'file':files[r['file_key']]['name'],'locator':source.get('locator'),'download_url':source.get('download_url'),'snapshot':str(DB)}}
  conditions={'ms_level':mslevel,'instrument_type':v.get('instrument_type'),'ion_source':v.get('ion_source'),'source_parameters':v.get('ion_source_parameters'),'fragmentation_mode':v.get('fragmentation_method'),'source_record_id':r['source_record_id'],'intensity_basis':v.get('intensity_basis'),'source_reported_energy':v.get('source_reported_energy'),'energy_semantics':v.get('energy_semantics')}
  lc=liquid(v,key);lcid=None
  if lc:
   sig=sha({k:x for k,x in lc.items() if k not in ['localId','conditions']})
   if sig in lc_seen:lc=lc_seen[sig]
   else:group['lcMethods'].append(lc);lc_seen[sig]=lc
   lcid=lc['localId'];conditions['lc_method_local_id']=lcid
   group['provenance'].append({'appliesTo':'lc_method','entityId':lcid,'source_record':origin_record})
  fingerprint=sha({'peaks':peaks,'ms_level':mslevel,'precursor':v.get('precursor_mz'),'polarity':v.get('polarity'),'adduct':v.get('adduct'),'energy':en,'instrument':v.get('instrument'),'conditions':{k:x for k,x in conditions.items() if k not in ['source_record_id','lc_method_local_id']},'lc':{k:x for k,x in lc.items() if k not in ['localId','conditions']} if lc else None})
  if fingerprint in seen:spid,mid=seen[fingerprint];duplicates+=1
  else:
   spid='sp:'+key;mid='ms:'+key;seen[fingerprint]=(spid,mid)
   method={'localId':mid,'ms_mode':short(v.get('instrument') or v.get('instrument_type')),'scan_mode':v.get('mrm_or_srm') or ('MS'+str(mslevel) if mslevel else None),'q1':num(v.get('q1') or v.get('precursor_mz')),'q3':num(v.get('q3')) if v.get('mrm_or_srm') in ['MRM','SRM'] else None,'ce':num(en.get('value')) if en else None,'ce_unit':short(en.get('unit')) if en else None,'energy_type':en.get('energy_type') if en else None,'dp':num(v.get('dp')),'cxp':num(v.get('cxp')),'polarity':v.get('polarity'),'adduct':short(v.get('adduct')),'ion_source':short(v.get('ion_source')),'transition_role':'unspecified','conditions':conditions}
   group['methods'].append(method)
   rawfields=[x for x in json.loads(r['raw_fields_json']) if x[0] not in ['ORIGINAL_RELATED_RECORDS','SOURCE_STANDARD_EVIDENCE','MASS SPECTRAL PEAKS']]
   precursor=num(v.get('precursor_mz'))
   if precursor is not None:
    d=Decimal(precursor)
    if d.adjusted()>9 or max(0,-d.as_tuple().exponent)>10:precursor=None;conditions['precursor_original']=v.get('precursor_mz')
   group['spectra'].append({'localId':spid,'kind':'numeric','peaks':[{'mz':p[0],'intensity':p[1]} for p in peaks],'spectrum_type':'MS'+str(mslevel) if mslevel else ('GC-EI' if 'EI' in str(v.get('instrument_type')) or 33 in json.loads(files[r['file_key']]['resource_ids_json']) else None),'precursor_mz':precursor,'polarity':v.get('polarity'),'adduct':short(v.get('adduct')),'collision_energy':en,'nature':v.get('nature') if v.get('nature') in ['measured','predicted','synthetic-test'] else 'unknown','conditions':conditions,'methodLocalIds':[mid],'raw':{'record_key':key,'original_fields':rawfields,'raw_record_locator':source,'staging_snapshot':str(DB)}})
  group['provenance'].extend([{'appliesTo':'spectrum','entityId':spid,'source_record':origin_record},{'appliesTo':'ms_method','entityId':mid,'source_record':origin_record}])
  if lib['namespace'] not in origins:
   origins.add(lib['namespace']);group['provenance'].append({'appliesTo':'compound','source_record':origin_record})
 group['compound']['properties']['exact_acquisition_duplicates_consolidated']=duplicates
 return group
# Deterministic sample covers source files, modes, categories, and all supplied AAFC identities.
selected=set()
if a.sample:
 eligible={r[0]:r[1] for r in c.execute('SELECT group_key,COUNT(*) FROM quality WHERE usable=1 GROUP BY group_key HAVING COUNT(*)<=100')}
 for r in c.execute('SELECT q.group_key,s.file_key,s.polarity FROM quality q JOIN spectra s ON s.record_key=q.record_key WHERE q.usable=1 ORDER BY q.group_key'):
  if r['group_key'] not in eligible:continue
  f=files[r['file_key']]
  if f['name'].startswith('MSBNK-AAFC-'):selected.add(r['group_key'])
 seen_files=set()
 for r in c.execute('SELECT q.group_key,s.file_key,s.polarity FROM quality q JOIN spectra s ON s.record_key=q.record_key WHERE q.usable=1 ORDER BY q.group_key'):
  f=files[r['file_key']]
  family=f['resource_ids_json']+':'+('massbank_txt' if f['name'].endswith('.txt') else f['name'])
  flag=(family,r['polarity'])
  if r['group_key'] in eligible and flag not in seen_files:selected.add(r['group_key']);seen_files.add(flag)
 for g in sorted(eligible):
  if len(selected)>=a.sample:break
  selected.add(g)
report={'mappingVersion':'public-staging-schema4-v1','targetSchemaVersion':4,'mode':'sample' if a.sample else 'all','sourceDatabase':str(DB),'convertedGroups':0,'spectra':0,'peaks':0,'methods':0,'lcMethods':0,'classificationLinks':0,'deduplicatedRecords':0,'errors':[],'warnings':[]}
with (OUT/'groups.ndjson').open('w') as dest:
 groups=c.execute('SELECT DISTINCT group_key FROM quality WHERE usable=1 ORDER BY group_key')
 for row in groups:
  g=row[0]
  if a.sample and g not in selected:continue
  rows=c.execute('SELECT s.* FROM spectra s JOIN quality q ON q.record_key=s.record_key WHERE q.usable=1 AND q.group_key=? ORDER BY s.record_key',(g,)).fetchall()
  try:
   group=convert(g,rows);data=jd(group)
   if len(data.encode())>15*1024*1024:raise ValueError('Group exceeds bounded application package; requires explicit review')
   dest.write(data+'\n');report['convertedGroups']+=1;report['spectra']+=len(group['spectra']);report['peaks']+=sum(len(s['peaks']) for s in group['spectra']);report['methods']+=len(group['methods']);report['lcMethods']+=len(group['lcMethods']);report['classificationLinks']+=len(group['classifications']);report['deduplicatedRecords']+=group['compound']['properties']['exact_acquisition_duplicates_consolidated']
  except Exception as e:report['errors'].append({'group_key':g,'error':str(e)})
  if report['convertedGroups']%1000==0:print(jd({k:report[k] for k in ['convertedGroups','spectra','peaks']}),flush=True)
(OUT/'catalog.json').write_text(jd(catalog));(OUT/'staging-export-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(jd(report),flush=True)
if report['errors']:raise SystemExit(1)
