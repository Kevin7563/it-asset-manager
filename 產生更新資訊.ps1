# =====================================================================
# 🔄 IT 資產管理系統｜版本更新：一鍵產生 latest.json
#    用法：
#      1. 先執行  npm version 新版本號 --no-git-tag-version
#      2. 再執行  npm run build
#      3. 最後執行本腳本：
#         .\產生更新資訊.ps1 -Notes "1. 修正xxx`n2. 新增yyy"
#    結果：
#      dist\latest.json                       ← 上傳到更新伺服器
#      dist\ITAssetManager_Setup_v<版本>.exe   ← 上傳到更新伺服器（英文檔名）
# =====================================================================
param(
    [string]$Notes = "本次更新內容（請自行修改）",
    [string]$FileName = ""
)

$ver = (Get-Content .\package.json -Raw | ConvertFrom-Json).version
$exe = Get-ChildItem .\dist -Filter "*_v$ver.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
    Write-Host "❌ 在 dist 內找不到 *_v$ver.exe，請先確認版本號並執行 npm run build" -ForegroundColor Red
    exit 1
}
if ([string]::IsNullOrWhiteSpace($FileName)) { $FileName = "ITAssetManager_Setup_v$ver.exe" }

$obj = [ordered]@{
    version     = $ver
    releaseDate = (Get-Date -Format 'yyyy-MM-dd')
    notes       = $Notes
    downloadUrl = $FileName      # 與 latest.json 放同一資料夾時，只寫檔名即可
    fileName    = $FileName
    sha256      = (Get-FileHash -Algorithm SHA256 $exe.FullName).Hash.ToLower()
    size        = $exe.Length
    homepage    = ''
    mandatory   = $false
}
$json = $obj | ConvertTo-Json -Depth 5

# 以 UTF-8（無 BOM）寫檔，中文不會亂碼
$out = Join-Path $exe.DirectoryName 'latest.json'
[System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))

# 複製一份英文檔名的安裝檔，方便直接上傳
$upload = Join-Path $exe.DirectoryName $FileName
if ($exe.Name -ne $FileName) { Copy-Item $exe.FullName $upload -Force }

Write-Host ""
Write-Host "✅ 版本資訊檔：$out" -ForegroundColor Green
Write-Host "✅ 上傳用安裝檔：$upload" -ForegroundColor Green
Write-Host "把上面兩個檔案一起上傳到你的網路空間即可。" -ForegroundColor Cyan
Write-Host ""
Get-Content $out
