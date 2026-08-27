param(
  [ValidateSet('install','repair','uninstall')][string]$Mode = 'install',
  [int]$Port = 8443,
  [string]$Domain = '',
  [switch]$Ssl,
  [switch]$NoSsl,
  [switch]$HttpOnly,
  [string]$CertFile = '',
  [string]$KeyFile = '',
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$AppName = 'dglab-mutual-web'
$AppDir = Join-Path $env:ProgramData 'DGLabMutualWeb'
$ConfigFile = Join-Path $AppDir 'deploy-config.json'
$TaskApp = 'DG-LAB Mutual Web'
$TaskCert = 'DG-LAB Mutual Web Cert Sync'
$LogDir = Join-Path $AppDir 'logs'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PortWasSet = $PSBoundParameters.ContainsKey('Port')
$DomainWasSet = $PSBoundParameters.ContainsKey('Domain')
$SslWasSet = $PSBoundParameters.ContainsKey('Ssl') -or $PSBoundParameters.ContainsKey('NoSsl') -or $PSBoundParameters.ContainsKey('HttpOnly')
$CertWasSet = $PSBoundParameters.ContainsKey('CertFile')
$KeyWasSet = $PSBoundParameters.ContainsKey('KeyFile')
$UseSsl = -not ($NoSsl -or $HttpOnly)
if ($Ssl) { $UseSsl = $true }
$DomainDir = ''
$SslDir = ''
$ActiveTlsDir = ''

function Step([string]$m) { Write-Host "`n[$(Get-Date -Format HH:mm:ss)] $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Fail([string]$m) { throw $m }
function Validate-Port([int]$p) { if ($p -lt 1 -or $p -gt 65535) { Fail '网页端口必须在 1-65535 之间' } }
function Validate-Host([string]$h) { if ($h -and $h -notmatch '^[A-Za-z0-9.-]+$') { Fail '域名/IP 只填写 example.com 或 1.2.3.4，不要带协议、端口或路径' } }
function Is-Admin { $id=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=New-Object Security.Principal.WindowsPrincipal($id); return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

if ($Mode -eq 'repair') {
  if (-not (Test-Path $ConfigFile)) { Fail "找不到上次部署配置: $ConfigFile" }
  $saved = Get-Content $ConfigFile -Raw | ConvertFrom-Json
  if (-not $PortWasSet) { $Port = [int]$saved.WebPort }
  if (-not $DomainWasSet) { $Domain = [string]$saved.Domain }
  if (-not $SslWasSet) { $UseSsl = [bool]$saved.UseSsl }
  if (-not $CertWasSet) { $CertFile = [string]$saved.CertFile }
  if (-not $KeyWasSet) { $KeyFile = [string]$saved.KeyFile }
}

function Set-DomainPaths {
  if ($Domain) {
    $script:DomainDir = Join-Path (Join-Path $AppDir 'domains') $Domain
    $script:SslDir = Join-Path $script:DomainDir 'ssl'
    $script:ActiveTlsDir = Join-Path $script:SslDir 'active'
  } else {
    $script:DomainDir=''; $script:SslDir=''; $script:ActiveTlsDir=''
  }
}
function Prepare-DomainSslDir {
  if (-not $Domain) { return }
  Set-DomainPaths
  New-Item -ItemType Directory -Force -Path $DomainDir,$SslDir,$ActiveTlsDir | Out-Null
}
function Import-CliTlsFiles {
  if (-not $UseSsl) { return }
  Prepare-DomainSslDir
  if ($CertFile -and (Test-Path $CertFile) -and ((Split-Path -Parent $CertFile) -ne $SslDir)) { Copy-Item $CertFile (Join-Path $SslDir (Split-Path -Leaf $CertFile)) -Force }
  if ($KeyFile -and (Test-Path $KeyFile) -and ((Split-Path -Parent $KeyFile) -ne $SslDir)) { Copy-Item $KeyFile (Join-Path $SslDir (Split-Path -Leaf $KeyFile)) -Force }
}
function Get-SslCandidates {
  if (-not $SslDir -or -not (Test-Path $SslDir)) { return @() }
  @(Get-ChildItem -Path $SslDir -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike ($ActiveTlsDir+'*') -and $_.Extension.ToLowerInvariant() -in @('.pem','.crt','.cer','.key') })
}
function Test-SslPrecheck {
  $haveCert=$false; $haveKey=$false
  foreach($f in (Get-SslCandidates)) {
    try {
      $txt=Get-Content $f.FullName -Raw -ErrorAction Stop
      if($txt -match '-----BEGIN CERTIFICATE-----'){$haveCert=$true}
      if($txt -match '-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----'){$haveKey=$true}
    } catch {}
  }
  return ($haveCert -and $haveKey)
}
function Wait-SslFiles {
  if(-not $UseSsl){return}
  Prepare-DomainSslDir
  if(Test-SslPrecheck){return}
  if($Yes){Fail "未在 $SslDir 找到证书和私钥。请把 *.pem/*.crt/*.cer/*.key 放入该目录后重试。"}
  while($true){
    Write-Host "`n域名目录已创建: $DomainDir"
    Write-Host "请把 SSL 文件放入: $SslDir"
    Write-Host '文件名可以任意；脚本会通配符扫描 *.pem/*.crt/*.cer/*.key。'
    $v=(Read-Host '放好后按 Enter 自动扫描；输入 q 退出').Trim().ToLowerInvariant()
    if($v -eq 'q'){exit 0}
    if(Test-SslPrecheck){return}
    Warn '仍未检测到证书 + 私钥文件。'
    Get-SslCandidates | ForEach-Object { Write-Host ('  '+$_.FullName) }
  }
}



if (-not (Is-Admin)) {
  Step '需要管理员权限以创建域名目录；正在弹出 UAC 后重新进入配置向导。'
  $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'))
  if($Mode -ne 'install'){$args+=@('-Mode',$Mode)}
  if($PortWasSet){$args+=@('-Port',$Port)}
  if($DomainWasSet){$args+=@('-Domain',$Domain)}
  if($SslWasSet){if($UseSsl){$args+='-Ssl'}else{$args+='-NoSsl'}}
  if($CertWasSet){$args+=@('-CertFile',('"'+$CertFile+'"'))}
  if($KeyWasSet){$args+=@('-KeyFile',('"'+$KeyFile+'"'))}
  if($Yes){$args+='-Yes'}
  Start-Process powershell.exe -Verb RunAs -ArgumentList $args | Out-Null
  exit 0
}

if ($Mode -eq 'install' -and -not $Yes) {
  Write-Host "`n========== DG-LAB 部署配置 ==========" -ForegroundColor Magenta
  if (-not $PortWasSet) {
    $v = Read-Host '网页公网访问端口 [8443]'
    if ($v) { $tmp=0; if (-not [int]::TryParse($v,[ref]$tmp)) { Fail '端口必须是数字' }; $Port=$tmp }
  } else { Write-Host "网页公网访问端口: $Port" }
  Validate-Port $Port

  if (-not $DomainWasSet) {
    while ($true) {
      $Domain = (Read-Host '域名/IP [HTTP 可留空]').Trim()
      if (-not $Domain -or $Domain -match '^[A-Za-z0-9.-]+$') { break }
      Warn '只填写 example.com 或 1.2.3.4，不要带 http://、https://、端口或路径。'
    }
  } else { Write-Host "域名/IP: $(if($Domain){$Domain}else{'<留空>'})" }
  Validate-Host $Domain
  if($Domain){ Prepare-DomainSslDir; Write-Host "域名目录 : $DomainDir"; Write-Host "SSL目录  : $SslDir" }

  if (-not $SslWasSet) {
    $v=(Read-Host '启用 SSL/HTTPS？[Y/n]').Trim().ToLowerInvariant()
    $UseSsl = -not ($v -in @('n','no','0'))
  } else { Write-Host "SSL/HTTPS: $(if($UseSsl){'启用'}else{'禁用'})" }

  if ($UseSsl) {
    while (-not $Domain) {
      Warn 'HTTPS 需要域名/IP。'
      $Domain=(Read-Host '请输入证书对应的域名/IP').Trim(); Validate-Host $Domain
      if($Domain){Prepare-DomainSslDir}
    }
    Prepare-DomainSslDir
    Import-CliTlsFiles
    Wait-SslFiles
  }

  $proto=if($UseSsl){'https'}else{'http'}; $h=if($Domain){$Domain}else{'服务器IP'}
  $preview="${proto}://${h}:$Port"; if(($UseSsl -and $Port -eq 443) -or ((-not $UseSsl) -and $Port -eq 80)){ $preview="${proto}://${h}" }
  Write-Host "`n---------- 请确认部署参数 ----------"
  Write-Host "网页端口 : $Port（只使用此端口）"
  Write-Host "域名/IP  : $(if($Domain){$Domain}else{'<服务器IP>'})"
  Write-Host "SSL      : $(if($UseSsl){'开启（HTTPS/WSS）'}else{'关闭（HTTP/WS）'})"
  if($UseSsl){ Write-Host "SSL目录  : $SslDir"; Write-Host '证书识别 : 自动通配符扫描并校验匹配' }
  Write-Host "预计地址 : $preview"
  Write-Host '端口策略 : 不占用、不停止、不删除、不重配其他端口上的现有项目。'
  if($Port -notin @(80,443)){ Write-Host '80/443   : 完全不使用；现有项目保持原样。' }
  else { Write-Host "$Port      : 你主动选择了该端口；若已占用，部署直接退出。" }
  $c=(Read-Host '确认以上配置并开始部署？[Y/n]').Trim().ToLowerInvariant()
  if($c -in @('n','no','0')){ Write-Host '已取消，未开始安装。'; exit 0 }
}

Validate-Port $Port; Validate-Host $Domain
if($UseSsl -and -not $Domain){Fail '启用 SSL 时必须提供域名/IP'}
Set-DomainPaths

function Test-PortBusy([int]$p){
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
  catch { $x=netstat -ano -p tcp | Select-String -Pattern (":$p\s+.*LISTENING"); return [bool]$x }
}
function Stop-OwnTask { Stop-ScheduledTask -TaskName $TaskApp -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
function Check-SelectedPort { if(Test-PortBusy $Port){ Fail "你指定的端口 $Port 已被其他项目占用。脚本不会停止或删除它，请换一个端口。" } }

function Download([string]$uri,[string]$out){
  for($i=1;$i -le 3;$i++){ try{ Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $out -TimeoutSec 180; return }catch{ if($i -eq 3){throw}; Start-Sleep -Seconds 2 } }
}
function Node-Ok([string]$bin){
  if(-not (Test-Path $bin)){return $false}; try{$v=& $bin -p "Number(process.versions.node.split('.')[0])"; return ([int]$v -ge 20)}catch{return $false}
}
function Ensure-Node {
  $sys=(Get-Command node.exe -ErrorAction SilentlyContinue)
  if($sys -and (Node-Ok $sys.Source)){ Step "使用现有 Node.js: $(& $sys.Source -v)"; return $sys.Source }
  $runtime=Join-Path $AppDir 'runtime'; New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $arch=if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'}
  if($env:PROCESSOR_ARCHITECTURE -match 'ARM64'){$arch='arm64'}
  Step '安装独立 Node.js 22 LTS（仅本项目目录）…'
  $sumFile=Join-Path $env:TEMP 'dglab-node-sums.txt'; Download 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' $sumFile
  $line=(Get-Content $sumFile | Where-Object {$_ -match "node-v.*-win-$arch\.zip$"} | Select-Object -First 1)
  if(-not $line){Fail "找不到 Windows $arch Node.js 包"}
  $parts=$line -split '\s+'; $hash=$parts[0]; $zipName=$parts[-1]; $zip=Join-Path $env:TEMP $zipName
  Download ("https://nodejs.org/dist/latest-v22.x/"+$zipName) $zip
  $actual=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant(); if($actual -ne $hash.ToLowerInvariant()){Fail 'Node.js SHA256 校验失败'}
  Remove-Item (Join-Path $runtime 'node') -Recurse -Force -ErrorAction SilentlyContinue
  $tmp=Join-Path $runtime 'extract'; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $zip $tmp -Force
  $folder=Get-ChildItem $tmp -Directory | Select-Object -First 1; Move-Item $folder.FullName (Join-Path $runtime 'node'); Remove-Item $tmp -Recurse -Force
  $bin=Join-Path $runtime 'node\node.exe'; if(-not (Node-Ok $bin)){Fail 'Node.js 无法运行'}; return $bin
}

function Copy-App([string]$nodeBin){
  New-Item -ItemType Directory -Force -Path $AppDir,$LogDir | Out-Null
  foreach($f in @('index.html','app.js','server.js','tls-scan.js','package.json','README.md','VERSION.txt','deploy.sh','deploy.ps1','OFFICIAL_SOCKET.md','LICENSE-GPL-3.0')){ $src=Join-Path $ScriptDir $f; if(Test-Path $src){Copy-Item $src (Join-Path $AppDir $f) -Force} }
  $vendorSrc=Join-Path $ScriptDir 'vendor'; if(Test-Path $vendorSrc){$vendorDst=Join-Path $AppDir 'vendor'; Remove-Item $vendorDst -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item $vendorSrc $vendorDst -Recurse -Force}
  & $nodeBin --check (Join-Path $AppDir 'server.js'); if($LASTEXITCODE -ne 0){Fail 'server.js 语法检查失败'}
  & $nodeBin --check (Join-Path $AppDir 'app.js'); if($LASTEXITCODE -ne 0){Fail 'app.js 语法检查失败'}
}

function Copy-Tls([string]$nodeBin) {
  if(-not $UseSsl){return}
  Prepare-DomainSslDir
  Import-CliTlsFiles
  $scanner=Join-Path $AppDir 'tls-scan.js'
  while($true){
    $raw=''
    try { $raw=& $nodeBin $scanner --dir $SslDir --domain $Domain 2>$null } catch {}
    $obj=$null
    if($raw){ try{$obj=$raw | ConvertFrom-Json}catch{} }
    if($obj -and $obj.ok){
      $script:CertFile=[string]$obj.cert; $script:KeyFile=[string]$obj.key
      if($obj.hostMatch -eq $false){ Warn "证书可能不匹配域名 $Domain；通配符证书如 *.example.com 可用于对应子域名。" }
      New-Item -ItemType Directory -Force -Path $ActiveTlsDir | Out-Null
      Copy-Item $CertFile (Join-Path $ActiveTlsDir 'server.crt') -Force
      Copy-Item $KeyFile (Join-Path $ActiveTlsDir 'server.key') -Force
      Write-Host "SSL 自动识别成功:`n  证书: $CertFile`n  私钥: $KeyFile`n  运行副本: $ActiveTlsDir"
      return
    }
    if($Yes){Fail "未在 $SslDir 找到有效且公钥匹配的证书/私钥。"}
    Warn '找到的 SSL 文件无法组成有效匹配的一对证书/私钥。'
    Write-Host "请检查或替换 $SslDir 中的 *.pem/*.crt/*.cer/*.key。"
    $v=(Read-Host '修改后按 Enter 重新自动扫描；输入 q 退出').Trim().ToLowerInvariant()
    if($v -eq 'q'){exit 0}
  }
}

function Save-Config([string]$nodeBin){
  [ordered]@{WebPort=$Port;Domain=$Domain;UseSsl=$UseSsl;SslDir=$SslDir;CertFile=$CertFile;KeyFile=$KeyFile;NodeBin=$nodeBin} | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
}

function Write-Run([string]$nodeBin){
  $cmd=Join-Path $AppDir 'run-app.cmd'; $lines=@('@echo off',"set PORT=$Port",'set HOST=0.0.0.0')
  if($UseSsl){$lines+=@("set TLS_CERT_FILE=$ActiveTlsDir\server.crt","set TLS_KEY_FILE=$ActiveTlsDir\server.key")}
  $lines += ('"'+$nodeBin+'" "'+(Join-Path $AppDir 'server.js')+'" >> "'+(Join-Path $LogDir 'app.log')+'" 2>&1')
  $lines | Set-Content $cmd -Encoding ASCII
}

function Register-AppTask {
  Unregister-ScheduledTask -TaskName $TaskApp -Confirm:$false -ErrorAction SilentlyContinue
  $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $trigger=New-ScheduledTaskTrigger -AtStartup
  $action=New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c "'+(Join-Path $AppDir 'run-app.cmd')+'"')
  Register-ScheduledTask -TaskName $TaskApp -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $TaskApp
}

function Register-CertSync {
  Unregister-ScheduledTask -TaskName $TaskCert -Confirm:$false -ErrorAction SilentlyContinue
  if(-not $UseSsl){return}
  $sync=Join-Path $AppDir 'sync-cert.ps1'
  @"
`$ErrorActionPreference='Stop'
`$cfg=Get-Content '$ConfigFile' -Raw | ConvertFrom-Json
`$sslDir=if(`$cfg.SslDir){[string]`$cfg.SslDir}else{Join-Path (Join-Path (Join-Path '$AppDir' 'domains') ([string]`$cfg.Domain)) 'ssl'}
`$active=Join-Path `$sslDir 'active'
`$scanner=Join-Path '$AppDir' 'tls-scan.js'
`$raw=& ([string]`$cfg.NodeBin) `$scanner --dir `$sslDir --domain ([string]`$cfg.Domain) 2>`$null
if(-not `$raw){exit 0}
try{`$pair=`$raw | ConvertFrom-Json}catch{exit 0}
if(-not `$pair.ok){exit 0}
New-Item -ItemType Directory -Force -Path `$active | Out-Null
`$dstC=Join-Path `$active 'server.crt'; `$dstK=Join-Path `$active 'server.key'; `$changed=`$false
if(-not (Test-Path `$dstC) -or (Get-FileHash ([string]`$pair.cert)).Hash -ne (Get-FileHash `$dstC).Hash){Copy-Item ([string]`$pair.cert) `$dstC -Force; `$changed=`$true}
if(-not (Test-Path `$dstK) -or (Get-FileHash ([string]`$pair.key)).Hash -ne (Get-FileHash `$dstK).Hash){Copy-Item ([string]`$pair.key) `$dstK -Force; `$changed=`$true}
if(`$changed){Stop-ScheduledTask -TaskName '$TaskApp' -ErrorAction SilentlyContinue; Start-Sleep 1; Start-ScheduledTask -TaskName '$TaskApp'}
"@ | Set-Content $sync -Encoding UTF8
  $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  $trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(10)) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
  $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+$sync+'"')
  Register-ScheduledTask -TaskName $TaskCert -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

function Open-Firewall {
  Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -like 'DG-LAB Mutual Web*'} | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "DG-LAB Mutual Web Public $Port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  Step "仅放行 TCP $Port；不新增 80/443 规则。"
}

function Health {
  Step "检查指定端口 $Port…"; $ok=$false
  for($i=0;$i -lt 20;$i++){
    try{
      if($UseSsl){
        $curl=Get-Command curl.exe -ErrorAction SilentlyContinue
        if($curl){& curl.exe -kfsS --max-time 3 --resolve "${Domain}:${Port}:127.0.0.1" "https://${Domain}:${Port}/healthz" *> $null; if($LASTEXITCODE -eq 0){$ok=$true;break}}
      } else { $r=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3; if($r.ok){$ok=$true;break} }
    }catch{}
    Start-Sleep -Seconds 1
  }
  if(-not $ok){$log=Join-Path $LogDir 'app.log'; if(Test-Path $log){Get-Content $log -Tail 80 | Write-Host}; Fail "服务没有在你指定的端口 $Port 正常启动"}
  Step '健康检查通过'
}

function Uninstall-All {
  Step '仅卸载 DG-LAB Mutual Web；不会操作 IIS/Nginx/Apache/Caddy 或其他项目。'
  Stop-ScheduledTask -TaskName $TaskApp -ErrorAction SilentlyContinue; Stop-ScheduledTask -TaskName $TaskCert -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskApp -Confirm:$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskCert -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -like 'DG-LAB Mutual Web*'} | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
  Step '卸载完成；80/443 和已有项目未被修改。'
}

if($Mode -eq 'uninstall'){Uninstall-All; exit 0}
Stop-OwnTask
Check-SelectedPort
New-Item -ItemType Directory -Force -Path $AppDir,$LogDir | Out-Null
Set-DomainPaths
if($UseSsl){Prepare-DomainSslDir; Import-CliTlsFiles}
$nodeBin=Ensure-Node
Copy-App $nodeBin
Copy-Tls $nodeBin
Save-Config $nodeBin
Write-Run $nodeBin
Register-AppTask
Register-CertSync
Open-Firewall
Health
$proto=if($UseSsl){'https'}else{'http'}; $hostName=if($Domain){$Domain}else{'服务器IP'}; $url="${proto}://${hostName}:$Port"; if(($UseSsl -and $Port -eq 443)-or((-not $UseSsl)-and $Port -eq 80)){$url="${proto}://${hostName}"}
Write-Host "`n部署完成" -ForegroundColor Green
Write-Host "访问地址: $url`n实际监听端口: $Port"
if($Port -notin @(80,443)){Write-Host '80/443: 未使用、未停止、未删除、未重配。'}
Write-Host "修复命令: powershell -ExecutionPolicy Bypass -File `"$AppDir\deploy.ps1`" -Mode repair"
