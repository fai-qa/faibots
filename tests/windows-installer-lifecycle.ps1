# Run only inside a new Windows Sandbox or standard GitHub-hosted Windows VM with Node 24+.
# Supply two known offline x64 NSIS installers containing different app builds and their SHA-256s.
# Example: .\tests\windows-installer-lifecycle.ps1 -PreviousInstaller old.exe -PreviousSha256 $oldHash -CurrentInstaller new.exe -CurrentSha256 $newHash
# Optional -SignerThumbprint requires both installers to have a valid signature from the specified signer.
# JSON on stdout is the receipt. Discard the VM after the trial, including after any failure.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PreviousInstaller,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$PreviousSha256,
    [Parameter(Mandatory)][string]$CurrentInstaller,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$CurrentSha256,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SignerThumbprint
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Requires a disposable Windows runner.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$account = $identity.Name.Split('\')[-1]
$hosted = $account -eq 'runneradmin' -and $env:GITHUB_ACTIONS -eq 'true' -and
    $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows' -and $env:ImageOS -match '^win'
$sandbox = $account -eq 'WDAGUtilityAccount' -and $identity.User.Value.EndsWith('-504')
if (-not ($hosted -or $sandbox)) { throw 'Refused outside Windows Sandbox or a GitHub-hosted Windows runner.' }
$hardware = Get-CimInstance Win32_ComputerSystem
if ($hardware.Model -notmatch 'Virtual Machine') { throw 'Requires a recognized disposable virtual machine.' }
if ($PreviousSha256 -eq $CurrentSha256) { throw 'The installers must have different expected hashes.' }
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
& $node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1); require('node:sqlite')"
if ($LASTEXITCODE -ne 0) { throw 'The runner must provide Node 24+ with node:sqlite.' }

$profileDir = [Environment]::GetFolderPath('UserProfile')
$program = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\faibots'
$data = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'faibots'
$exe = Join-Path $program 'faibots.exe'
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'faibots.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'faibots.lnk')
)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$runValue = 'com.faibots.app'

function Get-Registration {
    foreach ($root in 'HKCU:\Software', 'HKCU:\Software\WOW6432Node', 'HKLM:\Software', 'HKLM:\Software\WOW6432Node') {
        $key = Join-Path $root 'Microsoft\Windows\CurrentVersion\Uninstall'
        if (Test-Path -LiteralPath $key) {
            Get-ChildItem -LiteralPath $key | Where-Object { $_.GetValue('DisplayName') -match '^faibots(?:\s+[\d.].*)?$' }
        }
    }
}

function Test-LoginEntry([string]$Key) {
    (Test-Path -LiteralPath $Key) -and ((Get-Item -LiteralPath $Key).GetValueNames() -contains $runValue)
}

function Get-Installer([string]$File, [string]$Hash) {
    $item = Get-Item -LiteralPath $File
    if ($item.PSIsContainer -or $item.Extension -ne '.exe' -or (Get-FileHash -LiteralPath $item.FullName).Hash -ne $Hash) {
        throw "Installer type or SHA-256 mismatch: $File"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
    $thumb = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint }
    if ($SignerThumbprint -and ($signature.Status -ne 'Valid' -or $thumb -ne $SignerThumbprint)) {
        throw "Installer did not meet the required publisher signature: $File"
    }
    [pscustomobject]@{ path = $item.FullName; sha256 = $Hash; signature = [string]$signature.Status; signer = $thumb }
}

function Wait-Condition([scriptblock]$Predicate, [string]$Failure, [int]$Seconds = 45) {
    $until = [datetime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 250
    } while ([datetime]::UtcNow -lt $until)
    throw $Failure
}

function Invoke-Installer([string]$File) {
    $proc = Start-Process -FilePath $File -ArgumentList '/S' -WindowStyle Hidden -PassThru
    if (-not $proc.WaitForExit(180000) -or $proc.ExitCode -ne 0) { throw "Installer failed or timed out: $File" }
}

function Get-AppProcess {
    Get-Process -Name faibots -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
}

function Close-App {
    if (@(Get-AppProcess).Count -eq 0) { return }
    Wait-Condition { @(Get-AppProcess | Where-Object MainWindowHandle -ne 0).Count -gt 0 } 'Installed app did not present a window.'
    foreach ($proc in @(Get-AppProcess | Where-Object MainWindowHandle -ne 0)) {
        if (-not $proc.CloseMainWindow()) { throw 'Installed app refused normal window closure.' }
    }
    Wait-Condition { @(Get-AppProcess).Count -eq 0 } 'Installed processes remained after normal close.'
}

