TOKEN=$(echo "protocol=https
host=github.com" | git credential-manager get 2>/dev/null | grep "^password=" | sed 's/^password=//')

BODY="## v1.0.0 — Initial Release Candidate

### Highlights
- Explorer-style directory and file explanation starting at C:\\\\
- AI-powered review with automatic model discovery (OpenAI-compatible)
- Disk-change baselines with partial-coverage reporting
- Fifteen safe cleanup rules across five risk levels
- Read-only system slimming detection (hibernation, WinSxS, Windows.old)
- Application attribution for browsers, chat tools, gaming platforms

### Safety
- Recycle-bin-only deletion, no permanent deletion exposed
- Symbolic links and root escapes never followed
- Pre-execution recheck of file identity, age, and process state
- Unknown and personal content never auto-candidate

### Download
- **Portable**: Disk-Sense-Portable-x64.exe (no install required)
- **Setup**: Disk-Sense-Setup-x64.exe (installer)

See [CHANGELOG.md](https://github.com/IC-sd/disk-sense/blob/main/CHANGELOG.md) for full details."

BODY_JSON=$(echo "$BODY" | python -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")

curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/IC-sd/disk-sense/releases" \
  -d "{\"tag_name\":\"v1.0.0\",\"name\":\"Disk Sense v1.0.0\",\"body\":$BODY_JSON,\"draft\":false,\"prerelease\":true}"
