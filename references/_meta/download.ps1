$ErrorActionPreference = "Continue"
$root   = "C:\Claude\perception\references"
$ffdir  = "C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
$items  = Get-Content "$root\_meta\manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($it in $items) {
  $out = Join-Path $root ("{0}_{1}.mp4" -f $it.idx, $it.slug)
  if (Test-Path $out) { Write-Output "SKIP  $($it.idx) already exists"; continue }
  Write-Output "GET   $($it.idx) $($it.id) $($it.slug)"
  python -m yt_dlp "https://www.youtube.com/watch?v=$($it.id)" `
    -f "bv*[height<=720]+ba/b[height<=720]/b" `
    --merge-output-format mp4 `
    --ffmpeg-location $ffdir `
    --no-playlist --no-warnings --quiet --no-progress `
    -o $out 2>&1 | Select-Object -Last 3
  if (Test-Path $out) {
    $len = & "$ffdir\ffprobe.exe" -v error -show_entries format=duration -of csv=p=0 $out
    Write-Output ("  OK  {0}s  {1:N1} MB" -f [math]::Round([double]$len,1), ((Get-Item $out).Length/1MB))
  } else { Write-Output "  FAIL $($it.idx)" }
}
