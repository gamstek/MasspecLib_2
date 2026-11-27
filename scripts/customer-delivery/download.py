#!/usr/bin/env python3
"""Portable public-data downloader. Python >=3.10, standard library only.
No arguments means help. Plan/list/probe never launch bulk collection.
"""
from pathlib import Path
from contextlib import contextmanager
import argparse,csv,datetime,email.utils,gzip,hashlib,json,os,re,shutil,sys,time,urllib.request,urllib.parse,urllib.error,uuid,zipfile
ROOT=Path(__file__).resolve().parent
UA='PublicLibraryHandoff/1.0'
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def atomic(path,value):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_name(path.name+'.tmp.'+uuid.uuid4().hex);tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(tmp,path)
def sha(path,algorithm='sha256'):
 h=hashlib.new(algorithm)
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def load(path=None):return json.loads(Path(path or ROOT/'catalog/downloads.json').read_text(encoding='utf-8'))
def source_selection(text):return {x.strip() for x in text.split(',') if x.strip()} if text else set()
def select(manifest,sources=None,job_ids=None,limit=0):
 ss=source_selection(sources);jj=source_selection(job_ids);known={x['id'] for x in manifest['sources']}
 if ss-known:raise ValueError('Unknown source IDs: '+','.join(sorted(ss-known)))
 jobs=[j for j in manifest['jobs'] if (not ss or ss.intersection(j['source_ids'])) and (not jj or j['id'] in jj)]
 if jj-{j['id'] for j in jobs}:raise ValueError('Unknown/filtered job IDs')
 return jobs[:limit] if limit else jobs

def target_for(out,job):
 out=Path(out).resolve();jid=str(job['id']);name=str(job['filename'])
 if not re.fullmatch(r'[A-Za-z0-9_-]+',jid) or Path(name).name!=name or any(c in name for c in ['\\','/','\x00']):raise ValueError('Unsafe output filename or job ID')
 directory=out/'files'/jid;target=(directory/name).resolve()
 if out not in target.parents:raise ValueError('Output escapes destination')
 return target
@contextmanager
def job_lock(path):
 path.parent.mkdir(parents=True,exist_ok=True)
 try:fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 except FileExistsError:raise RuntimeError('Job is locked. After confirming no downloader is active, remove only its .lock file: '+str(path))
 try:
  with os.fdopen(fd,'w') as f:json.dump({'pid':os.getpid(),'at':stamp()},f)
  yield
 finally:path.unlink(missing_ok=True)
def request(job,headers=None,method=None):
 url=job['url'];parts=urllib.parse.urlsplit(url)
 if parts.scheme not in ['http','https','ftp'] or parts.username or parts.password:raise ValueError('Only public HTTP(S)/FTP URLs without embedded credentials are accepted')
 method=method or job.get('method','GET');body=None
 if method=='POST':body=urllib.parse.urlencode(job.get('form',{})).encode()
 h={'User-Agent':UA,'Accept-Encoding':'identity',**(headers or {})}
 if body is not None:h['Content-Type']='application/x-www-form-urlencoded'
 return urllib.request.Request(url,data=body,headers=h,method=method)
def preserve(path):
 if path.exists():
  new=path.with_name(path.name+'.previous.'+uuid.uuid4().hex[:10]);path.rename(new)
  meta=path.with_name(path.name+'.json')
  if meta.exists():meta.rename(new.with_name(new.name+'.json'))
  return str(new)
def payload_bytes(directory):
 if not directory.exists():return 0
 total=0
 for p in directory.iterdir():
  if not p.is_file() or p.name.endswith(('.receipt.json','.part.json','.lock')) or re.search(r'\.part\.previous\.[a-f0-9]+\.json$',p.name) or '.tmp.' in p.name:continue
  total+=p.stat().st_size
 return total
def check_space(path,reserve_gb,remaining=0):
 if shutil.disk_usage(Path(path).parent).free < reserve_gb*1024**3+max(0,remaining):raise RuntimeError('Insufficient disk space after configured reserve')
