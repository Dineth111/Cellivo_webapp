$ErrorActionPreference = 'Continue'
$root = 'D:\raxwo\Celevo\Cellivo_webapp\.cellivo-ref\raw'
New-Item -ItemType Directory -Force $root | Out-Null
$urls = [regex]::Matches((Get-Content "$env:TEMP\cellivo-ref\sitemap.xml" -Raw), '<loc>([^<]+)</loc>') | ForEach-Object { $_.Groups[1].Value }
$assets = New-Object System.Collections.Generic.HashSet[string]
foreach ($u in $urls) {
  $slug = ($u -replace 'https://cellivo.com/?', ''); if (-not $slug) { $slug = 'home' }
  $out = Join-Path $root ("pages\" + ($slug -replace '/', '__') + '.html')
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  Invoke-WebRequest -UseBasicParsing $u -OutFile $out
  $txt = [System.IO.File]::ReadAllText($out)
  foreach ($m in [regex]::Matches($txt, '(?:src|href)="(/(?:assets|uploads)/[^"?]+)')) { [void]$assets.Add($m.Groups[1].Value) }
  foreach ($m in [regex]::Matches($txt, 'srcSet="([^"]+)"')) { foreach ($p in $m.Groups[1].Value.Split(',')) { $q = $p.Trim().Split(' ')[0]; if ($q.StartsWith('/')) { [void]$assets.Add($q.Split('?')[0]) } } }
}
foreach ($a in @($assets)) {
  if ($a -like '*.css') { $css = Join-Path $root $a.TrimStart('/'); New-Item -ItemType Directory -Force (Split-Path $css) | Out-Null; Invoke-WebRequest -UseBasicParsing "https://cellivo.com$a" -OutFile $css
    foreach ($m in [regex]::Matches([System.IO.File]::ReadAllText($css), 'url\((/[^)]+)\)')) { [void]$assets.Add($m.Groups[1].Value.Trim('"', "'")) } }
}
foreach ($a in $assets) {
  $f = Join-Path $root ($a.TrimStart('/') -replace '/', '\')
  if (Test-Path $f) { continue }
  New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null
  try { Invoke-WebRequest -UseBasicParsing "https://cellivo.com$a" -OutFile $f } catch { "FAIL $a" }
}
"assets: $($assets.Count)"
Get-ChildItem $root -Recurse -File | Measure-Object Length -Sum | ForEach-Object { "files $($_.Count) bytes $($_.Sum)" }
