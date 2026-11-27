"""Add only verified downloads/user-provided MassBank files; reuse audited DIMSpec batches."""
from pathlib import Path
import sys,json,hashlib,shutil,fcntl
BASE=Path(sys.argv[1]).resolve();sys.path.insert(0,str(BASE))
import normalize as n
from collect import now,sha,save
from parse_six import metadata,sdf_metadata
lock=(BASE/'normalize.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
c=n.open_db()
plan=BASE/'implementation/priority_download_plan.json'
if plan.exists():
 for job in json.loads(plan.read_text()):
  rpath=BASE/'raw'/(job['name']+'.receipt.json')
  if not rpath.exists():continue
  r=json.loads(rpath.read_text());p=Path(r['file'])
  if r['status']!='downloaded':continue
  if sha(p)!=r['sha256']:raise ValueError('Source hash mismatch '+p.name)
  if job['format']=='msp':n.process(c,p,r,'msp')
  elif job['format']=='sdf':metadata(c,r,p.name,'structure_and_classification_without_spectrum',sdf_metadata(p))
  elif job['format']=='mona_zip':n.unpack_zip(p,r,c)
# Original 44 files supplied in this conversation; retain their exact bytes.
original=Path('/root/.codex/attachments/024da297-6e2c-4b7e-827b-e2ec7616e40c')
for src in sorted(original.glob('MSBNK-AAFC-*.txt')):
 p=BASE/'raw'/src.name
 if not p.exists():shutil.copy2(src,p)
 r={'name':p.name,'url':'user-provided:MassBank-AAFC/'+p.name,'resource_ids':[1],'requested_at':now(),'status':'downloaded','file':str(p),'bytes':p.stat().st_size,'sha256':sha(p),'original_attachment':str(src)}
 save(p.with_name(p.name+'.receipt.json'),r);n.process(c,p,r,'massbank_txt')
# The existing DIMSpec standard batches already separate identified scans from
# ambiguous associations. Require byte-for-byte original SQLite equality.
db=BASE/'raw/dimspec_nist_pfas.sqlite';source=BASE.parent/'public_acquisition_20261014/raw/dimspec_nist_pfas.sqlite'
if db.exists() and source.exists() and sha(db)==sha(source):
 receipt=json.loads(db.with_name(db.name+'.receipt.json').read_text())
 original_records=n.records
 def records(path,fmt):
  if fmt!='dimspec_standard':yield from original_records(path,fmt);return
  data=json.loads(path.read_text());compounds={x['key']:x for x in data['compounds']};raw={x['key']:x for x in data['source_records']}
  for ordinal,s in enumerate(data['spectra'],1):
   comp=compounds[s['compound']];cr=next((raw[x] for x in comp.get('source_records',[]) if x in raw),{});aliases=cr.get('raw',{}).get('aliases',{});conds=s.get('conditions',{});energy=s.get('collision_energy') or {}
   fields=[('NAME',comp['main_name']),('FORMULA',comp.get('formula')),('CAS',comp.get('cas')),('INCHIKEY',next(iter(aliases.get('InChIKey',[])),None)),('SOURCE_ID',s['key']),('MSLEVEL',s.get('spectrum_type','').replace('MS','')),('IONMODE','Positive' if s.get('polarity')==1 else 'Negative' if s.get('polarity')==0 else None),('ADDUCT',s.get('adduct')),('PRECURSOR_MZ',s.get('precursor_mz') if s.get('spectrum_type')!='MS1' else None),('NATURE',s.get('nature')),('ION_SOURCE',(conds.get('ion_source') or {}).get('value')),('COLLISION_ENERGY',energy.get('value')),('CE_UNIT',energy.get('unit') or energy.get('scale')),('SOURCE_STANDARD_CONDITIONS',conds),('SOURCE_STANDARD_EVIDENCE',s.get('evidence')),('ORIGINAL_RELATED_RECORDS',[raw[x] for x in s.get('source_records',[]) if x in raw]),('COMPOUND_CLASS','PFAS'),('LICENSE',data['sources'][0]['license'])]
   yield ordinal,fields,[[p['mz'],p['intensity']] for p in s['peaks']],{'standard_collection':str(path),'source_spectrum_key':s['key']},[],n.jd(s)
 n.records=records
 for p in sorted((BASE.parent/'dimspec_supplement_20261015/standard_batches').glob('spectra_*/collection.json')):
  n.process(c,p,receipt,'dimspec_standard','verified-standard-batch:'+p.parent.name)
c.close()
