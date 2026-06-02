param(
  [string]$ProjectName = "aimark"
)

$ErrorActionPreference = "Stop"

Write-Output "AI Mark OAuth setup for Cloudflare Pages project: $ProjectName"
Write-Output ""
Write-Output "Use these callback URLs in the OAuth app dashboards:"
Write-Output "Google redirect URI: https://aimark.pages.dev/api/auth/callback/google"
Write-Output "GitHub callback URL: https://aimark.pages.dev/api/auth/callback/github"
Write-Output ""

function Read-PlainSecret($Name) {
  $secure = Read-Host "Paste $Name" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Put-PagesSecret($Name, $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Write-Output "Skipped $Name"
    return
  }
  Write-Output "Setting $Name..."
  $Value | npx.cmd wrangler pages secret put $Name --project-name $ProjectName
}

$googleClientId = Read-PlainSecret "GOOGLE_CLIENT_ID"
$googleClientSecret = Read-PlainSecret "GOOGLE_CLIENT_SECRET"
$githubClientId = Read-PlainSecret "GITHUB_CLIENT_ID"
$githubClientSecret = Read-PlainSecret "GITHUB_CLIENT_SECRET"

Put-PagesSecret "GOOGLE_CLIENT_ID" $googleClientId
Put-PagesSecret "GOOGLE_CLIENT_SECRET" $googleClientSecret
Put-PagesSecret "GITHUB_CLIENT_ID" $githubClientId
Put-PagesSecret "GITHUB_CLIENT_SECRET" $githubClientSecret

Write-Output ""
Write-Output "Done. Verify with:"
Write-Output "  npx wrangler pages secret list --project-name $ProjectName"
Write-Output "  Invoke-RestMethod https://aimark.pages.dev/api/auth/start/google?check=1"
Write-Output "  Invoke-RestMethod https://aimark.pages.dev/api/auth/start/github?check=1"