function Assert-Installed {
    $regs = @(Get-Registration)
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or $regs.Count -ne 1 -or $regs[0].Name -notlike 'HKEY_CURRENT_USER\*') {
        throw 'Expected one current-user installation and its executable.'
    }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($link in $shortcuts) {
        if (-not (Test-Path -LiteralPath $link -PathType Leaf) -or $shell.CreateShortcut($link).TargetPath -ne $exe) {
            throw "Installed shortcut is missing or points to the wrong executable: $link"
        }
    }
    (Get-FileHash -LiteralPath (Join-Path $program 'resources\app.asar')).Hash
}

# Use the installed renderer and its ordinary preload commands; no account, model or HTTP service is needed.
$probe = @'
const assert = require('node:assert/strict');
const {win32: path} = require('node:path');
const {fileURLToPath} = require('node:url');
const {setTimeout: pause} = require('node:timers/promises');
const [mode, port, program, data, name, botId, chatId] = process.argv.slice(2);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function appCheck(mode, name) {
  if (document.readyState === 'loading') await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  const api = window.faibots;
  const info = await api.invoke('app:info');
  if (mode === 'seed') {
    const bot = await api.invoke('bots:create', {name, model:{providerId:'',modelId:''}, notify:false});
    const chat = await api.invoke('conv:open-dm', {botId:bot.id});
    return {data:info.dataDir, version:info.version, bot:bot.id, chat:chat.id};
  }
  const bots = (await api.invoke('bots:list')).filter(b => b.name === name);
  if (bots.length !== 1) throw Error('Synthetic specialist was missing or duplicated.');
  const chat = await api.invoke('conv:open-dm', {botId:bots[0].id});
  return {data:info.dataDir, version:info.version, bot:bots[0].id, chat:chat.id};
}

(async () => {
  if (mode === 'retained') {
    const db = new (require('node:sqlite').DatabaseSync)(path.join(data, 'faibots.db'), {readOnly:true});
    assert.equal(db.prepare('pragma quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare('select name from bots where id=?').get(botId)?.name, name);
    const dm = db.prepare('select kind,bot_ids from conversations where id=?').get(chatId);
    assert.equal(dm?.kind, 'dm');
    assert.deepEqual(JSON.parse(dm.bot_ids), [botId]);
    db.close();
    return;
  }
  const origin = 'http://127.0.0.1:' + port;
  const pagePath = path.join(program,'resources','app.asar','out','renderer','index.html');
  let target;
  for (let i=0; i<80 && !target; i++) {
    const pages = await fetch(origin+'/json/list', {signal:AbortSignal.timeout(1000)}).then(r=>r.json()).catch(()=>[]);
    target = pages.find(p => p.type === 'page' && p.url.startsWith('file:') && same(fileURLToPath(p.url),pagePath));
    if (!target) await pause(250);
  }
  assert.ok(target, 'Expected the installed local renderer.');
  const addr = new URL(target.webSocketDebuggerUrl);
  assert.equal(addr.protocol, 'ws:'); assert.equal(addr.hostname,'127.0.0.1'); assert.equal(addr.port,port);
  const ws = new WebSocket(addr.href);
  const timer = setTimeout(() => { console.error('Installed renderer probe timed out.'); process.exit(1); }, 20000);
  try {
    await new Promise((ok, fail) => { ws.onopen=ok; ws.onerror=fail; });
    const response = new Promise((ok, fail) => {
      ws.onclose=()=>fail(Error('Installed renderer disconnected.'));
      ws.onmessage=e=>{const reply=JSON.parse(e.data); if(reply.id===1) ok(reply);};
    });
    ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
      expression:'('+appCheck.toString()+')('+JSON.stringify(mode)+','+JSON.stringify(name)+')',
      awaitPromise:true,returnByValue:true
    }}));
    const reply = await response;
    assert.ok(!reply.error && !reply.result.exceptionDetails,'Installed app command failed.');
    const value = reply.result.result.value;
    assert.ok(same(value.data,data)); assert.ok(value.bot && value.chat);
    if (mode !== 'seed') { assert.equal(value.bot,botId); assert.equal(value.chat,chatId); }
    console.log(JSON.stringify(value));
  } finally {clearTimeout(timer);ws.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
'@

function Invoke-InstalledApp([string]$Mode, [string]$BotId = '-', [string]$ChatId = '-') {
    Close-App
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $proc = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-address=127.0.0.1","--remote-debugging-port=$port" -WindowStyle Hidden -PassThru
    try {
        Wait-Condition {
            $binding = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
            $binding.Count -eq 1 -and $binding[0].LocalAddress -eq '127.0.0.1' -and $binding[0].OwningProcess -eq $proc.Id
        } 'The installed app did not open its own isolated loopback test port.'
        $result = $probe | & $node - $Mode $port $program $data $testName $BotId $ChatId
        if ($LASTEXITCODE -ne 0) { throw "Installed app check failed during $Mode." }
        $result | ConvertFrom-Json
    } finally { Close-App }
}

$previous = Get-Installer $PreviousInstaller $PreviousSha256
$current = Get-Installer $CurrentInstaller $CurrentSha256
foreach ($path in @($program, $data, (Join-Path $profileDir 'FaiBots')) + $shortcuts) {
    if (-not $path.StartsWith($profileDir.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $path)) {
        throw "Refused existing data/installation/shortcut, or a path outside the disposable profile: $path"
    }
    $ancestor = Split-Path -Parent $path
    while ($ancestor.Length -ge $profileDir.Length) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refused a redirected or linked disposable profile path: $ancestor"
        }
        $ancestor = Split-Path -Parent $ancestor
    }
}
if (@(Get-Registration).Count -or (Test-LoginEntry $runKey) -or (Test-LoginEntry $approvedKey) -or (Get-Process -Name faibots -ErrorAction SilentlyContinue)) {
    throw 'Refused a runner with an existing faibots process or Windows registration.'
}