def validate_json(path):
 # Stream top-level arrays instead of loading multi-GB GNPS snapshots into memory.
 decoder=json.JSONDecoder();buffer='';eof=False
 with Path(path).open(encoding='utf-8-sig') as f:
  while not buffer.strip():
   block=f.read(65536)
   if not block:raise ValueError('Empty JSON')
   buffer+=block
  buffer=buffer.lstrip()
  if not buffer.startswith('['):
   if Path(path).stat().st_size>64*1024**2:
    f.seek(0);rows=0
    while True:
     line=f.readline(64*1024**2+1)
     if not line:break
     if len(line)>64*1024**2:raise ValueError('NDJSON record exceeds 64 MiB')
     if line.strip():json.loads(line);rows+=1
    if not rows:raise ValueError('Empty NDJSON')
    return
   data=json.loads(buffer+f.read())
   if isinstance(data,dict) and any(k in data for k in ['Fault','error','Error']):raise ValueError('Provider returned JSON error instead of data')
   return
  buffer=buffer[1:];first=True;need_value=True
  while True:
   buffer=buffer.lstrip()
   if not buffer and not eof:
    block=f.read(65536);eof=not block;buffer+=block;continue
   if need_value:
    if buffer.startswith(']') and first:
     tail=buffer[1:]+f.read();assert not tail.strip(),'Trailing JSON data';return
    try:_,end=decoder.raw_decode(buffer)
    except json.JSONDecodeError:
     if eof:raise
     block=f.read(65536);eof=not block;buffer+=block
     if len(buffer)>64*1024**2:raise ValueError('One JSON value exceeds 64 MiB validation limit')
     continue
    # A numeric token may be split across a chunk boundary; wait for its delimiter.
    if end==len(buffer) and not eof:
     block=f.read(65536);eof=not block;buffer+=block;continue
    buffer=buffer[end:];need_value=False;first=False
   else:
    if buffer.startswith(','):buffer=buffer[1:];need_value=True
    elif buffer.startswith(']'):
     tail=buffer[1:]+f.read()
     if tail.strip():raise ValueError('Trailing JSON data')
     return
    else:raise ValueError('Expected comma or closing array bracket')
def validate(path,job,observed_total=None,container=True):
 size=Path(path).stat().st_size
 with Path(path).open('rb') as f:prefix=f.read(512).lstrip().lower()
 if job.get('artifact_kind','data')=='data' and prefix.startswith((b'<!doctype html',b'<html')):raise ValueError('HTML payload rejected despite misleading Content-Type')
 if not size:raise ValueError('Empty payload')
 for expected in [job.get('expected_size'),observed_total]:
  if expected is not None and size!=int(expected):raise ValueError(f'Size mismatch: {size} != {expected}; refresh changing publisher catalog explicitly')
 checksum=job.get('checksum')
 if checksum:
  algorithm,expected=checksum.split(':',1)
  if algorithm not in ['sha256','md5','sha1']:raise ValueError('Unsupported checksum algorithm')
  if sha(path,algorithm).lower()!=expected.lower():raise ValueError('Publisher checksum mismatch')
 evidence='size + local SHA256; no publisher checksum'
 if checksum:evidence='size + publisher '+checksum.split(':')[0]+' + local SHA256'
 if container:
  name=job['filename'].lower()
  if name.endswith('.zip'):
   with zipfile.ZipFile(path) as z:
    bad=z.testzip()
    if bad:raise ValueError('ZIP CRC failed: '+bad)
   evidence+=' + complete ZIP CRC'
  elif name.endswith('.gz'):
   with gzip.open(path,'rb') as f:
    for b in iter(lambda:f.read(1024*1024),b''):pass
   evidence+=' + complete gzip CRC'
  elif name.endswith('.json'):
   validate_json(path);evidence+=' + JSON structural validation'
 return {'bytes':size,'sha256':sha(path),'validation':evidence}
