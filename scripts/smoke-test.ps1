# WebDAV 煙霧測試：對本地或遠端的 Worker 跑完整同步流程
# 用法：powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1 [-BaseUrl http://localhost:8787]
[CmdletBinding()]
param(
  [string]$BaseUrl = "http://localhost:8787",
  [string]$User = "testuser",
  [string]$Pass = "testpass"
)

$ErrorActionPreference = "Stop"
$script:Failed = 0

# PS 5.1 預設 TLS 版本過舊，連 https 前強制 TLS 1.2
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$authHeader = "Basic " + [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes("${User}:${Pass}")
)

# Invoke-WebRequest (PS 5.1) 不支援 MKCOL/PROPFIND 等自訂方法，改用 HttpWebRequest
function Invoke-Dav {
  param(
    [string]$Method,
    [string]$Path,
    [string]$Body,
    [hashtable]$ExtraHeaders = @{},
    [switch]$NoAuth
  )
  $request = [System.Net.HttpWebRequest]::Create("$BaseUrl$Path")
  $request.Method = $Method
  if (-not $NoAuth) { $request.Headers["Authorization"] = $authHeader }
  foreach ($key in $ExtraHeaders.Keys) { $request.Headers[$key] = $ExtraHeaders[$key] }
  if (-not [string]::IsNullOrEmpty($Body)) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $request.ContentType = "text/markdown; charset=utf-8"
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
  }

  $response = $null
  try {
    $response = $request.GetResponse()
  } catch [System.Net.WebException] {
    $response = $_.Exception.Response
    if ($null -eq $response) { throw }
  }

  $content = ""
  $stream = $response.GetResponseStream()
  if ($null -ne $stream) {
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    $content = $reader.ReadToEnd()
    $reader.Close()
  }
  $headerTable = @{}
  foreach ($key in $response.Headers.AllKeys) { $headerTable[$key] = $response.Headers[$key] }
  $statusCode = [int]$response.StatusCode
  $response.Close()
  return @{ StatusCode = $statusCode; Content = $content; Headers = $headerTable }
}

function Test-Step {
  param([string]$Name, [scriptblock]$Check)
  try {
    $result = & $Check
    if ($result) {
      Write-Host "[PASS] $Name" -ForegroundColor Green
    } else {
      Write-Host "[FAIL] $Name" -ForegroundColor Red
      $script:Failed++
    }
  } catch {
    Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
    $script:Failed++
  }
}

Write-Host "== WebDAV smoke test against $BaseUrl ==" -ForegroundColor Cyan

Test-Step "未帶憑證應回 401" {
  (Invoke-Dav -Method GET -Path "/x.md" -NoAuth).StatusCode -eq 401
}

Test-Step "錯誤密碼應回 401" {
  $bad = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${User}:wrong"))
  $request = [System.Net.HttpWebRequest]::Create("$BaseUrl/x.md")
  $request.Method = "GET"
  $request.Headers["Authorization"] = $bad
  try {
    $response = $request.GetResponse(); $code = [int]$response.StatusCode; $response.Close()
  } catch [System.Net.WebException] {
    $code = [int]$_.Exception.Response.StatusCode
  }
  $code -eq 401
}

$testPath = "/smoke-test/測試筆記.md"
$testContent = "# 煙霧測試" + [char]10 + "中文內容與 & < > 特殊字元"

Test-Step "MKCOL 建立目錄（201）" {
  (Invoke-Dav -Method MKCOL -Path "/smoke-test/").StatusCode -eq 201
}

Test-Step "PUT 上傳含中文檔名的筆記（201）" {
  (Invoke-Dav -Method PUT -Path $testPath -Body $testContent).StatusCode -eq 201
}

Test-Step "GET 取回的內容與上傳一致" {
  $res = Invoke-Dav -Method GET -Path $testPath
  $res.Content -eq $testContent
}

Test-Step "HEAD 回傳 ETag 與 Content-Length" {
  $res = Invoke-Dav -Method HEAD -Path $testPath
  ($null -ne $res.Headers["ETag"]) -and ([int]$res.Headers["Content-Length"] -gt 0)
}

Test-Step "PROPFIND depth:1 根目錄列出 smoke-test 目錄" {
  $res = Invoke-Dav -Method PROPFIND -Path "/" -ExtraHeaders @{ Depth = "1" }
  ($res.StatusCode -eq 207) -and ($res.Content.Contains("smoke-test"))
}

Test-Step "PROPFIND depth:1 目錄內含檔案大小資訊" {
  $res = Invoke-Dav -Method PROPFIND -Path "/smoke-test/" -ExtraHeaders @{ Depth = "1" }
  ($res.StatusCode -eq 207) -and ($res.Content.Contains("getcontentlength"))
}

Test-Step "PROPFIND depth:infinity 應回 403" {
  (Invoke-Dav -Method PROPFIND -Path "/" -ExtraHeaders @{ Depth = "infinity" }).StatusCode -eq 403
}

Test-Step "MOVE 重新命名檔案（201）" {
  $res = Invoke-Dav -Method MOVE -Path $testPath -ExtraHeaders @{ Destination = "$BaseUrl/smoke-test/renamed.md" }
  $res.StatusCode -eq 201
}

Test-Step "MOVE 後原路徑 404、新路徑存在" {
  $old = Invoke-Dav -Method GET -Path $testPath
  $new = Invoke-Dav -Method GET -Path "/smoke-test/renamed.md"
  ($old.StatusCode -eq 404) -and ($new.StatusCode -eq 200)
}

Test-Step "COPY 複製檔案（201）" {
  $res = Invoke-Dav -Method COPY -Path "/smoke-test/renamed.md" -ExtraHeaders @{ Destination = "$BaseUrl/smoke-test/copy.md" }
  $res.StatusCode -eq 201
}

Test-Step "COPY + Overwrite:F 已存在應回 412" {
  $res = Invoke-Dav -Method COPY -Path "/smoke-test/renamed.md" -ExtraHeaders @{ Destination = "$BaseUrl/smoke-test/copy.md"; Overwrite = "F" }
  $res.StatusCode -eq 412
}

Test-Step "DELETE 刪除檔案（204）" {
  (Invoke-Dav -Method DELETE -Path "/smoke-test/copy.md").StatusCode -eq 204
}

Test-Step "超過 D1 單檔上限（約 1.9MB）應回 413" {
  $bigBody = "x" * 2000000
  (Invoke-Dav -Method PUT -Path "/smoke-test/big.bin" -Body $bigBody).StatusCode -eq 413
}
Test-Step "DELETE 整個目錄（204）" {
  (Invoke-Dav -Method DELETE -Path "/smoke-test/").StatusCode -eq 204
}

Test-Step "清空後 PROPFIND 目錄應 404" {
  (Invoke-Dav -Method PROPFIND -Path "/smoke-test/" -ExtraHeaders @{ Depth = "1" }).StatusCode -eq 404
}

# 註：.NET Uri 與 Worker 的 WHATWG URL parser 都會先把 %2e%2e 正規化掉，
# 因此穿越嘗試最終只會落在 bucket 內的無效路徑（404），不可能讀到上層。
Test-Step "路徑穿越會被正規化（最終 404，無法越權讀取）" {
  (Invoke-Dav -Method GET -Path "/%2e%2e/secret.txt").StatusCode -eq 404
}

if ($script:Failed -eq 0) {
  Write-Host ""
  Write-Host "ALL TESTS PASSED" -ForegroundColor Green
  exit 0
} else {
  Write-Host ""
  Write-Host "$($script:Failed) TEST(S) FAILED" -ForegroundColor Red
  exit 1
}