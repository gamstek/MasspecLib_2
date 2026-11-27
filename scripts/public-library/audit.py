"""Build a separate curated snapshot. Raw acquisition database is never rewritten."""
from pathlib import Path
import sys,json,sqlite3,re,hashlib,collections,csv,argparse
from decimal import Decimal,InvalidOperation
P=argparse.ArgumentParser();P.add_argument('--input',required=True);P.add_argument('--output',required=True);args=P.parse_args()
BASE=Path(args.input).resolve();OUT=Path(args.output).resolve();OUT.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(BASE));import normalize as n
DB=OUT/'curated.sqlite'
if DB.exists():raise SystemExit('Use a new output directory; do not overwrite audited snapshots')
src=sqlite3.connect('file:'+str(BASE/'normalized/公开谱库_01_35.sqlite')+'?mode=ro',uri=True);c=sqlite3.connect(DB);src.backup(c);src.close();c.row_factory=sqlite3.Row
c.executescript('''CREATE TABLE quality(record_key TEXT PRIMARY KEY REFERENCES spectra(record_key),usable INTEGER NOT NULL,group_key TEXT NOT NULL,issues_json TEXT NOT NULL,changes_json TEXT NOT NULL);CREATE INDEX quality_group_idx ON quality(group_key,usable);''')
fields=collections.Counter();errors=collections.Counter();changes=collections.Counter();summary=collections.Counter()
NUL={'','na','n/a','null','none','unknown','not provided','not available','-','--','未提供'}
def text(v):return v.strip() if isinstance(v,str) and v.strip().lower() not in NUL else None
def dec(v):
 try:
  x=Decimal(str(v));return x if x.is_finite() else None
 except (InvalidOperation,ValueError):return None
def cas_valid(v):
 if not v or not re.fullmatch(r'\d{2,7}-\d{2}-\d',v):return False
 s=v.replace('-','');return sum(int(x)*i for i,x in enumerate(reversed(s[:-1]),1))%10==int(s[-1])
def usable_peaks(peaks):
 if not peaks:return ['empty_peaks']
 issues=[]
 for i,p in enumerate(peaks):
  if not isinstance(p,list) or len(p)!=2 or dec(p[0]) is None or dec(p[1]) is None or dec(p[0])<=0 or dec(p[1])<0:
   issues.append('invalid_peak:'+str(i));break
 if not any(dec(p[1]) is not None and dec(p[1])>0 for p in peaks if isinstance(p,list) and len(p)==2):issues.append('all_zero_intensities')
 return issues

