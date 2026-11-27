[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$DeliveryDirectory,
  [string]$UpgradeIdentity = 'administrator-candidate-2814'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$directory = (Resolve-Path -LiteralPath $DeliveryDirectory).Path
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$release = Join-Path $directory "releases/$version"
$admin = Join-Path $release 'admin/win-unpacked'
$customer = Join-Path $release 'customer/win-unpacked'
$wix = Join-Path $admin 'resources/delivery-tools/wix'
$icon = Join-Path $admin 'resources/delivery-tools/icon.ico'
$archive = Join-Path $release 'client-template.zip'
$marker = "$archive.indexed.json"
$msi = Join-Path $release "MasspecLib2-管理员端-${version}-x64.msi"

foreach ($app in @($admin,$customer)) {
  if (!(Test-Path -LiteralPath (Join-Path $app 'MasspecLib2.exe'))) { throw "缺少解包应用 $app" }
}
foreach ($name in @('delivery-profile.json','shared-server.json')) {
  $profile = Get-Content -LiteralPath (Join-Path $customer "resources/$name") -Raw | ConvertFrom-Json
  if ($profile.enabled -ne $false -or @($profile.PSObject.Properties).Count -ne 1) {
    throw "客户模板配置必须只有 enabled=false"
  }
}
if (Test-Path -LiteralPath (Join-Path $customer 'resources/offline-delivery.msldelivery')) {
  throw '客户打包模板含既有交付数据'
}

Push-Location -LiteralPath $project
try {
  $wxs = Join-Path $release 'admin.wxs'
  $obj = Join-Path $release 'admin.wixobj'
  node --experimental-strip-types (Join-Path $PSScriptRoot 'generate-admin-wix.mjs') $admin $wxs $UpgradeIdentity $version $icon
  if ($LASTEXITCODE -ne 0) { throw '生成 WiX 安装定义失败' }
  & (Join-Path $wix 'candle.exe') -nologo -arch x64 -out $obj $wxs
  if ($LASTEXITCODE -ne 0) { throw 'WiX 编译失败' }
  & (Join-Path $wix 'light.exe') -nologo -sval -out $msi $obj
  if ($LASTEXITCODE -ne 0) { throw 'WiX 生成 MSI 失败' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stage = "$archive.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.Compression.ZipFile]::CreateFromDirectory($customer, $stage)
    $checksum = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $stage -Destination $archive -Force
    $data = @{ sha256 = $checksum; version = $version } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($marker, $data, [Text.UTF8Encoding]::new($false))
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage }
  }
  Get-Item -LiteralPath $msi,$archive,$marker
} finally {
  Pop-Location
}
