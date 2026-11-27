#!/usr/bin/env python3
"""Read this delivery's INSERT-per-line dump without executing SQL or loading it whole."""
import argparse, collections, hashlib, json, pathlib, re, time

def parse_row(text):
    # This delivery explicitly sets NO_BACKSLASH_ESCAPES. Quotes use SQL '' escaping.
    text=text.strip().rstrip(',;')
    if not text.startswith('(') or not text.endswith(')'): raise ValueError('unsupported tuple')
    values=[]; i=1; end=len(text)-1
    while i<end:
        if text[i]=="'":
            i+=1; buf=[]
            while i<end:
                if text[i]=="'":
                    if i+1<end and text[i+1]=="'": buf.append("'"); i+=2; continue
                    i+=1; break
                buf.append(text[i]); i+=1
            else: raise ValueError('unterminated SQL string')
            value=''.join(buf)
        else:
            start=i
            while i<end and text[i]!=',': i+=1
            token=text[start:i].strip()
            value=None if token.upper()=='NULL' else int(token) if re.fullmatch(r'-?\d+',token) else token
        values.append(value)
        if i<end:
            if text[i]!=',': raise ValueError('unsupported expression')
            i+=1
    return values

def rows(path):
    table=None; columns=[]; in_create=False; insert_columns=None; pending=[]; quote_count=0
    col_pattern=r'`?([A-Za-z_][A-Za-z0-9_]*)`?\s+(?:BIGINT|INTEGER|INT|TEXT|LONGTEXT|VARCHAR|REAL|DOUBLE|FLOAT|DECIMAL|JSON|BOOLEAN|TINYINT|DATETIME|TIMESTAMP|CHAR)\b'
    with open(path,encoding='utf-8') as handle:
        for number,line in enumerate(handle,1):
            if pending:
                pending.append(line); quote_count+=line.count("'")
                if quote_count%2==0 and line.rstrip().endswith(('),',');',')')):
                    yield ('row',table,(''.join(pending).strip(),insert_columns),number); pending=[]
                continue
            m=re.match(r'CREATE TABLE(?: IF NOT EXISTS)? `?([A-Za-z_][A-Za-z0-9_]*)`?\s*\(',line)
            if m:
                table=m[1]; columns=re.findall(col_pattern,line,re.I); in_create=True
                if ';' in line or re.search(r'\)\s*$',line): in_create=False; yield ('schema',table,columns,number)
                continue
            if in_create:
                columns+=re.findall(col_pattern,line,re.I)
                if re.match(r'\s*(?:\)|ENGINE)',line): in_create=False; yield ('schema',table,columns,number)
                continue
            m=re.match(r'INSERT INTO `([^`]+)`(?:\s*\((.*?)\))? VALUES\s*(.*)',line)
            if m:
                table=m[1]; insert_columns=re.findall(r'`([^`]+)`',m[2]) if m[2] else None
                tail=m[3]
                if not tail.strip(): continue
            elif line.startswith('(') and table: tail=line
            else: continue
            quote_count=tail.count("'")
            if quote_count%2==0 and tail.rstrip().endswith(('),',');',')')):
                yield ('row',table,(tail.strip(),insert_columns),number)
            else: pending=[tail]
    if pending: raise ValueError('unfinished SQL tuple at EOF')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('sql'); ap.add_argument('output'); args=ap.parse_args()
    out=pathlib.Path(args.output); out.mkdir(parents=True,exist_ok=True)
    schemas={}; counts=collections.Counter(); samples=collections.defaultdict(list); taxonomy={}; started=time.time()
    taxonomy_tables={'categories','source_categories','source_label_mapping'}
    for kind,table,value,line in rows(args.sql):
        if kind=='schema': schemas[table]=value; continue
        counts[table]+=1
        if table in taxonomy_tables or len(samples[table])<3:
            raw,cols=value
            try: data=parse_row(raw)
            except ValueError as exc: raise ValueError(f'{table} line {line}: {raw[:100]!r} / {raw[-100:]!r}') from exc
            names=cols or schemas.get(table,[])
            if len(data)!=len(names): raise ValueError(f'{table} line {line}: {len(data)} values / {len(names)} columns')
            record=dict(zip(names,data))
            if table in taxonomy_tables: taxonomy.setdefault(table,[]).append(record)
            elif len(samples[table])<3: samples[table].append(record)
    report={'input':str(pathlib.Path(args.sql).resolve()),'bytes':pathlib.Path(args.sql).stat().st_size,'seconds':round(time.time()-started,2),'schemas':schemas,'rowCounts':dict(counts),'samples':dict(samples),'taxonomy':taxonomy}
    (out/'dump-profile.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'tables':len(schemas),'rows':sum(counts.values()),'counts':dict(counts),'seconds':report['seconds']},ensure_ascii=False))
if __name__=='__main__': main()
