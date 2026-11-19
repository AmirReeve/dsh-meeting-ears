# Fetch the SenseVoice assets through HF-Mirror with resume and retries, then
# place them where the speech provider expects them. Safe to run repeatedly.
$ErrorActionPreference = 'Continue'

$mirrorModel = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07'
$mirrorVad = 'https://hf-mirror.com/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc'

$tmp = Join-Path $env:TEMP 'meeting-ears-model'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$assets = @(
  @{ url = "$mirrorModel/model.int8.onnx"; name = 'model.int8.onnx'; size = 239233841
     sha = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  @{ url = "$mirrorModel/tokens.txt"; name = 'tokens.txt'; size = 315894
     sha = 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  @{ url = "$mirrorVad/silero_vad.onnx"; name = 'silero_vad.onnx'; size = 1807522
     sha = 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' }
)

foreach ($asset in $assets) {
  $file = Join-Path $tmp $asset.name
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    $have = if (Test-Path $file) { (Get-Item $file).Length } else { 0 }
    if ($have -eq $asset.size) { break }
    Write-Output ("[{0}] {1} attempt {2} have {3}/{4}" -f (Get-Date -Format HH:mm:ss), $asset.name, $attempt, $have, $asset.size)
    & curl.exe -L --fail --max-time 2400 -C - -o $file $asset.url
    Start-Sleep -Seconds 15
  }
  if (-not (Test-Path $file)) { Write-Output "MISSING $($asset.name)"; continue }
  $size = (Get-Item $file).Length
  $sha = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  Write-Output ("{0} size={1} sha={2} ok={3}" -f $asset.name, $size, $sha, ($size -eq $asset.size -and $sha -eq $asset.sha))
  if ($size -ne $asset.size -or $sha -ne $asset.sha) { continue }
  $root = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice'
  $targetDir = if ($asset.name -eq 'silero_vad.onnx') {
    Join-Path $root 'models\silero'
  } else {
    Join-Path $root 'models\sensevoice-onnx'
  }
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item -LiteralPath $file -Destination (Join-Path $targetDir $asset.name) -Force
  Write-Output ("placed -> {0}" -f (Join-Path $targetDir $asset.name))
}
Write-Output 'FETCH-DONE'