def enrich(v,raw):
 v=dict(v);notes=[];diff=[];pairs=[]
 def add(k,x,depth=0):
  if depth>4:return
  pairs.append((str(k),x))
  if isinstance(x,dict):
   for a,b in x.items():add(a,b,depth+1)
  elif isinstance(x,list) and len(x)<100:
   for a in x:
    if isinstance(a,dict) and 'name' in a and 'value' in a:add(a['name'],a['value'],depth+1)
 for k,x in raw:
  add(k,x)
  if k in ['AC$ANALYTICAL_CONDITION','AC$MASS_SPECTROMETRY','AC$CHROMATOGRAPHY'] and isinstance(x,str):
   parts=x.split(' ',1)
   if len(parts)==2:add(parts[0],parts[1])
 def values(*keys):return [x for k,x in pairs if n.key(k) in {n.key(z) for z in keys} and text(x)]
 for field,aliases in {'ion_source':['IONIZATION','IONSOURCE'],'adduct':['ION_TYPE','PRECURSOR_TYPE'],'instrument':['MODEL','INSTRUMENT'],'collision_energy':['COLLISION_ENERGY']}.items():
  vals=values(*aliases)
  if v.get(field) is None and vals and not (field=='collision_energy' and v.get('energy_semantics')):v[field]=vals[0];diff.append('mapped:'+field)
 if v.get('polarity') is None:
  modes=values('MODE','ION_MODE','IONMODE')
  if modes and modes[0].lower() in ['positive','negative']:v['polarity']=1 if modes[0].lower()=='positive' else 0;diff.append('mapped:polarity')
 if v.get('ms_level') is None:
  titles=values('RECORD_TITLE')
  match=re.search(r'(?:^|;)\s*MS([1-9])\s*(?:;|$)',titles[0]) if titles else None
  if match:v['ms_level']=int(match[1]);diff.append('mapped:ms_level_from_explicit_title')
 mapping={'column':['COLUMN','COLUMN_NAME'],'gradient':['FLOW_GRADIENT','LC_GRADIENT','GRADIENT'],'flow_rate':['FLOW_RATE','FLOWRATE'],'column_temperature':['COLUMN_TEMPERATURE','COLUMN_TEMP'],'phase_a':['PHASE_A','SOLVENT_A','MOBILE_PHASE_A'],'phase_b':['PHASE_B','SOLVENT_B','MOBILE_PHASE_B'],'source_license':['LICENSE','LICENCE'],'name_zh':['NAME_ZH','CHINESE_NAME','中文名','中文名称']}
 for field,aliases in mapping.items():
  vals=values(*aliases)
  if not text(v.get(field)) and vals:v[field]=vals[0];diff.append('mapped:'+field)
 solvents=values('SOLVENT');v['mobile_phase']=solvents or v.get('mobile_phase')
 for s in solvents:
  m=re.match(r'^([AB])\s+(.+)',s,re.I)
  if m and not v.get('phase_'+m[1].lower()):v['phase_'+m[1].lower()]=m[2];diff.append('mapped:phase_'+m[1].lower())
 v['column_info']=n.column_info(v,{})
 if not any(x is not None for x in v['column_info'].values()):v['column_info']=None
 if v['column_info'] and v['column_info'].get('particle_size_um'):diff.append('column_particle_unit_normalized')
 params={k:x for k,x in pairs if re.search(r'^(?:IONIZATION_VOLTAGE|SPRAY_VOLTAGE|CAPILLARY_VOLTAGE|SOURCE_TEMPERATURE|DESOLVATION_TEMPERATURE|SHEATH_GAS|AUX_GAS|CURTAIN_GAS|IONSPRAY_VOLTAGE)$',k,re.I)}
 if params:v['ion_source_parameters']=params;diff.append('mapped:ion_source_parameters')
 rt=v.get('retention_time');rv=dec(rt)
 if rt is not None:
  if rv is not None and rv<0:v['retention_time']=None;notes.append('negative_rt_placeholder')
  elif rv is not None and rv==0:v['retention_time']=None;notes.append('zero_rt_not_usable_without_context')
  elif rv is not None:
   unit=str(v.get('retention_time_unit') or '').lower()
   if unit in ['s','sec','seconds','second']:v['retention_time']=str(rv/60);v['retention_time_unit']='min';diff.append('rt_seconds_to_min')
   elif unit in ['h','hour','hours']:v['retention_time']=str(rv*60);v['retention_time_unit']='min';diff.append('rt_hours_to_min')
   elif unit in ['min','minute','minutes']:v['retention_time_unit']='min'
   else:notes.append('rt_unit_unconfirmed')
 if v.get('ms_level')==1:
  if v.get('precursor_mz') is not None:notes.append('ms1_precursor_context_only')
  v['precursor_mz']=None
  if v.get('collision_energy') is not None:v['source_reported_energy']=v['collision_energy'];v['collision_energy']=None;notes.append('ms1_energy_not_collision_energy')
 if text(v.get('cas')) and not cas_valid(v['cas']):notes.append('invalid_cas_preserved_raw');v['cas']=None
 if v.get('precursor_mz') is not None and (dec(v['precursor_mz']) is None or dec(v['precursor_mz'])<=0):v['precursor_mz']=None;notes.append('invalid_precursor_preserved_raw')
 if v.get('polarity') not in [None,0,1]:v['polarity']=None;notes.append('invalid_polarity')
 v['mrm_srm_transitions']=([{'mode':v['mrm_or_srm'],'q1':v['q1'],'q3':v['q3'],'collision_energy':v.get('collision_energy')}] if v.get('mrm_or_srm') in ['MRM','SRM'] and dec(v.get('q1')) is not None and dec(v.get('q3')) is not None else [])
 return v,notes,diff

