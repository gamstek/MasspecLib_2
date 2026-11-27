"""Add a dedicated API-only SSH forwarding identity; leave all existing users unchanged."""
from pathlib import Path
import base64, hashlib, json, os, pwd, secrets, signal, subprocess

base = Path('/workspace/mysql-masspeclib2/customer-delivery')
config_file = base / 'config.json'
config = json.loads(config_file.read_text())
name = 'mspec_delivery_gateway'
dropin = Path('/etc/ssh/sshd_config.d/90-masspec-delivery-gateway.conf')
if 'gateway' not in config:
    try:
        pwd.getpwnam(name)
        raise SystemExit('专用通道账号已存在且尚未登记配置，请人工核对，未覆盖账号。')
    except KeyError:
        pass
    password = secrets.token_urlsafe(32)
    subprocess.run(['useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', name], check=True)
    subprocess.run(['chpasswd'], input=f'{name}:{password}\n', text=True, check=True)
    content = f'''# MasspecLib2 customer delivery: API transport only.
Match User {name}
    AuthenticationMethods password
    PasswordAuthentication yes
    PermitEmptyPasswords no
    PubkeyAuthentication no
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitOpen 127.0.0.1:8443
    PermitListen none
    MaxSessions 0
    PermitTTY no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserRC no
    ForceCommand /usr/sbin/nologin
Match all
'''
    if dropin.exists():
        raise SystemExit('专用通道配置已存在，未覆盖。')
    dropin.write_text(content)
    os.chmod(dropin, 0o600)
    subprocess.run(['/usr/sbin/sshd', '-t'], check=True)
    host_key = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()[1]
    config['gateway'] = {'username': name, 'password': password, 'port': 2222, 'hostFingerprint': hashlib.sha256(base64.b64decode(host_key)).hexdigest()}
    config['host'] = '127.0.0.1'
    config_file.write_text(json.dumps(config, indent=2))
    profile_file = base / 'admin-profile.json'
    profile = json.loads(profile_file.read_text())
    profile['gateway'] = config['gateway']
    profile_file.write_text(json.dumps(profile, indent=2))
    # Reload only the listening parent; existing SSH sessions continue normally.
    found = False
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / 'cmdline').read_bytes()
            if command.startswith(b'sshd: /usr/sbin/sshd [listener]'):
                os.kill(int(entry.name), signal.SIGHUP)
                found = True
                break
        except (OSError, ValueError):
            pass
    if not found:
        raise SystemExit('配置校验通过，但未定位SSH监听进程，请重新加载sshd。')
print(json.dumps({'gateway': 'configured', 'sshPort': 2222, 'permittedDestination': '127.0.0.1:8443', 'shell': 'denied', 'databaseForwarding': 'denied', 'existingAccounts': 'unchanged'}))
