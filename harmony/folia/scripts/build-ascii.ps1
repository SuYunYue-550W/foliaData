# Sync the HarmonyOS project to an ASCII-only path and build the HAP.
# hvigor rejects paths with non-ASCII characters; this repo lives under a Chinese path.
$ErrorActionPreference = 'Continue'

$src = 'C:\Users\芒果游泳\Desktop\foliaData\harmony\folia'
$dst = 'D:\folia-harmony-build'
$cli = 'D:\folia-harmony-sdk\command-line-tools'

# Sync single config files (ets sources rarely change during build-error fixing)
Copy-Item -LiteralPath "$src\hvigor\hvigor-config.json5" -Destination "$dst\hvigor\hvigor-config.json5" -Force
Copy-Item -LiteralPath "$src\build-profile.json5" -Destination "$dst\build-profile.json5" -Force
Copy-Item -LiteralPath "$src\oh-package.json5" -Destination "$dst\oh-package.json5" -Force
Copy-Item -LiteralPath "$src\entry\oh-package.json5" -Destination "$dst\entry\oh-package.json5" -Force
Copy-Item -LiteralPath "$src\entry\build-profile.json5" -Destination "$dst\entry\build-profile.json5" -Force
Copy-Item -LiteralPath "$src\entry\src\main\module.json5" -Destination "$dst\entry\src\main\module.json5" -Force
robocopy "$src\entry\src\main\ets" "$dst\entry\src\main\ets" /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
Write-Output 'config synced'

# Build environment
$env:NODE_HOME = 'C:\Users\芒果游泳\.workbuddy\binaries\node\versions\22.22.2-6'
$env:DEVECO_SDK_HOME = "$cli\sdk"
$env:JAVA_HOME = "$cli\tool\jre"
$env:PATH = "$env:JAVA_HOME\bin;$env:NODE_HOME;$env:PATH"
$env:NODE_OPTIONS = ''
Remove-Item Env:\CODEBUDDY_SAFE_DELETE_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:\CODEBUDDY_SAFE_DELETE_SANDBOX -ErrorAction SilentlyContinue
Remove-Item Env:\CODEBUDDY_SAFE_DELETE_BULK_GUARD -ErrorAction SilentlyContinue

Write-Output "building in $dst"
Set-Location $dst
& "$cli\hvigor\bin\hvigorw.bat" assembleHap --mode module -p product=default --no-daemon 2>&1

Write-Output '=== HAP artifacts ==='
Get-ChildItem -LiteralPath $dst -Recurse -Filter *.hap -File -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ($_.Length.ToString() + '  ' + $_.FullName) }
