import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export function generateDeliveryWix(options: { application: string; output: string; name: string; identity: string; version: string; icon: string }): { files: number; upgradeCode: string } {
  const { application, output, name, identity, version, icon } = options
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('安装包版本无效')
  const escape = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
  const guid = (s: string): string => {
    const x = hash('MasspecLib2-delivery:' + identity + ':' + s)
    return [x.slice(0, 8), x.slice(8, 12), '5' + x.slice(13, 16), 'a' + x.slice(17, 20), x.slice(20, 32)].join('-').toUpperCase()
  }
  const components: string[] = []
  let files = 0
  function tree(directory: string): string {
    let xml = ''
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name), rel = relative(application, full).replaceAll('\\', '/'), h = hash(rel).slice(0, 24)
      if (entry.isSymbolicLink()) throw new Error('安装模板不能包含符号链接')
      if (entry.isDirectory()) xml += `<Directory Id="D${h}" Name="${escape(entry.name)}">${tree(full)}</Directory>`
      else if (entry.isFile()) {
        const cid = 'C' + h, fid = rel === 'MasspecLib2.exe' ? 'MainExecutable' : 'F' + h
        components.push(cid); files++
        xml += `<Component Id="${cid}" Guid="${guid(rel)}" Win64="yes"><File Id="${fid}" Source="${escape(full)}" Name="${escape(entry.name)}"/><RegistryValue Root="HKCU" Key="Software\\Gamstek\\MasspecDelivery\\${escape(identity)}\\Components" Name="${h}" Type="integer" Value="1" KeyPath="yes"/></Component>`
      }
    }
    return xml
  }
  const directories = tree(application), upgradeCode = guid('upgrade')
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Product Id="*" Name="${escape(name)}" Language="1033" Version="${version}.0" Manufacturer="合肥引力波智谱科技有限公司" UpgradeCode="${upgradeCode}" Codepage="65001">
<Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" Platform="x64"/><MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version is already installed."/><MediaTemplate EmbedCab="yes" CompressionLevel="low"/>
<Icon Id="AppIcon" SourceFile="${escape(icon)}"/><Property Id="ARPPRODUCTICON" Value="AppIcon"/><Property Id="ARPNOMODIFY" Value="1"/>
<Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="LocalAppDataFolder"><Directory Id="VendorDir" Name="MasspecLib2"><Directory Id="INSTALLDIR" Name="${escape(identity)}">${directories}</Directory></Directory></Directory><Directory Id="DesktopFolder"/><Directory Id="ProgramMenuFolder"><Directory Id="ApplicationProgramsFolder" Name="${escape(name)}"/></Directory></Directory>
<DirectoryRef Id="INSTALLDIR"><Component Id="ApplicationShortcuts" Guid="${guid('shortcuts')}" Win64="yes"><Shortcut Id="DesktopShortcut" Directory="DesktopFolder" Name="${escape(name)}" Target="[#MainExecutable]" WorkingDirectory="INSTALLDIR" Icon="AppIcon"/><Shortcut Id="StartMenuShortcut" Directory="ApplicationProgramsFolder" Name="${escape(name)}" Target="[#MainExecutable]" WorkingDirectory="INSTALLDIR" Icon="AppIcon"/><RemoveFolder Id="RemoveProgramsFolder" Directory="ApplicationProgramsFolder" On="uninstall"/><RegistryValue Root="HKCU" Key="Software\\Gamstek\\MasspecDelivery\\${escape(identity)}" Name="Installed" Type="integer" Value="1" KeyPath="yes"/></Component></DirectoryRef>
<Feature Id="MainFeature" Title="${escape(name)}" Level="1">${components.map(c => `<ComponentRef Id="${c}"/>`).join('')}<ComponentRef Id="ApplicationShortcuts"/></Feature></Product></Wix>`
  writeFileSync(output, xml, 'utf8')
  return { files, upgradeCode }
}
