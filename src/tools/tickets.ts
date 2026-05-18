import {
  FreshdeskClient,
  STATUS_MAP,
  STATUS_REVERSE,
  PRIORITY_MAP,
  PRIORITY_REVERSE,
  SOURCE_MAP,
} from "../freshdesk-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FreshdeskTicket {
  id: number;
  subject: string;
  description_text?: string;
  status: number;
  priority: number;
  source: number;
  type?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  due_by?: string;
  fr_due_by?: string;
  fr_escalated: boolean;
  is_escalated: boolean;
  requester_id: number;
  responder_id?: number;
  group_id?: number;
  company_id?: number;
  custom_fields?: Record<string, unknown>;
}

interface FreshdeskConversation {
  id: number;
  from_email?: string;
  user_id?: number;
  private: boolean;
  body_text?: string;
  created_at: string;
  incoming: boolean;
}

interface FreshdeskContact {
  id: number;
  name: string;
  email: string;
}

interface TicketChanges {
  status?: "open" | "pending" | "resolved" | "closed";
  priority?: "low" | "medium" | "high" | "urgent";
  tags_add?: string[];
  tags_remove?: string[];
  responder_id?: number;
  group_id?: number;
  type?: string;
  custom_fields?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
}

export function hoursSince(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60));
}

export function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export function formatHours(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

function hoursUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60));
}

// ─── Search Tickets ───────────────────────────────────────────────────────────

export async function searchTickets(
  client: FreshdeskClient,
  args: {
    query?: string;
    status?: "open" | "pending" | "resolved" | "closed";
    priority?: "low" | "medium" | "high" | "urgent";
    group_id?: number;
    responder_id?: number;
    type?: string;
    tag?: string;
    page?: number;
    per_page?: number;
  }
): Promise<string> {
  const perPage = Math.min(args.per_page ?? 25, 100);
  const page = args.page ?? 1;

  // Build filter query for Freshdesk search API
  if (args.query) {
    // Use full-text search
    const encoded = encodeURIComponent(`"${args.query}"`);
    const data = await client.get<{ total: number; results: FreshdeskTicket[] }>(
      `/search/tickets?query=${encoded}&page=${page}`
    );

    if (!data.results.length) return `No tickets found for "${args.query}".`;
    return formatTicketList(data.results, data.total, page);
  }

  // Use filter API
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  params.set("include", "requester");
  params.set("order_type", "desc");
  params.set("order_by", "updated_at");

  if (args.status) params.set("status", String(STATUS_REVERSE[args.status]));
  if (args.priority) params.set("priority", String(PRIORITY_REVERSE[args.priority]));
  if (args.group_id) params.set("group_id", String(args.group_id));
  if (args.responder_id) params.set("responder_id", String(args.responder_id));
  if (args.type) params.set("type", args.type);
  if (args.tag) params.set("tags", args.tag);

  const tickets = await client.get<FreshdeskTicket[]>(`/tickets?${params.toString()}`);

  if (!tickets.length) return `No tickets found with the specified filters.`;
  return formatTicketList(tickets, null, page);
}

function formatTicketList(tickets: FreshdeskTicket[], total: number | null, page: number): string {
  const lines = [
    `## Ticket Results${total !== null ? ` (${total} total)` : ""}`,
    `Page ${page} — ${tickets.length} shown`,
    ``,
  ];

  for (const t of tickets) {
    const status = STATUS_MAP[t.status] ?? String(t.status);
    const priority = PRIORITY_MAP[t.priority] ?? String(t.priority);
    const wait = hoursSince(t.updated_at);
    const slaFlag = t.fr_escalated ? " 🔴FRT breached" : t.is_escalated ? " 🔴SLA breached" : "";

    lines.push(
      `**#${t.id}** — ${t.subject}${slaFlag}`,
      `  Status: ${status} | Priority: ${priority} | Updated: ${formatHours(wait)} ago`,
      `  Tags: ${t.tags.join(", ") || "—"} | Source: ${SOURCE_MAP[t.source] ?? t.source}`,
      ``
    );
  }

  if (page > 1 || tickets.length === 25) {
    lines.push(`> Use \`page: ${page + 1}\` to fetch next page.`);
  }

  return lines.join("\n");
}

// ─── Get Ticket ───────────────────────────────────────────────────────────────