def fetch(job,out,reserve_gb=10,retries=3,timeout=90,opener=urllib.request.urlopen,max_bytes=None):
 target=target_for(out,job);target.parent.mkdir(parents=True,exist_ok=True);receipt=target.with_name(target.name+'.receipt.json');partial=target.with_name(target.name+'.part');statepath=partial.with_name(partial.name+'.json')
 with job_lock(target.with_name(target.name+'.lock')):
  if target.exists():
   if not receipt.exists():raise RuntimeError('Existing file has no verified receipt; preserve it and choose another output directory')
   old=json.loads(receipt.read_text(encoding='utf-8'))
   if old.get('job_id')!=job['id'] or old.get('url')!=job['url'] or old.get('status')!='downloaded':raise RuntimeError('Existing receipt does not match this job')
   checked=validate(target,job)
   if checked['sha256']!=old['sha256']:raise ValueError('Existing file changed after receipt')
   return {**old,'reused_at':stamp(),'reused':True}
  failures=0;segments=0
  while failures<retries:
   try:
    prior=json.loads(statepath.read_text(encoding='utf-8')) if statepath.exists() else {};offset=0
    if partial.exists() and job.get('method','GET')=='GET' and prior.get('job_id')==job['id'] and prior.get('url')==job['url'] and prior.get('etag') and not prior['etag'].startswith('W/'):offset=partial.stat().st_size
    elif partial.exists():preserve(partial)
    if offset and prior.get('expected_total')==offset:
     checked=validate(partial,job,offset);partial.rename(target);result=dict(job_id=job['id'],source_ids=job['source_ids'],url=job['url'],status='downloaded',at=stamp(),reused=True,recovered_complete_partial=True,**checked);atomic(receipt,result);return result
    headers={}
    if offset:headers={'Range':f'bytes={offset}-','If-Range':prior['etag']}
    check_space(target,reserve_gb,max(0,(job.get('expected_size') or 0)-offset))
    with opener(request(job,headers),timeout=timeout) as r:
     status=r.getcode() or 200;ctype=r.headers.get('Content-Type','').lower();encoding=r.headers.get('Content-Encoding','identity').lower()
     if job.get('artifact_kind','data')=='data' and ('text/html' in ctype or 'application/xhtml' in ctype):raise ValueError('HTML/login page rejected as data')
     if encoding not in ['identity','']:raise ValueError('HTTP content encoding prevents reliable byte-range validation')
     total=job.get('expected_size');range_end=None;mode='wb'
     if status==206:
      match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',r.headers.get('Content-Range',''))
      if not offset or not match or int(match[1])!=offset or r.headers.get('ETag')!=prior.get('etag'):raise ValueError('Untrusted resumed response; partial preserved')
      total=int(match[3]);range_end=int(match[2]);assert range_end>=offset and range_end<total
      if job.get('expected_size') is not None and total!=job['expected_size']:raise ValueError('Publisher size changed')
      mode='ab'
     elif status==200:
      if r.headers.get('Content-Range'):raise ValueError('Unexpected range header on status 200')
      if offset:preserve(partial)
      offset=0
      if r.headers.get('Content-Length'):
       advertised=int(r.headers['Content-Length'])
       if total is not None and advertised!=total:raise ValueError('Publisher size changed; discover a new snapshot')
       total=advertised
     else:raise ValueError('Unexpected HTTP status '+str(status))
     if max_bytes is not None and total is not None and total>max_bytes:raise RuntimeError('Run byte budget exceeded before transfer')
     atomic(statepath,dict(job_id=job['id'],url=job['url'],etag=r.headers.get('ETag'),expected_total=total,at=stamp()))
     received=offset;last=time.monotonic()
     with partial.open(mode) as f:
      while True:
       b=r.read(1024*1024)
       if not b:break
       f.write(b);received+=len(b)
       if max_bytes is not None and received>max_bytes:raise RuntimeError('Run byte budget exceeded; partial preserved')
       if total is not None and received>total:raise ValueError('Received beyond expected total')
       if time.monotonic()-last>10:
        f.flush();check_space(target,reserve_gb);atomic(receipt,dict(job_id=job['id'],url=job['url'],status='downloading',received_bytes=received,expected_total=total,at=stamp()));last=time.monotonic()
     if range_end is not None and received!=range_end+1:raise ValueError('Range response truncated')
     if total is not None and received<total and range_end is not None:
      segments+=1
      if segments>100000:raise ValueError('Too many range segments')
      continue
     checked=validate(partial,job,total)
     if target.exists():raise FileExistsError('Target appeared concurrently; no overwrite')
     partial.rename(target)
     result=dict(job_id=job['id'],source_ids=job['source_ids'],url=job['url'],final_url=r.geturl(),method=job.get('method','GET'),status='downloaded',at=stamp(),**checked)
     if job.get('observed_sha256'):result['matches_historical_observed_sha256']=checked['sha256']==job['observed_sha256']
     atomic(receipt,result);return result
   except Exception as e:
    failures+=1;atomic(receipt,dict(job_id=job['id'],url=job['url'],status='failed',attempt=failures,error=repr(e),partial_bytes=partial.stat().st_size if partial.exists() else 0,at=stamp()))
    if failures>=retries or 'budget exceeded' in str(e):raise
    delay=min(30,2**failures)
    if isinstance(e,urllib.error.HTTPError):
     hint=e.headers.get('Retry-After','')
     if hint.isdigit():delay=min(60,max(delay,int(hint)))
    time.sleep(delay)