$testName = 'Installer check ' + [Guid]::NewGuid().ToString('N').Substring(0,12)
Write-Host 'Installing and opening the previous build.'
Invoke-Installer $previous.path
$previousAsar = Assert-Installed
$seed = Invoke-InstalledApp 'seed'
$marker = Join-Path $data ($testName + '.txt')
[IO.File]::WriteAllText($marker, $testName)
$markerHash = (Get-FileHash -LiteralPath $marker).Hash

Write-Host 'Upgrading in place and reopening twice.'
Invoke-Installer $current.path
$currentAsar = Assert-Installed
if ($currentAsar -eq $previousAsar) { throw 'Upgrade did not replace the previous application archive.' }
$updated = Invoke-InstalledApp 'verify' $seed.bot $seed.chat
$null = Invoke-InstalledApp 'verify' $seed.bot $seed.chat
if ((Get-FileHash -LiteralPath $marker).Hash -ne $markerHash) { throw 'Upgrade changed synthetic user data.' }

Write-Host 'Uninstalling and checking retained data.'
$uninstall = @(Get-ChildItem -LiteralPath $program -Filter 'Uninstall*.exe' -File)
if ($uninstall.Count -ne 1) { throw 'Expected one uninstaller inside the validated install directory.' }
# Exercise the uninstall hook even when fresh installs default to login launch off.
if (-not (Test-Path -LiteralPath $runKey)) { $null = New-Item -Path $runKey -Force }
Set-ItemProperty -LiteralPath $runKey -Name $runValue -Value ('"' + $exe + '" --hidden')
Invoke-Installer $uninstall[0].FullName
Wait-Condition {
    -not (Test-Path -LiteralPath $program) -and @($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0 -and
        @(Get-Registration).Count -eq 0 -and -not (Test-LoginEntry $runKey) -and -not (Test-LoginEntry $approvedKey) -and @(Get-AppProcess).Count -eq 0
} 'Uninstall left the program, a process, shortcut or registration.' 120
if ((Get-FileHash -LiteralPath $marker).Hash -ne $markerHash) { throw 'Uninstall changed synthetic user data.' }
$probe | & $node - 'retained' 0 $program $data $testName $seed.bot $seed.chat
if ($LASTEXITCODE -ne 0) { throw 'Uninstall failed to preserve the synthetic database identities.' }
[ordered]@{
    result = 'passed'; windows = [Environment]::OSVersion.VersionString; runner = $account
    previous = $previous; current = $current; previousVersion = $seed.version; currentVersion = $updated.version
    previousAsarSha256 = $previousAsar; currentAsarSha256 = $currentAsar
    syntheticBotId = $seed.bot; syntheticDmId = $seed.chat; retainedMarkerSha256 = $markerHash
    upgradedReopens = 2; uninstallRemovedProgramAndRegistration = $true; retainedData = $true
} | ConvertTo-Json -Depth 4