export async function getTicket(
  client: FreshdeskClient,
  args: { ticket_id: number; include_conversations?: boolean }
): Promise<string> {
  const [ticketData, conversationsData] = await Promise.allSettled([
    client.get<FreshdeskTicket>(`/tickets/${args.ticket_id}?include=requester,company`),
    args.include_conversations !== false
      ? client.get<FreshdeskConversation[]>(`/tickets/${args.ticket_id}/conversations`)
      : Promise.resolve(null),
  ]);

  if (ticketData.status === "rejected") throw ticketData.reason;
  const t = ticketData.value;
  const convos = conversationsData.status === "fulfilled" && conversationsData.value
    ? conversationsData.value : [];

  const status = STATUS_MAP[t.status] ?? String(t.status);
  const priority = PRIORITY_MAP[t.priority] ?? String(t.priority);
  const source = SOURCE_MAP[t.source] ?? String(t.source);

  // SLA section — Freshdesk has native SLA flags!
  const slaLines = [
    `### ⏱ SLA Status`,
    `- **First response due**: ${t.fr_due_by ? formatDate(t.fr_due_by) : "Not set"}`,
    t.fr_escalated ? `- **First response SLA**: 🔴 BREACHED` : `- **First response SLA**: ✅ Within target`,
    `- **Resolution due**: ${t.due_by ? formatDate(t.due_by) : "Not set"}`,
    t.is_escalated ? `- **Resolution SLA**: 🔴 BREACHED` : `- **Resolution SLA**: ✅ Within target`,
  ];

  // Add time remaining if not breached
  if (t.due_by && !t.is_escalated) {
    const remaining = hoursUntil(t.due_by);
    if (remaining > 0) slaLines.push(`- **Time to resolution deadline**: ${formatHours(remaining)}`);
  }

  // Last conversations
  let convoSection = "";
  if (convos.length > 0) {
    const recent = convos.slice(-3);
    const msgs = recent.map(c => {
      const who = c.private ? "🔒 Internal note" : c.incoming ? "Customer" : "Agent";
      const preview = (c.body_text ?? "").slice(0, 200);
      return `**${who}** — ${formatDate(c.created_at)}\n  ${preview}${(c.body_text?.length ?? 0) > 200 ? "..." : ""}`;
    });
    convoSection = `\n### Conversations (last ${recent.length})\n${msgs.join("\n\n")}`;
  }

  return [
    `## Ticket #${t.id}: ${t.subject}`,
    ``,
    `- **Status**: ${status}`,
    `- **Priority**: ${priority}`,
    `- **Source**: ${source}`,
    `- **Type**: ${t.type ?? "not set"}`,
    `- **Tags**: ${t.tags.join(", ") || "none"}`,
    `- **Requester ID**: ${t.requester_id}`,
    `- **Assignee ID**: ${t.responder_id ?? "unassigned"}`,
    `- **Group ID**: ${t.group_id ?? "none"}`,
    `- **Created**: ${formatDate(t.created_at)}`,
    `- **Updated**: ${formatDate(t.updated_at)} (${formatHours(hoursSince(t.updated_at))} ago)`,
    ``,
    ...slaLines,
    convoSection,
    ``,
    `> Use \`preview_ticket_update\` to stage changes before applying.`,
  ].filter(l => l !== undefined).join("\n");
}

// ─── Preview Ticket Update (Dry-run) ─────────────────────────────────────────

export async function previewTicketUpdate(
  client: FreshdeskClient,
  args: { ticket_id: number; changes: TicketChanges }
): Promise<string> {
  const t = await client.get<FreshdeskTicket>(`/tickets/${args.ticket_id}`);
  const changes = args.changes;
  const diff: string[] = [];
  const warnings: string[] = [];

  const currentStatus = STATUS_MAP[t.status];
  const currentPriority = PRIORITY_MAP[t.priority];

  if (changes.status && changes.status !== currentStatus) {
    if (currentStatus === "closed") {
      warnings.push(`⚠️ Ticket is CLOSED — reopening requires a specific workflow in Freshdesk`);
    }
    diff.push(`**Status**: ${currentStatus} → ${changes.status}`);
  } else if (changes.status === currentStatus) {
    warnings.push(`Status already "${currentStatus}" (no-op)`);
  }

  if (changes.priority && changes.priority !== currentPriority) {
    diff.push(`**Priority**: ${currentPriority} → ${changes.priority}`);
  } else if (changes.priority === currentPriority) {
    warnings.push(`Priority already "${currentPriority}" (no-op)`);
  }

  if (changes.tags_add?.length || changes.tags_remove?.length) {
    const currentTags = new Set(t.tags);
    const addTags = changes.tags_add ?? [];
    const removeTags = changes.tags_remove ?? [];

    const alreadyOn = addTags.filter(tag => currentTags.has(tag));
    const notOn = removeTags.filter(tag => !currentTags.has(tag));
    if (alreadyOn.length) warnings.push(`Tags already on ticket (no-op add): ${alreadyOn.join(", ")}`);
    if (notOn.length) warnings.push(`Tags not on ticket (no-op remove): ${notOn.join(", ")}`);

    const resultTags = [...currentTags, ...addTags].filter(n => !removeTags.includes(n));
    diff.push(
      `**Tags**`,
      `  Before: [${[...currentTags].join(", ") || "none"}]`,
      `  After:  [${resultTags.join(", ") || "none"}]`
    );
  }

  if (changes.responder_id !== undefined) {
    diff.push(`**Assignee ID**: ${t.responder_id ?? "unassigned"} → ${changes.responder_id}`);
  }
  if (changes.group_id !== undefined) {
    diff.push(`**Group ID**: ${t.group_id ?? "none"} → ${changes.group_id}`);
  }
  if (changes.type) {
    diff.push(`**Type**: ${t.type ?? "none"} → ${changes.type}`);
  }
  if (changes.custom_fields) {
    diff.push(`**Custom fields**: ${Object.keys(changes.custom_fields).length} field(s) to update`);
  }

  if (diff.length === 0 && warnings.length === 0) {
    return `No effective changes detected for ticket #${args.ticket_id}.`;
  }

  return [
    `## 🔍 Dry-Run Preview — Ticket #${args.ticket_id}`,
    `**"${t.subject}" — No changes applied.**`,
    ``,
    diff.length ? `### Changes\n${diff.join("\n")}` : "",
    warnings.length ? `\n### ⚠️ Warnings\n${warnings.map(w => `- ${w}`).join("\n")}` : "",
    ``,
    `---`,
    `To apply: call \`execute_ticket_update\` with \`confirm: true\`.`,
  ].filter(Boolean).join("\n");
}

