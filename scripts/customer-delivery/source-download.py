"""Download complete selected source scopes; immutable output and checksummed receipts."""
import hashlib
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import importlib.util
import os
import base64
import time
import traceback
import io
import zipfile
import contextlib
import urllib.error
import urllib.parse
from source_network import failure_kind, is_transient, read_json
import source_release

folder = Path(sys.argv[1])
config = json.loads((folder / 'request.json').read_text(encoding='utf-8'))
from download import fetch, target_for, atomic, stamp

def progress(label, completed=0, total=0, unit='文件', **extra):
    phase = 'parse' if stage == 'parse' else 'download'
    atomic(folder/'progress.json',dict(phase=phase,label=label,completed=completed,total=total,unit=unit,at=stamp(),**extra))

class ProgressResponse:
    def __init__(self, response, job):
        self.response = response
        self.job = job
        self.received = 0
        self.last = 0
        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
        self.offset = int(match[1]) if match else 0

    def __getattr__(self, name):
        return getattr(self.response, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.response.close()

    def read(self, n=-1):
        data = self.response.read(n)
        self.received += len(data)
        if time.monotonic() - self.last >= 1 or not data:
            completed, total = self.offset + self.received, self.job.get('expected_size') or (
                (int(self.response.headers['Content-Length']) + self.offset if self.response.headers.get('Content-Length') else 0))
            progress('正在下载谱库附件', completed, total, '字节',
                     bytes=completed, totalBytes=total, filename=self.job['filename'])
            self.last = time.monotonic()
        return data


# A stale lock is removed only when its recorded positive PID is confirmed absent.
def clear_stale_locks(root):
    for lock in root.rglob('*.lock'):
        try:
            data=json.loads(lock.read_text())
            if not isinstance(data,dict): continue
            pid=data.get('pid')
            if not isinstance(pid,int) or pid<=0: continue
            os.kill(pid,0)
        except ProcessLookupError:
            try: lock.unlink()
            except OSError: pass
        except (ValueError,OSError,json.JSONDecodeError): pass

stage = 'metadata'

def record_failure(exc_type, error, stack):
    try:
        atomic(folder/'failure.json', {'phase':stage, 'kind':failure_kind(error)})
    finally:
        traceback.print_exception(exc_type, error, stack)

sys.excepthook = record_failure
clear_stale_locks(folder.parent)
progress('正在获取来源版本及文件清单')

def json_rows(file):
    decoder = json.JSONDecoder()
    with file.open(encoding='utf-8-sig') as stream:
        buffer = ''
        started = False
        ended = False
        eof = False
        while not eof:
            chunk = stream.read(65536)
            eof = not chunk
            buffer += chunk
            while True:
                buffer = buffer.lstrip()
                if not started:
                    if not buffer: break
                    if buffer[0] != '[': raise ValueError('GNPS export must be a JSON array')
                    started = True
                    buffer = buffer[1:].lstrip()
                if ended:
                    if buffer.strip(): raise ValueError('Unexpected data after GNPS array')
                    break
                if buffer.startswith(','): buffer = buffer[1:].lstrip()
                if buffer.startswith(']'):
                    ended = True
                    buffer = buffer[1:]
                    continue
                if not buffer: break
                try: row, end = decoder.raw_decode(buffer)
                except json.JSONDecodeError:
                    if eof: raise
                    if len(buffer) > 16000000: raise ValueError('Single spectrum exceeds 16 MB')
                    break
                if not isinstance(row, dict): raise ValueError('Invalid GNPS spectrum')
                yield row
                buffer = buffer[end:]
        if not ended: raise ValueError('Incomplete GNPS export')

def emit_spectra(output, stream, extension):
    count = 0
    records = source_release.msnlib_json_blocks(stream) if extension == 'ndjson' else source_release.blocks(stream, extension)
    for block in records:
        output.write(json.dumps({'text': block}, ensure_ascii=False) + '\n')
        count += 1
        if count % 1000 == 0:
            progress('正在读取谱图记录', count, unit='张谱图')
    return count

def download_verified_file(output):
    global stage
    manifest = json.loads(Path(__file__).with_name('source-files.json').read_text(encoding='utf-8'))
    entry = manifest[config['sourceId']]
    url = entry['url']
    parsed = urllib.parse.urlsplit(url)
    extension = entry['format']
    filename = entry.get('filename') or 'source-' + config['sourceId'] + '.' + ('zip' if entry.get('member') else extension)
    job = {'id': hashlib.sha256(url.encode()).hexdigest(), 'source_ids': [config['sourceId']],
           'filename': filename, 'url': url, 'expected_size': entry.get('size'), 'checksum': entry.get('checksum')}
    expected_checksum = job['checksum']
    previous = config.get('previousValidators') or {}
    prior_checksum = config.get('previousChecksum')
    if expected_checksum and expected_checksum == prior_checksum:
        return {'upstreamChecksum': expected_checksum, 'version': expected_checksum}
    headers = {}
    if prior_checksum and previous.get('url') == url:
        if previous.get('etag'):
            headers['If-None-Match'] = previous['etag']
        elif previous.get('modified'):
            headers['If-Modified-Since'] = previous['modified']
    observed = {'url': url}

    def opener(request, timeout):
        if not request.has_header('Range'):
            for key, value in headers.items():
                request.add_header(key, value)
        response = urllib.request.urlopen(request, timeout=timeout)
        observed.update(etag=response.headers.get('ETag'), modified=response.headers.get('Last-Modified'))
        return ProgressResponse(response, job)

    stage = 'download'
    target = target_for(folder, job)
    validator_file = folder/'http.json'
    progress('正在下载实际谱库文件', unit='字节', filename=filename)
    try:
        receipt = fetch(job, folder, reserve_gb=3, retries=2, timeout=90,
                        max_bytes=source_release.LIMIT, opener=opener)
    except urllib.error.HTTPError as error:
        if error.code == 304 and headers and not target.exists():
            return {'upstreamChecksum': prior_checksum, 'version': config.get('previousVersion') or prior_checksum}
        raise
    if observed.get('etag') or observed.get('modified'):
        atomic(validator_file, observed)
    elif validator_file.exists():
        observed = json.loads(validator_file.read_text())
    checksum = expected_checksum or 'sha256:' + receipt['sha256']
    version = 'sha256:' + receipt['sha256']
    if checksum == prior_checksum:
        return {'upstreamChecksum': checksum, 'version': version}
    stage = 'parse'
    with contextlib.ExitStack() as stack:
        if entry.get('member'):
            archive = stack.enter_context(zipfile.ZipFile(target))
            info = archive.getinfo(entry['member'])
            if info.file_size > source_release.LIMIT:
                raise ValueError('Archive spectrum member exceeds maximum size')
            stream = stack.enter_context(io.TextIOWrapper(archive.open(info), encoding='utf-8-sig'))
        else:
            stream = stack.enter_context(target.open(encoding='utf-8-sig'))
        count = emit_spectra(output, stream, extension)
    return {'version': version, 'upstreamChecksum': checksum, 'upstreamValidators': observed,
            'downloadCount': count, 'commit': receipt['sha256'], 'validation': receipt['validation'],
            'url': url, 'format': extension, 'gnps': parsed.hostname == 'library.gnps2.org',
            'assumeMs2': bool(re.match(r'^(?:Bio)?MSMS-', filename, re.I))}

scope = config['scope']
with (folder / 'records.jsonl').open('w', encoding='utf-8') as output:
    if config['adapter'] == 'massbank':
        spec = importlib.util.spec_from_file_location('massbank', Path(__file__).with_name('massbank-download.py'))
        mb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mb)
        def metadata(route):
            request = urllib.request.Request(mb.API+route,headers={'User-Agent':'MasspecLib2','Accept':'application/vnd.github+json'})
            def retry(attempt):
                if stage == 'metadata':
                    progress(f'来源响应中断，正在重试文件清单（{attempt}/4）')
            return read_json(request, 32_000_000, on_retry=retry)
        mb.metadata = metadata
        version = mb.metadata('/releases/latest')['tag_name']
        if not re.fullmatch(r'\d{4}\.\d{2}(?:\.\d+)?', version): raise ValueError('Unknown MassBank version')
        release = mb.metadata('/commits/' + version)
        commit = mb.object_id(release['sha'])
        contributor = next((x for x in mb.tree(release['commit']['tree']['sha']) if x['type'] == 'tree' and x['path'] == scope), None)
        if not contributor: raise ValueError('MassBank contributor not found: ' + scope)
        checksum = 'git-tree:' + mb.object_id(contributor['sha'])
        if config.get('previousChecksum') == checksum:
            atomic(folder/'unchanged.json', {'upstreamChecksum': checksum, 'version': version})
            sys.exit(0)
        entries = sorted((x for x in mb.tree(contributor['sha']) if x['type'] == 'blob' and re.fullmatch(r'MSBNK-' + re.escape(scope) + r'-[A-Z0-9_]+\.txt', x['path'])), key=lambda x:x['path'])
        if not entries: raise ValueError('No MassBank spectra in selected contributor')
        stage = 'download'
        cache = folder.parent.parent / 'cache'
        def get(entry):
            name, size, blob = entry['path'], entry['size'], mb.object_id(entry['sha'])
            if not 0 < size <= 1000000: raise ValueError('MassBank record exceeds 1 MB')
            job = {'id':blob,'source_ids':['1'],'url':mb.RAW+'/'+commit+'/'+scope+'/'+name,'filename':name,'expected_size':size}
            target = target_for(cache,job)
            if not target.is_file():
                try:
                    fetch(job, folder, reserve_gb=1,retries=2,timeout=20,max_bytes=1000000)
                    downloaded = target_for(folder,job)
                    raw = downloaded.read_bytes()
                except Exception as error:
                    if not isinstance(error, OSError) and not is_transient(error):
                        raise
                    payload=mb.metadata('/git/blobs/'+blob)
                    if payload.get('encoding')!='base64': raise ValueError('Invalid MassBank blob encoding')
                    raw=base64.b64decode(payload['content'])
                if len(raw)!=size or hashlib.sha1(f'blob {size}\0'.encode()+raw).hexdigest()!=blob: raise ValueError('MassBank Git blob checksum mismatch')
                target.parent.mkdir(parents=True,exist_ok=True)
                temporary = target.with_suffix('.tmp')
                temporary.write_bytes(raw)
                os.replace(temporary,target)
                atomic(target.with_name(target.name+'.receipt.json'),{'job_id':blob,'source_ids':['1'],'url':job['url'],'status':'downloaded','at':stamp(),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'validation':'Git blob ID and SHA256'})
            raw = target.read_bytes()
            if len(raw) != size or hashlib.sha1(f'blob {size}\0'.encode()+raw).hexdigest() != blob: raise ValueError('MassBank checksum mismatch: '+name)
            return {'accession':name[:-4],'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode('utf-8')}
        total_bytes=sum(e['size'] for e in entries);completed_bytes=0
        progress('正在下载并校验谱图文件',0,len(entries),bytes=0,totalBytes=total_bytes)
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs={pool.submit(get,e):e for e in entries}
            for done,future in enumerate(as_completed(jobs),1):
                record=future.result();output.write(json.dumps(record)+'\n')
                completed_bytes+=jobs[future]['size']
                progress('正在下载并校验谱图文件',done,len(entries),bytes=completed_bytes,totalBytes=total_bytes,filename=jobs[future]['path'])
        metadata = {'version':version,'commit':commit,'upstreamChecksum':checksum,'downloadCount':len(entries),'validation':'Git blob SHA1 and SHA256'}
    elif config['adapter'] == 'gnps':
        stage = 'download'
        if scope not in ['LEAFBOT','MIADB','AASDB']: raise ValueError('Unsupported GNPS scope')
        job = {'id':scope,'source_ids':['3'],'url':'https://external.gnps2.org/gnpslibrary/'+scope+'.json','filename':scope+'.json'}
        class ResponseProgress:
            def __init__(self,response):
                self.response=response;self.received=0;self.last=0
                cr=response.headers.get('Content-Range','')
                m=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',cr)
                self.offset=int(m[1]) if m else 0
                self.total=int(m[3]) if m else int(response.headers.get('Content-Length') or 0)
            def __getattr__(self,name): return getattr(self.response,name)
            def __enter__(self): return self
            def __exit__(self,*args): self.response.close()
            def read(self,n=-1):
                data=self.response.read(n);self.received+=len(data)
                if time.monotonic()-self.last>=1 or not data:
                    progress('正在下载 GNPS 文件',self.offset+self.received,self.total,'字节',filename=job['filename'])
                    self.last=time.monotonic()
                return data
        def opener(request,timeout): return ResponseProgress(urllib.request.urlopen(request,timeout=timeout))
        fetch(job,folder,reserve_gb=1,retries=2,timeout=90,max_bytes=536870912,opener=opener)
        progress('下载完成，正在校验文件 SHA-256')
        target = target_for(folder,job)
        digest = hashlib.sha256()
        with target.open('rb') as raw:
            for chunk in iter(lambda:raw.read(1048576),b''): digest.update(chunk)
        checksum = digest.hexdigest()
        count = 0
        for row in json_rows(target): output.write(json.dumps(row)+'\n'); count += 1
        metadata = {'version':'sha256:'+checksum,'commit':checksum,'downloadCount':count,'validation':'Complete JSON and SHA256','url':job['url']}
    elif config['adapter'] in ('msdial', 'msnlib'):
        published = source_release.resolve(config['adapter'], scope)
        checksum = published['checksum']
        if config.get('previousChecksum') == checksum:
            atomic(folder/'unchanged.json', {'upstreamChecksum': checksum, 'version': published['version']})
            sys.exit(0)
        stage = 'download'
        def attachment(job):
            fetch(job, folder, reserve_gb=3, retries=2, timeout=90, max_bytes=source_release.LIMIT,
                  opener=lambda request, timeout: ProgressResponse(urllib.request.urlopen(request, timeout=timeout), job))
            return target_for(folder, job)
        try:
            target = attachment(published)
        except Exception as error:
            alternate = published.get('alternate')
            if not alternate or not (is_transient(error) or isinstance(error, ValueError) or
                                     (isinstance(error, urllib.error.HTTPError) and error.code in (403,404))):
                raise
            progress('MGF 下载中断，正在尝试同版本的另一种格式')
            published = alternate
            target = attachment(published)
        progress('正在核对官方附件校验值')
        sha256 = source_release.verify(target, published)
        stage = 'parse'
        extension = target.suffix[1:]
        with target.open(encoding='utf-8-sig') as stream:
            count = emit_spectra(output, stream, extension)
        metadata = {'version':published['version'], 'commit':sha256, 'upstreamChecksum':checksum,
                    'fileChecksum':published['checksum'],
                    'downloadCount':count, 'validation':'Zenodo checksum and SHA-256', 'url':published['url']}
    elif config['adapter'] == 'file':
        metadata = download_verified_file(output)
        if 'downloadCount' not in metadata:
            atomic(folder/'unchanged.json', metadata)
            sys.exit(0)
    else: raise ValueError('Unsupported adapter')
(folder/'download.json').write_text(json.dumps(metadata),encoding='utf-8')
