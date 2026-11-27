"""Package the checked source, Windows directory preview, guides and demo data."""
from pathlib import Path
import json
import zipfile
import hashlib

base = Path('.')
health = Path('outputs/服务器健康检查_20261016')
summary = json.loads((health / '最终检查结果.json').read_text())
assert summary['version'] == '2.1.8'
assert summary['checks']['unitTests']['failed'] == 0
assert json.loads((health / 'Windows包内容检查.json').read_text())['status'] == 'passed'

def checksum(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

source = Path('outputs/MasspecLib2_2.1.8_源码与分类演示.zip')
files = []
for name in ['src', 'prisma', 'scripts', 'tests', 'docs', 'build', 'resources', 'examples']:
    for p in Path(name).rglob('*'):
        if not p.is_file() or any(part in ['node_modules', '__pycache__', '.git'] for part in p.parts):
            continue
        if p.parts[:2] == ('src', 'generated') or p.name.startswith('.env'):
            continue
        files.append(p)
for name in ['package.json', 'package-lock.json', 'README.md', 'environment.yml', 'prisma.config.ts',
             'electron.vite.config.ts', 'electron-builder.yml', 'tsconfig.json', 'tsconfig.node.json',
             'tsconfig.web.json', 'eslint.config.mjs', '.env.masspeclib2.example', '.npmrc',
             '.gitignore', '.prettierignore', '.prettierrc.yaml']:
    p = Path(name)
    if p.is_file():
        files.append(p)
for name in ['outputs/分类功能演示库', 'outputs/服务器健康检查_20261016']:
    files.extend(p for p in Path(name).rglob('*') if p.is_file())
with zipfile.ZipFile(source, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for p in sorted(set(files)):
        archive.write(p, 'ptk-master2/' + p.as_posix())
with zipfile.ZipFile(source) as archive:
    assert archive.testzip() is None
    assert json.loads(archive.read('ptk-master2/package.json'))['version'] == '2.1.8'
    assert not any('/node_modules/' in name for name in archive.namelist())
    source_count = len(archive.namelist())
print('Source ZIP ready:', source, source.stat().st_size, flush=True)

preview = Path('outputs/MasspecLib2_2.1.8_Windows_x64_预览包.zip')
root = Path('dist/health-check-2.1.8/win-unpacked')
prefix = 'MasspecLib2-2.1.8-Windows-x64/'
with zipfile.ZipFile(preview, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
    for p in sorted(root.rglob('*')):
        if p.is_file():
            archive.write(p, prefix + p.relative_to(root).as_posix())
    for p in sorted(Path('outputs/分类功能演示库').rglob('*')):
        if p.is_file():
            archive.write(p, prefix + '分类功能演示库/' + p.relative_to('outputs/分类功能演示库').as_posix())
    archive.write('docs/Windows安装与数据库配置_2.1.8.md', prefix + 'Windows安装与数据库配置.md')
    archive.write(health / '服务器检查报告.md', prefix + '服务器检查报告.md')
    archive.writestr(prefix + '先阅读.txt',
        '本包是完整Windows x64目录预览包，不是MSI安装器。\n'
        '先阅读Windows安装与数据库配置.md。已有MySQL可直接复用。\n'
        '完整解压后运行MasspecLib2.exe，旁边资源文件和子目录均需保留。\n'
        '本包运行无需Conda或npm；源码构建MSI时才使用原masspeclib2环境。\n'
        '首次配置指向空演示库时，点击“初始化化合物”，选择演示目录中的初始化SQL。\n'
        '初始化后再导入分类功能演示包.msldata。\n')
with zipfile.ZipFile(preview) as archive:
    assert archive.testzip() is None
    assert prefix + 'MasspecLib2.exe' in archive.namelist()
    assert prefix + 'resources/app.asar' in archive.namelist()
    preview_count = len(archive.namelist())
print('Windows preview ZIP ready:', preview, preview.stat().st_size, flush=True)

# Refresh the small standalone demo archive so its first-start instructions match the full guide.
demo = Path('outputs/MasspecLib2_分类谱图液相梯度演示包.zip')
with zipfile.ZipFile(demo, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for p in sorted(Path('outputs/分类功能演示库').rglob('*')):
        if p.is_file():
            archive.write(p, '分类功能演示库/' + p.relative_to('outputs/分类功能演示库').as_posix())
artifacts = []
for file, count, kind in [(source, source_count, 'source'), (preview, preview_count, 'windows-directory-preview'),
                          (demo, None, 'demo-data')]:
    value = {'file': str(file), 'type': kind, 'bytes': file.stat().st_size, 'sha256': checksum(file)}
    if count is not None:
        value['files'] = count
    artifacts.append(value)
    file.with_suffix(file.suffix + '.sha256.txt').write_text(value['sha256'] + '  ' + file.name + '\n')
Path('outputs/MasspecLib2_2.1.8_交付清单.json').write_text(json.dumps(artifacts, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(artifacts, ensure_ascii=False, indent=2))