def probe(job,timeout=20):
 try:
  method='HEAD' if job.get('method','GET')=='GET' else 'POST'
  with urllib.request.urlopen(request(job,method=method),timeout=timeout) as r:
   prefix=r.read(256) if method=='POST' else b''
   return dict(job_id=job['id'],status=r.status,final_url=r.geturl(),content_type=r.headers.get('Content-Type'),content_length=r.headers.get('Content-Length'),etag=r.headers.get('ETag'),probe_only=True,validation='access/header probe, not complete file verification')
 except urllib.error.HTTPError as e:
  if e.code==405 and job.get('method','GET')=='GET':
   with urllib.request.urlopen(request(job,{'Range':'bytes=0-0'}),timeout=timeout) as r:
    r.read(1);return dict(job_id=job['id'],status=r.status,range_probe=True,probe_only=True)
  return dict(job_id=job['id'],error=str(e),status=e.code,probe_only=True)
 except Exception as e:return dict(job_id=job['id'],error=repr(e),probe_only=True)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',default=str(ROOT/'catalog/downloads.json'));sub=p.add_subparsers(dest='command')
 sub.add_parser('list',help='List 75 source records and supported historical job counts')
 for command in ['plan','fetch','probe','verify']:
  s=sub.add_parser(command);s.add_argument('--sources',help='Comma-separated original IDs or REF_*');s.add_argument('--jobs');s.add_argument('--limit',type=int,default=0);s.add_argument('--out',default=str(ROOT/'downloads'))
  if command=='fetch':s.add_argument('--reserve-gb',type=float,default=10);s.add_argument('--retries',type=int,default=3);s.add_argument('--interval',type=float,default=1);s.add_argument('--max-total-gb',type=float,default=10)
 args=p.parse_args()
 if not args.command:p.print_help();return
 m=load(args.manifest)
 if args.command=='list':
  for s in m['sources']:print(s['id'],s['name'],s['automation_status'],s['download_job_count'],sep='\t')
  return
 jobs=select(m,args.sources,args.jobs,args.limit)
 if args.command=='plan':
  known=sum(j.get('expected_size') or 0 for j in jobs);print(json.dumps(dict(jobs=len(jobs),known_bytes=known,unknown_size_jobs=sum(j.get('expected_size') is None for j in jobs),warning='known_bytes is not the full total; sources may overlap and historical endpoints may be stale.',selected=jobs),ensure_ascii=False,indent=2));return
 results=[];used=0
 for j in jobs:
  before_bytes=payload_bytes(target_for(args.out,j).parent) if args.command=='fetch' else 0
  stop_for_budget=False
  try:
   if args.command=='fetch':
    if (j.get('expected_size') or j.get('observed_size') or 0)>args.max_total_gb*1e9-used:raise RuntimeError('Selected next file exceeds this run byte budget; increase --max-total-gb explicitly')
    if used>=args.max_total_gb*1e9:break
    r=fetch(j,args.out,args.reserve_gb,args.retries,max_bytes=max(0,int(args.max_total_gb*1e9-used)));time.sleep(max(1,args.interval))
   elif args.command=='probe':r=probe(j);time.sleep(1)
   else:
    target=target_for(args.out,j);r=dict(job_id=j['id'],**validate(target,j));receipt=target.with_name(target.name+'.receipt.json')
    if receipt.exists():assert r['sha256']==json.loads(receipt.read_text())['sha256'],'Receipt hash mismatch'
   results.append(r);print(json.dumps(r,ensure_ascii=False),flush=True)
  except Exception as e:results.append(dict(job_id=j['id'],status='error',error=repr(e)));print(json.dumps(results[-1],ensure_ascii=False),flush=True);stop_for_budget='budget' in str(e).lower()
  if args.command=='fetch':used+=max(0,payload_bytes(target_for(args.out,j).parent)-before_bytes)
  if stop_for_budget:break
 output=Path(args.out);output.mkdir(parents=True,exist_ok=True);atomic(output/('run_'+args.command+'_'+datetime.datetime.now().strftime('%Y%m%d_%H%M%S')+'.json'),dict(at=stamp(),command=args.command,selected=len(jobs),results=results,bytes_downloaded=used))
 if any(r.get('error') for r in results):raise SystemExit(1)
if __name__=='__main__':main()
