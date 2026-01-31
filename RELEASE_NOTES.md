# Release Notes Template

Use this template for GitHub Release descriptions.

---

## v0.1.2-alpha

### What's in the Box

- Bloom Constraint Kernel v0.1.2-alpha
- Provider-agnostic constraint runtime for AI agents
- Base Sepolia USDC environment support
- MCP server for Claude Desktop integration (read/propose only)

### Quickstart

```bash
# Prerequisites: Docker Desktop

git clone https://github.com/howwee20/BloomAI.git
cd BloomAI
cp .env.example .env
docker compose up -d --build

# Verify healthy (wait ~30s for first build)
curl http://localhost:3000/healthz

# Expected output includes:
# {"api_version":"<contract>","db_connected":true,"migrations_applied":true,...}
```

### What "Healthy" Means

The `/healthz` endpoint returns:
- `api_version`: Kernel contract version
- `db_connected`: true when SQLite is accessible
- `migrations_applied`: true when schema is up to date
- `card_mode`: dev | shadow | enforce
- `env_type`: simple_economy | base_usdc
- `git_sha`: Build commit (if available)

### Known Limitations

- Step-up approval requires localhost access (out-of-band human verification)
- MCP server is read/propose only by design (no execute capability)
- Base USDC mode requires funded wallet on Base Sepolia
- Worker reconciliation requires RPC access to Base network

### Security Notes

- **Step-up is out-of-band**: USDC transfers require human approval via localhost UI
- **MCP is read/propose only**: Claude Desktop cannot execute transactions
- **Key separation enforced**: MCP server fails closed if keys have overpermissive scopes
- **Admin key required**: Protect your `ADMIN_API_KEY` - it can mint API keys

### Shutting Down

```bash
docker compose down           # Stop containers
docker compose down --volumes # Stop and wipe all data
```

---

## GitHub Release Body (copy/paste)

```markdown
## What's in the Box

- Bloom Constraint Kernel v0.1.2-alpha
- Provider-agnostic constraint runtime for AI agents
- Base Sepolia USDC environment support
- MCP server for Claude Desktop integration (read/propose only)

## Quickstart

\`\`\`bash
git clone https://github.com/howwee20/BloomAI.git && cd BloomAI
cp .env.example .env
docker compose up -d --build
curl http://localhost:3000/healthz
\`\`\`

## Known Limitations

- Step-up approval requires localhost access (out-of-band human verification)
- MCP server is read/propose only by design (no execute capability)

## Security Notes

- Step-up is out-of-band: USDC transfers require human approval
- MCP is read/propose only: Claude Desktop cannot execute transactions
- Key separation enforced: MCP fails closed on overpermissive keys

## Full Documentation

See README.md for complete API reference and configuration options.
```