// ─── Execute Ticket Update ────────────────────────────────────────────────────

export async function executeTicketUpdate(
  client: FreshdeskClient,
  args: { ticket_id: number; changes: TicketChanges; confirm: boolean }
): Promise<string> {
  if (!args.confirm) {
    return [
      `⛔ Blocked: \`confirm\` must be \`true\` to apply changes.`,
      `Run \`preview_ticket_update\` first to review the diff.`,
    ].join("\n");
  }

  const t = await client.get<FreshdeskTicket>(`/tickets/${args.ticket_id}`);
  const changes = args.changes;
  const patch: Record<string, unknown> = {};

  if (changes.status) patch.status = STATUS_REVERSE[changes.status];
  if (changes.priority) patch.priority = PRIORITY_REVERSE[changes.priority];
  if (changes.responder_id !== undefined) patch.responder_id = changes.responder_id;
  if (changes.group_id !== undefined) patch.group_id = changes.group_id;
  if (changes.type) patch.type = changes.type;
  if (changes.custom_fields) patch.custom_fields = changes.custom_fields;

  if (changes.tags_add?.length || changes.tags_remove?.length) {
    const currentTags = new Set(t.tags);
    (changes.tags_add ?? []).forEach(tag => currentTags.add(tag));
    (changes.tags_remove ?? []).forEach(tag => currentTags.delete(tag));
    patch.tags = [...currentTags];
  }

  const updated = await client.put<FreshdeskTicket>(`/tickets/${args.ticket_id}`, patch);

  return [
    `## ✅ Ticket #${updated.id} Updated`,
    ``,
    `- **Status**: ${STATUS_MAP[updated.status]}`,
    `- **Priority**: ${PRIORITY_MAP[updated.priority]}`,
    `- **Tags**: ${updated.tags.join(", ") || "none"}`,
    `- **Assignee ID**: ${updated.responder_id ?? "unassigned"}`,
    `- **Updated**: ${formatDate(updated.updated_at)}`,
    ``,
    `Changes applied successfully.`,
  ].join("\n");
}

// ─── Add Private Note ─────────────────────────────────────────────────────────

export async function addPrivateNote(
  client: FreshdeskClient,
  args: { ticket_id: number; body: string; notify_agent_ids?: number[]; dry_run?: boolean }
): Promise<string> {
  if (args.dry_run !== false) {
    return [
      `## 🔍 Dry-Run — Private Note Preview`,
      `**Ticket**: #${args.ticket_id}`,
      `**Type**: Private note (not visible to customer)`,
      args.notify_agent_ids?.length
        ? `**Notifying agents**: ${args.notify_agent_ids.join(", ")}`
        : "",
      ``,
      `**Content**:`,
      args.body,
      ``,
      `No note has been posted. Set \`dry_run: false\` to post it.`,
    ].filter(Boolean).join("\n");
  }

  const payload: Record<string, unknown> = {
    body: args.body,
    private: true,
  };
  if (args.notify_agent_ids?.length) {
    payload.notify_emails = args.notify_agent_ids;
  }

  const result = await client.post<{ id: number; created_at: string }>(
    `/tickets/${args.ticket_id}/notes`,
    payload
  );

  return [
    `## ✅ Private Note Added — Ticket #${args.ticket_id}`,
    ``,
    `Note ID: ${result.id}`,
    `Posted at: ${formatDate(result.created_at)}`,
  ].join("\n");
}
