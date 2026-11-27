import { generateDeliveryWix } from '../../src/shared/deliveryInstaller.ts'

const [application, output, identity, version, icon] = process.argv.slice(2)
if (!application || !output || !/^[a-z0-9-]{1,80}$/.test(identity || '') || !version || !icon) {
  throw Error('请提供应用目录、WiX 输出、安装标识、版本和图标')
}
generateDeliveryWix({ application, output, name: 'MasspecLib2 管理员端', identity, version, icon })
