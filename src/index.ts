#!/usr/bin/env node

/**
 * Freshdesk Ops Intelligence MCP Server
 *
 * Production-safe Freshdesk MCP with:
 *  - Native SLA breach detection (fr_escalated, is_escalated flags)
 *  - Dry-run ticket writes with explicit confirm gate
 *  - Multi-channel analytics and weekly ops digest
 *  - Canned response authoring from plain text
 *  - Contact intelligence with company context
 *
 * Required env:
 *   FRESHDESK_DOMAIN    — subdomain (e.g. "mycompany" for mycompany.freshdesk.com)
 *   FRESHDESK_API_KEY   — API key from Freshdesk Profile Settings
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { clientFromEnv, FreshdeskApiError } from "./freshdesk-client.js";

import { freshdeskWhoami } from "./tools/auth.js";
import {
  searchTickets,
  getTicket,
  previewTicketUpdate,
  executeTicketUpdate,
  addPrivateNote,
} from "./tools/tickets.js";
import { getContact, searchContacts } from "./tools/contacts.js";
import { listSlaBreaches, explainTicketSla } from "./tools/sla.js";
import {
  listCannedResponses,
  getCannedResponse,
  createCannedResponse,
} from "./tools/canned-responses.js";
import { weeklySupportSummary } from "./tools/reporting.js";

// ─── Input Schemas ────────────────────────────────────────────────────────────

const TicketChangesSchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  tags_add: z.array(z.string()).optional(),
  tags_remove: z.array(z.string()).optional(),
  responder_id: z.number().optional(),
  group_id: z.number().optional(),
  type: z.string().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const Schemas = {
  freshdesk_whoami: z.object({}),

  search_tickets: z.object({
    query: z.string().optional().describe("Full-text keyword search"),
    status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    group_id: z.number().optional().describe("Filter by group ID"),
    responder_id: z.number().optional().describe("Filter by assignee agent ID"),
    type: z.string().optional().describe("Ticket type filter"),
    tag: z.string().optional().describe("Filter by tag (exact match)"),
    page: z.number().optional().describe("Page number (default 1)"),
    per_page: z.number().optional().describe("Results per page (default 25, max 100)"),
  }),

  get_ticket: z.object({
    ticket_id: z.number().describe("Freshdesk ticket ID"),
    include_conversations: z.boolean().optional().describe("Include last conversations (default true)"),
  }),

  preview_ticket_update: z.object({
    ticket_id: z.number().describe("Freshdesk ticket ID"),
    changes: TicketChangesSchema.describe("Changes to preview — NOT applied"),
  }),

  execute_ticket_update: z.object({
    ticket_id: z.number().describe("Freshdesk ticket ID"),
    changes: TicketChangesSchema.describe("Changes to apply"),
    confirm: z.boolean().describe("Must be true to apply. Run preview_ticket_update first."),
  }),

  add_private_note: z.object({
    ticket_id: z.number().describe("Freshdesk ticket ID"),
    body: z.string().describe("Note content (HTML supported)"),
    notify_agent_ids: z.array(z.number()).optional().describe("Agent IDs to notify"),
    dry_run: z.boolean().optional().describe("Preview without posting (default: true)"),
  }),

  get_contact: z.object({
    contact_id: z.number().optional().describe("Freshdesk contact ID"),
    email: z.string().optional().describe("Contact email address"),
  }),

  search_contacts: z.object({
    query: z.string().describe("Name or email to search"),
    limit: z.number().optional().describe("Max results (default 10)"),
  }),

  list_sla_breaches: z.object({
    breach_type: z.enum(["first_response", "resolution", "both"]).optional()
      .describe("Which SLA to check (default: both)"),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    group_id: z.number().optional().describe("Filter by group ID"),
    limit: z.number().optional().describe("Max tickets (default 25)"),
  }),

  explain_ticket_sla: z.object({
    ticket_id: z.number().describe("Freshdesk ticket ID"),
  }),

  weekly_support_summary: z.object({
    week_start: z.string().optional().describe("ISO date YYYY-MM-DD for week start (default: current Monday)"),
  }),

  create_canned_response: z.object({
    title: z.string().describe("Canned response title"),
    content: z.string().describe("Response content (plain text — auto-converted to HTML)"),
    folder_id: z.number().optional().describe("Folder ID (use list_canned_responses to find IDs)"),
    visibility: z.enum(["personal", "all"]).optional().describe("Who can use this (default: all)"),
    dry_run: z.boolean().optional().describe("Preview without creating (default: TRUE)"),
  }),

  list_canned_responses: z.object({
    query: z.string().optional().describe("Filter by title keyword"),
  }),

  get_canned_response: z.object({
    canned_response_id: z.number().describe("Canned response ID"),
  }),
};

// ─── Tool Definitions ─────────────────────────────────────────────────────────

// Typed as any[] — MCP SDK inputSchema property type causes strict TS conflicts
const TOOLS: any[] = [
  {
    name: "freshdesk_whoami",
    description: "Verify Freshdesk connection, auth, agent role, ticket scope, and available groups. Run this first.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_tickets",
    description: "Search Freshdesk tickets by keyword, status, priority, channel, group, or tag. Returns paginated results with SLA breach flags.",
    inputSchema: toJsonSchema(Schemas.search_tickets),
  },
  {
    name: "get_ticket",
    description: "Get full ticket detail: status, priority, source, SLA breach status (native Freshdesk flags), due dates, and last conversations.",
    inputSchema: toJsonSchema(Schemas.get_ticket),
  },
  {
    name: "preview_ticket_update",
    description: "DRY-RUN: Show exact diff of proposed changes (status, priority, tags, assignee, custom fields) WITHOUT applying them.",
    inputSchema: toJsonSchema(Schemas.preview_ticket_update),
  },
  {
    name: "execute_ticket_update",
    description: "Apply changes to a Freshdesk ticket. Requires confirm:true. Always run preview_ticket_update first.",
    inputSchema: toJsonSchema(Schemas.execute_ticket_update),
  },
  {
    name: "add_private_note",
    description: "Add a private internal note to a ticket (not visible to customer). Dry-run by default.",
    inputSchema: toJsonSchema(Schemas.add_private_note),
  },
  {
    name: "get_contact",
    description: "Get full contact profile including channels, company, and custom fields. Lookup by ID or email.",
    inputSchema: toJsonSchema(Schemas.get_contact),
  },
  {
    name: "search_contacts",
    description: "Search contacts by name or email.",
    inputSchema: toJsonSchema(Schemas.search_contacts),
  },
  {
    name: "list_sla_breaches",
    description: "Find tickets with active SLA breaches using Freshdesk's native policy flags (fr_escalated, is_escalated). Filter by breach type, priority, or group.",
    inputSchema: toJsonSchema(Schemas.list_sla_breaches),
  },
  {
    name: "explain_ticket_sla",
    description: "Full SLA story for a single ticket: FRT and resolution due dates, breach status, actual first reply time, conversation count, and plain-language risk verdict.",
    inputSchema: toJsonSchema(Schemas.explain_ticket_sla),
  },
  {
    name: "weekly_support_summary",
    description: "Monday ops digest: ticket volume, open/pending queue, priority breakdown, channel distribution, top tags, native SLA breach counts, and CSAT.",
    inputSchema: toJsonSchema(Schemas.weekly_support_summary),
  },
  {
    name: "create_canned_response",
    description: "Create a Freshdesk canned response from plain text. Dry-run TRUE by default — preview before creating.",
    inputSchema: toJsonSchema(Schemas.create_canned_response),
  },
  {
    name: "list_canned_responses",
    description: "Browse canned responses across all folders, optionally filtered by title keyword.",
    inputSchema: toJsonSchema(Schemas.list_canned_responses),
  },
  {
    name: "get_canned_response",
    description: "Fetch full canned response content (plain text and HTML) for review or editing.",
    inputSchema: toJsonSchema(Schemas.get_canned_response),
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "freshdesk-ops-intelligence-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const client = clientFromEnv();
    let result: string;

    switch (name) {
      case "freshdesk_whoami":
        result = await freshdeskWhoami(client); break;

      case "search_tickets":
        result = await searchTickets(client, Schemas.search_tickets.parse(args)); break;

      case "get_ticket": {
        const p = Schemas.get_ticket.parse(args);
        result = await getTicket(client, p); break;
      }

      case "preview_ticket_update": {
        const p = Schemas.preview_ticket_update.parse(args);
        result = await previewTicketUpdate(client, { ticket_id: p.ticket_id, changes: p.changes }); break;
      }

      case "execute_ticket_update": {
        const p = Schemas.execute_ticket_update.parse(args);
        result = await executeTicketUpdate(client, { ticket_id: p.ticket_id, changes: p.changes, confirm: p.confirm }); break;
      }

      case "add_private_note": {
        const p = Schemas.add_private_note.parse(args);
        result = await addPrivateNote(client, { ...p, dry_run: p.dry_run ?? true }); break;
      }

      case "get_contact":
        result = await getContact(client, Schemas.get_contact.parse(args)); break;

      case "search_contacts":
        result = await searchContacts(client, Schemas.search_contacts.parse(args)); break;

      case "list_sla_breaches":
        result = await listSlaBreaches(client, Schemas.list_sla_breaches.parse(args)); break;

      case "explain_ticket_sla":
        result = await explainTicketSla(client, Schemas.explain_ticket_sla.parse(args)); break;

      case "weekly_support_summary":
        result = await weeklySupportSummary(client, Schemas.weekly_support_summary.parse(args)); break;

      case "create_canned_response": {
        const p = Schemas.create_canned_response.parse(args);
        result = await createCannedResponse(client, { ...p, dry_run: p.dry_run ?? true }); break;
      }

      case "list_canned_responses":
        result = await listCannedResponses(client, Schemas.list_canned_responses.parse(args)); break;

      case "get_canned_response":
        result = await getCannedResponse(client, Schemas.get_canned_response.parse(args)); break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };

  } catch (err) {
    if (err instanceof FreshdeskApiError) {
      return {
        content: [{ type: "text", text: `**Freshdesk API Error** (${err.statusCode})\n\n${err.message}` }],
        isError: true,
      };
    }
    if (err instanceof z.ZodError) {
      return {
        content: [{ type: "text", text: `**Invalid input**\n\n${err.errors.map(e => `- ${e.path.join(".")}: ${e.message}`).join("\n")}` }],
        isError: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `**Error**: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Freshdesk Ops Intelligence MCP running on stdio");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });

// ─── Zod → JSON Schema (returns any to avoid MCP SDK type conflicts) ──────────

function toJsonSchema(schema: z.ZodTypeAny): any {
  return zodToSchema(schema);
}

function zodToSchema(s: z.ZodTypeAny): unknown {
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToSchema(v);
      if (!(v instanceof z.ZodOptional)) required.push(k);
    }
    return { type: "object", properties, required };
  }
  if (s instanceof z.ZodOptional) return zodToSchema(s.unwrap());
  if (s instanceof z.ZodString) {
    const r: Record<string, unknown> = { type: "string" };
    if (s.description) r.description = s.description;
    return r;
  }
  if (s instanceof z.ZodNumber) {
    const r: Record<string, unknown> = { type: "number" };
    if (s.description) r.description = s.description;
    return r;
  }
  if (s instanceof z.ZodBoolean) {
    const r: Record<string, unknown> = { type: "boolean" };
    if (s.description) r.description = s.description;
    return r;
  }
  if (s instanceof z.ZodEnum) return { type: "string", enum: s.options };
  if (s instanceof z.ZodArray) return { type: "array", items: zodToSchema(s.element) };
  if (s instanceof z.ZodRecord) return { type: "object" };
  return {};
}
