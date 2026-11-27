"""Resolve published spectral files and verify the official attachment before parsing."""
import hashlib
import json
import re
import urllib.parse
import urllib.request

from source_network import read_json

MSDIAL = 'https://systemsomicslab.github.io/compms/msdial/main.html'
MSNLIB = 'https://zenodo.org/api/records/21105617/versions/latest'
LIMIT = 512 * 1024 * 1024


def metadata(url):
    return read_json(urllib.request.Request(url, headers={'User-Agent': 'MasspecLib2'}), 4_000_000)

def zenodo_job(adapter, scope, release, published, version, filename):
    checksum = published['checksum']
    if not re.fullmatch(r'(md5:[a-f0-9]{32}|sha256:[a-f0-9]{64})', checksum) or not 0 < published['size'] <= LIMIT:
        raise ValueError('Unsupported attachment size or checksum')
    url = f"https://zenodo.org/api/records/{int(release['id'])}/files/{urllib.parse.quote(published['key'])}/content"
    return {'id': hashlib.sha256(f'{adapter}/{scope}/{checksum}'.encode()).hexdigest(),
            'source_ids': ['4' if adapter == 'msdial' else '5'], 'filename': filename,
            'version': version, 'checksum': checksum, 'expected_size': published['size'], 'url': url}

def resolve(adapter, scope):
    if adapter == 'msdial':
        if scope not in ('pos', 'neg'):
            raise ValueError('Unsupported MS-DIAL polarity')
        with urllib.request.urlopen(urllib.request.Request(MSDIAL, headers={'User-Agent': 'MasspecLib2'}), timeout=30) as reply:
            page = reply.read(2_000_000).decode('utf-8')
        links = set(re.findall(
            r'https://zenodo\.org/records/(\d+)/files/(MSMS-Public_experimentspectra-' + scope + r'-VS(\d+)\.msp)\b', page))
        if not links:
            raise ValueError('Official MS-DIAL page does not list the selected experimental MSP')
        record, filename, version = max(links, key=lambda item: (int(item[2]), int(item[0])))
        release = metadata('https://zenodo.org/api/records/' + record)
        version = 'VS' + version
    elif adapter == 'msnlib':
        if not re.fullmatch(r'(targetmol_hts_np|mcediv_50k_sub|enammol|enamdisc|nihnp|mcebio|mcedrug|mcescaf)_(pos|neg)_ms2', scope):
            raise ValueError('Unsupported MSnLib subset')
        release = metadata(MSNLIB)
        if str(release.get('conceptrecid')) != '11163380':
            raise ValueError('MSnLib release series has changed')
        matches = [file['key'] for file in release['files'] if re.fullmatch(r'\d{8}_' + scope + r'\.mgf', file['key'])]
        if len(matches) != 1:
            raise ValueError('Selected MSnLib MGF export is missing or ambiguous')
        filename = matches[0]
        version = 'Zenodo ' + str(release['id'])
    else:
        raise ValueError('Unsupported release source')
    published = next(file for file in release['files'] if file['key'] == filename)
    job = zenodo_job(adapter, scope, release, published, version, filename)
    if adapter == 'msnlib':
        alternate = next((file for file in release['files'] if file['key'] == filename[:-4] + '.json'), None)
        if alternate and 0 < alternate.get('size', 0) <= LIMIT:
            job['alternate'] = zenodo_job(adapter, scope, release, alternate, version, filename[:-4] + '.ndjson')
    return job

def msnlib_json_blocks(stream):
    fields = {'compound_name':'TITLE', 'usi':'USI', 'inchikey':'INCHIKEY', 'smiles':'SMILES',
              'formula':'FORMULA', 'ms_level':'MSLEVEL', 'precursor_mz':'PEPMASS',
              'polarity':'POLARITY', 'adduct':'ADDUCT', 'instrument':'INSTRUMENT'}
    while line := stream.readline(8_000_001):
        if len(line)>8_000_000:
            raise ValueError('A spectrum record exceeds the maximum size')
        if not line.strip():
            continue
        row = json.loads(line)
        values = [(key, str(row[prop])) for prop,key in fields.items() if row.get(prop) is not None]
        if any('\n' in value or '\r' in value for _,value in values):
            raise ValueError('Unexpected line break in MSnLib field')
        peaks = row['peaks']
        if not peaks or row.get('num_peaks') not in (None,len(peaks)):
            raise ValueError('Incomplete MSnLib peak list')
        yield '\n'.join(['BEGIN IONS', *(f'{key}={value}' for key,value in values),
                         *(f'{mz} {intensity}' for mz,intensity in peaks), 'END IONS'])


def verify(file, published):
    method, checksum = published['checksum'].split(':')
    official = hashlib.new(method)
    sha = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            official.update(chunk)
            sha.update(chunk)
    if file.stat().st_size != published['expected_size'] or official.hexdigest() != checksum:
        raise ValueError('Published file length or checksum mismatch')
    return sha.hexdigest()


def blocks(stream, extension):
    """Emit complete MGF or MSP records with bounded memory."""
    block = []
    length = 0
    while line := stream.readline(8_000_001):
        length += len(line)
        if length > 8_000_000:
            raise ValueError('A spectrum record exceeds the maximum size')
        line = line.strip()
        if not line:
            continue
        if ((extension == 'msp' and re.match(r'^name\s*:', line, re.I))
                or (extension == 'mgf' and line.upper() == 'BEGIN IONS')) and block:
            yield '\n'.join(block)
            block = []
            length = len(line)
        block.append(line)
        if extension == 'mgf' and line.upper() == 'END IONS':
            yield '\n'.join(block)
            block = []
            length = 0
    if block:
        yield '\n'.join(block)