with (OUT/'quality_issues.csv').open('w',encoding='utf-8-sig',newline='') as f:
 w=csv.writer(f);w.writerow(['record_key','file','usable','issues'])
 last=''
 while True:
  batch=c.execute('SELECT s.*,f.name AS filename FROM spectra s JOIN source_files f ON f.file_key=s.file_key WHERE s.record_key>? ORDER BY s.record_key LIMIT 500',(last,)).fetchall()
  if not batch:break
  for r in batch:
   last=r['record_key'];summary['input_records']+=1;v=json.loads(r['values_json']);raw=json.loads(r['raw_fields_json']);peaks=json.loads(r['peaks_json'])
   # Legacy ReSpect uses an all-zero absolute column with valid relative intensities.
   # Recover only when every m/z and every absolute token matches the staged array.
   intensity_recovered=False
   if peaks and all(dec(p[1])==0 for p in peaks):
    sourcepath=Path(c.execute('SELECT path FROM source_files WHERE file_key=?',(r['file_key'],)).fetchone()[0])
    if sourcepath.suffix.lower()=='.txt' and sourcepath.exists():
     content=sourcepath.read_text(encoding='utf-8-sig');tail=content.split('PK$PEAK:',1)
     triples=re.findall(r'^\s*('+n.NUM+r')\s+('+n.NUM+r')\s+('+n.NUM+r')\s*$',tail[1],re.M) if len(tail)==2 else []
     if len(triples)==len(peaks) and all(dec(t[0])==dec(p[0]) and dec(t[1])==dec(p[1]) for t,p in zip(triples,peaks)) and any(dec(t[2])>0 for t in triples):
      peaks=[[t[0],t[2]] for t in triples];v['intensity_basis']='source_relative';v['intensity_mapping']='Absolute source intensities all zero; use explicit third rel.int. column; original text and staging DB retained';intensity_recovered=True
      c.execute('UPDATE spectra SET peaks_json=? WHERE record_key=?',(n.jd(peaks),r['record_key']))
   severe=usable_peaks(peaks)
   declared=[x for k,x in raw if n.key(k) in ['numpeaks','peakcounter','npoints','pknumpeak']]
   if declared and str(declared[0])!=str(len(peaks)):severe.append('declared_peak_count_mismatch')
   v,notes,diff=enrich(v,raw)
   if intensity_recovered:diff.append('recovered_explicit_relative_intensities')
   issues=severe+notes;valid=not severe
   ik=v.get('inchikey');g='IK:'+ik if isinstance(ik,str) and re.fullmatch('[A-Z]{14}-[A-Z]{10}-[A-Z]',ik) else 'RECORD:'+r['record_key']
   c.execute('INSERT INTO quality VALUES(?,?,?,?,?)',(r['record_key'],int(valid),g,n.jd(issues),n.jd(diff)))
   c.execute('UPDATE spectra SET values_json=?,compound_key=compound_key WHERE record_key=?',(n.jd(v),r['record_key']))
   summary['usable_records' if valid else 'quarantined_records']+=1
   if valid:
    summary['usable_peaks']+=len(peaks)
    for k,x in v.items():
     if x is not None and x!=[] and x!={} and x!='':fields[k]+=1
   errors.update(issues);changes.update(diff)
   if issues:w.writerow([r['record_key'],r['filename'],int(valid),';'.join(issues)])
  c.commit();print(json.dumps(dict(summary)),flush=True)
# Preserve exact-InChIKey metadata links; importable identity conflicts are reported, not silently overwritten.
conflicts=[]
for g,total in c.execute('SELECT group_key,COUNT(*) FROM quality WHERE usable=1 GROUP BY group_key'):
 rows=c.execute('SELECT s.values_json FROM spectra s JOIN quality q ON q.record_key=s.record_key WHERE q.group_key=? AND q.usable=1',(g,)).fetchall()
 vals=[json.loads(x[0]) for x in rows]
 for field in ['formula','cas']:
  allvals=sorted({str(v[field]) for v in vals if v.get(field)})
  if len(allvals)>1:conflicts.append({'group_key':g,'field':field,'values':allvals,'action':'do_not_choose_canonical_value'})
summary['usable_identity_groups']=c.execute('SELECT COUNT(DISTINCT group_key) FROM quality WHERE usable=1').fetchone()[0]
summary['identity_field_conflicts']=len(conflicts);summary['metadata_records']=c.execute('SELECT COUNT(*) FROM metadata_records').fetchone()[0]
report={'schema':'public-staging-audit-v1','source':str(BASE/'normalized/公开谱库_01_35.sqlite'),'curated':str(DB),'counts':dict(summary),'issues':dict(errors),'mapping_changes':dict(changes),'field_coverage_usable':dict(fields),'scope':'usable means numeric peak validation only, not certified chemical identification; no translations, MRM or units invented'}
(OUT/'quality-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));(OUT/'identity-conflicts.json').write_text(json.dumps(conflicts,ensure_ascii=False,indent=2))
assert c.execute('PRAGMA quick_check').fetchone()[0]=='ok'
assert not c.execute('PRAGMA foreign_key_check').fetchall()
c.execute('PRAGMA wal_checkpoint(TRUNCATE)');c.close();print(json.dumps(report,ensure_ascii=False),flush=True)
