# Freshdesk Ops Intelligence MCP

> Production-safe Freshdesk MCP for Claude, Cursor, and any MCP-compatible AI assistant.
> Native SLA breach detection · Dry-run writes · Multi-channel analytics · Canned response authoring

[![MCPize](https://mcpize.com/badge/@rkbzddev/freshdesk-ops-intelligence-mcp)](https://mcpize.com/mcp/freshdesk-ops-intelligence-mcp)
[![MCPize](https://img.shields.io/badge/MCPize-Marketplace-blue)](https://mcpize.com/mcp/freshdesk-ops-intelligence-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---
## Connect via MCPize

Use this MCP server instantly with no local installation:

```bash
npx -y mcpize connect @rkbzddev/freshdesk-ops-intelligence-mcp --client claude
```

Or connect at: **https://mcpize.com/mcp/freshdesk-ops-intelligence-mcp**
---

## Why this server exists

Freshdesk serves 60,000+ businesses across every plan tier. What makes it different from other helpdesks is native SLA policy enforcement with real breach flags built into every ticket. Most Freshdesk MCPs ignore this entirely and fall back to heuristic "hasn't been updated recently" guesses.

This server reads Freshdesk's actual SLA breach signals — `fr_escalated` (first response) and `is_escalated` (resolution) — and builds an entire ops intelligence layer on top.

**Four things it solves:**

| Problem | What this server does |
|---------|-----------------------|
| No real SLA data in AI context | Native breach flags on every ticket — no guessing |
| Write access without guardrails | Every write defaults to dry-run + `confirm: true` gate |
| Manual canned response management | Plain text → formatted canned response → dry-run → create |
| Weekly ops requires Freshdesk Analytics | One-command digest: volume, channels, SLA health, CSAT |

---

## Tools (14 total)

### Connection
| Tool | Description |
|------|-------------|
| `freshdesk_whoami` | Verify auth, agent role, ticket scope, available groups |

### Tickets
| Tool | Description |
|------|-------------|
| `search_tickets` | Search by keyword, status, priority, group, tag — results include SLA breach flags |
| `get_ticket` | Full ticket with native SLA dates, breach status, and conversations |
| `preview_ticket_update` | **Dry-run** diff of proposed changes — nothing applied |
| `execute_ticket_update` | Apply changes (requires `confirm: true`) |
| `add_private_note` | Internal note, not visible to customer (dry-run default) |

### Contacts
| Tool | Description |
|------|-------------|
| `get_contact` | Full profile: channels, company, custom fields |
| `search_contacts` | Find contacts by name or email |

### SLA
| Tool | Description |
|------|-------------|
| `list_sla_breaches` | Tickets with active SLA breaches using Freshdesk's native `fr_escalated` / `is_escalated` flags |
| `explain_ticket_sla` | Full SLA story: FRT target, resolution target, actual reply time, breach status, risk verdict |

### Reporting
| Tool | Description |
|------|-------------|
| `weekly_support_summary` | Volume, queue depth, priority breakdown, channels, top tags, SLA breach counts, CSAT |

### Canned Responses
| Tool | Description |
|------|-------------|
| `create_canned_response` | Plain text → formatted response → dry-run preview → create |
| `list_canned_responses` | Browse response library across all folders |
| `get_canned_response` | Fetch full content (plain text and HTML) |

---

## Quick Start

### 1. Get your Freshdesk API key

In Freshdesk: click your **profile avatar → Profile Settings → API Key** (bottom right of the page).

Your subdomain is the part before `.freshdesk.com`.

### 2. Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "freshdesk-ops": {
      "command": "npx",
      "args": ["-y", "freshdesk-ops-intelligence-mcp"],
      "env": {
        "FRESHDESK_DOMAIN": "your-subdomain",
        "FRESHDESK_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. Run `freshdesk_whoami` to confirm the connection.

### 3. Or use via MCPize

Subscribe at [mcpize.com/mcp/freshdesk-ops-intelligence-mcp](https://mcpize.com/mcp/freshdesk-ops-intelligence-mcp).

---

## Example Conversations

**SLA triage:**
```
"Show me all tickets with breached SLAs right now"
→ list_sla_breaches breach_type:both

"Give me the full SLA breakdown on ticket 44321"
→ explain_ticket_sla ticket_id:44321
```

**Safe ticket update:**
```
"Preview changing ticket 44321 to high priority and adding tag escalated"
→ preview_ticket_update ticket_id:44321 changes:{priority:"high", tags_add:["escalated"]}

"Apply it"
→ execute_ticket_update ticket_id:44321 changes:{...} confirm:true
```

**Canned response authoring:**
```
"Create a canned response called 'Refund Processing' with content:
 'Your refund has been approved and will be processed within 5–7 business days.'"
→ create_canned_response title:"Refund Processing" content:"..." dry_run:true
→ [review]
→ create_canned_response ... dry_run:false
```

**Monday report:**
```
"Give me the weekly summary for the week starting 2025-01-13"
→ weekly_support_summary week_start:2025-01-13
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FRESHDESK_DOMAIN` | ✅ | Subdomain only — e.g. `acme` for `acme.freshdesk.com` |
| `FRESHDESK_API_KEY` | ✅ | API key from Profile Settings |

---

## The SLA Advantage

Freshdesk is the only major helpdesk that exposes real-time SLA breach flags directly on the ticket object. This means:

- `list_sla_breaches` returns **policy-accurate** breach data — not "hasn't been updated in 24h" heuristics
- `explain_ticket_sla` shows the exact due dates from your SLA policy, not estimates
- `weekly_support_summary` reports **actual breach counts** from the live queue

This is a genuine technical advantage over Zendesk and Gorgias MCPs that rely on search-based heuristics.

---

## Safety Model

- **All writes default to dry-run** — `preview_ticket_update`, `add_private_note`, `create_canned_response`
- **Explicit confirm gate** — `execute_ticket_update` blocks without `confirm: true`
- **Rate limit handling** — 429 responses backed off automatically per plan limits
- **Structured auth errors** — clear messages for 401/403 with remediation steps

---

## Local Development

```bash
git clone https://github.com/rakib78/freshdesk-ops-intelligence-mcp
cd freshdesk-ops-intelligence-mcp
npm install

export FRESHDESK_DOMAIN=your-subdomain
export FRESHDESK_API_KEY=your_key

npm run dev
```

Build:
```bash
npm run build && npm start
```

Test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## License

MIT — Built by [Md Rakibul Islam](https://mdrakibulislam.com)

Zendesk Top Admin · Freshdesk Specialist · Upwork Top Rated Plus · 21,000+ hours · 50+ CRM & support platform implementations.