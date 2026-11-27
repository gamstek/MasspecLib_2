"""Final semantic guard and field inventory before freezing the audit snapshot."""
import sqlite3,json,sys,collections
from pathlib import Path
b=Path(sys.argv[1]);c=sqlite3.connect(b/'curated.sqlite');coverage=collections.Counter();updated=0
for key,data in c.execute('SELECT record_key,values_json FROM spectra').fetchall():
 v=json.loads(data)
 if v.get('energy_semantics') and v.get('collision_energy') is not None:
  v['collision_energy']=None;v['collision_energy_unit']=None;c.execute('UPDATE spectra SET values_json=? WHERE record_key=?',(json.dumps(v,ensure_ascii=False,separators=(',',':')),key));updated+=1
for data, in c.execute('SELECT s.values_json FROM spectra s JOIN quality q ON q.record_key=s.record_key WHERE q.usable=1'):
 for k,v in json.loads(data).items():
  if v is not None and v!=[] and v!={} and v!='':coverage[k]+=1
c.commit();assert c.execute('PRAGMA quick_check').fetchone()[0]=='ok';c.close()
r=json.loads((b/'quality-report.json').read_text());r['field_coverage_usable']=dict(coverage);r['final_semantic_guard']={'gc_ei_energy_original_kept_separate':True,'records_adjusted':updated};(b/'quality-report.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
print(json.dumps({'semantic_guard_adjusted':updated,'field_coverage':dict(coverage)},ensure_ascii=False))
