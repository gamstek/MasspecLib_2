from argparse import ArgumentParser
from pathlib import Path
import json
import os
import subprocess


def main():
    repo = Path(__file__).resolve().parents[2]
    local_node = repo / '.runtime/test1/node/bin/node'
    parser = ArgumentParser(description='Start the MasspecLib2 delivery service from an existing configuration.')
    parser.add_argument('--config', type=Path, default=Path(os.environ.get(
        'MSL_DELIVERY_CONFIG', repo / '.server/test1/config.json')))
    parser.add_argument('--node', default=os.environ.get('MSL_NODE', str(local_node) if local_node.is_file() else 'node'))
    parser.add_argument('--foreground', action='store_true')
    args = parser.parse_args()
    config_file = args.config.resolve()
    config = json.loads(config_file.read_text(encoding='utf-8'))
    directory = Path(config['directory'])
    project = Path(config['project'])
    server = project / 'scripts/customer-delivery/server.cjs'
    lock = directory / 'service.lock'

    if lock.is_file():
        try:
            pid = int(lock.read_text())
            cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if any(arg.endswith(b'customer-delivery/server.cjs') for arg in cmdline):
                print(json.dumps({'status': 'already-running', 'pid': pid}))
                return
        except (OSError, ValueError):
            pass

    command = [args.node, str(server), str(config_file)]
    if args.foreground:
        os.chdir(project)
        os.execvp(command[0], command)
    with (directory / 'service.log').open('ab') as log:
        process = subprocess.Popen(command, cwd=project, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    print(json.dumps({'status': 'started', 'pid': process.pid}))


if __name__ == '__main__':
    main()
