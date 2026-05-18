import { FreshdeskClient, STATUS_MAP, PRIORITY_MAP, SOURCE_MAP } from "../freshdesk-client.js";
import { formatDate, hoursSince, daysSince, formatHours } from "./tickets.js";

interface FreshdeskTicketSla {
  id: number;
  subject: string;
  status: number;
  priority: number;
  source: number;
  created_at: string;
  updated_at: string;
  due_by?: string;
  fr_due_by?: string;
  fr_escalated: boolean;
  is_escalated: boolean;
  responder_id?: number;
  group_id?: number;
  tags: string[];
  requester_id: number;
}

interface FreshdeskConversationStub {
  id: number;
  from_email?: string;
  private: boolean;
  created_at: string;
  incoming: boolean;
  body_text?: string;
}

// ─── List SLA Breaches ────────────────────────────────────────────────────────

/**
 * Freshdesk advantage over Gorgias/Zendesk:
 * Native SLA breach flags (fr_escalated, is_escalated) are on every ticket.
 * No heuristic needed — these are real, policy-driven breach indicators.
 */
export async function listSlaBreaches(
  client: FreshdeskClient,
  args: {
    breach_type?: "first_response" | "resolution" | "both";
    priority?: "low" | "medium" | "high" | "urgent";
    group_id?: number;
    limit?: number;
  }
): Promise<string> {
  const limit = Math.min(args.limit ?? 25, 100);
  const breachType = args.breach_type ?? "both";

  // Fetch open + pending tickets, order by oldest first
  const params = new URLSearchParams({
    per_page: String(limit),
    order_by: "due_by",
    order_type: "asc",
    include: "requester",
  });

  // Filter to open/pending only (closed/resolved SLA no longer active)
  const allTickets: FreshdeskTicketSla[] = [];

  for (const status of [2, 3]) { // open, pending
    const p = new URLSearchParams(params);
    p.set("status", String(status));
    if (args.group_id) p.set("group_id", String(args.group_id));
    if (args.priority) {
      const pMap: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4 };
      p.set("priority", String(pMap[args.priority]));
    }

    try {
      const tickets = await client.get<FreshdeskTicketSla[]>(`/tickets?${p.toString()}`);
      allTickets.push(...tickets);
    } catch {
      // Skip if status filter fails
    }
  }

  // Filter to breached tickets based on breach_type
  const breached = allTickets.filter(t => {
    if (breachType === "first_response") return t.fr_escalated;
    if (breachType === "resolution") return t.is_escalated;
    return t.fr_escalated || t.is_escalated;
  });

  // Sort: breached by priority (urgent first), then by longest wait
  breached.sort((a, b) => b.priority - a.priority || hoursSince(a.updated_at) - hoursSince(b.updated_at));

  if (!breached.length) {
    const filter = breachType === "both" ? "first response or resolution" : breachType.replace("_", " ");
    return [
      `## ✅ No Active SLA Breaches`,
      ``,
      `No open/pending tickets found with ${filter} SLA breached.`,
      ``,
      `> This uses Freshdesk's native SLA breach flags (\`fr_escalated\`, \`is_escalated\`) — not heuristic estimates.`,
    ].join("\n");
  }

  const lines = [
    `## 🔴 SLA Breaches — ${breached.length} ticket(s)`,
    `*(Using Freshdesk native SLA policy flags)*`,
    ``,
  ];

  let rank = 1;
  for (const t of breached.slice(0, limit)) {
    const status = STATUS_MAP[t.status] ?? String(t.status);
    const priority = PRIORITY_MAP[t.priority] ?? String(t.priority);
    const wait = hoursSince(t.updated_at);
    const age = daysSince(t.created_at);
    const tags = t.tags.join(", ") || "—";

    const breachFlags: string[] = [];
    if (t.fr_escalated) breachFlags.push("🔴 FRT breached");
    if (t.is_escalated) breachFlags.push("🔴 Resolution breached");

    const dueNote = t.due_by
      ? ` | Due: ${formatDate(t.due_by)}`
      : "";

    lines.push(
      `**${rank}. #${t.id}** — ${t.subject}`,
      `   ${breachFlags.join(" + ")}`,
      `   Priority: ${priority} | Status: ${status} | Age: ${age}d | No update: ${formatHours(wait)}${dueNote}`,
      `   Group: ${t.group_id ?? "none"} | Assignee: ${t.responder_id ?? "unassigned"}`,
      `   Tags: ${tags}`,
      ``
    );
    rank++;
  }

  lines.push(`---`);
  lines.push(`> Use \`explain_ticket_sla\` for full metrics on any ticket.`);
  lines.push(`> Use \`execute_ticket_update\` to escalate or reassign.`);

  return lines.join("\n");
}

// ─── Explain Ticket SLA ───────────────────────────────────────────────────────

export async function explainTicketSla(
  client: FreshdeskClient,
  args: { ticket_id: number }
): Promise<string> {
  const [ticketData, convosData] = await Promise.allSettled([
    client.get<FreshdeskTicketSla>(`/tickets/${args.ticket_id}`),
    client.get<FreshdeskConversationStub[]>(`/tickets/${args.ticket_id}/conversations`),
  ]);

  if (ticketData.status === "rejected") throw ticketData.reason;
  const t = ticketData.value;
  const convos = convosData.status === "fulfilled" ? convosData.value : [];

  // Compute first reply time from conversations
  const agentReplies = convos.filter(c => !c.incoming && !c.private);
  const customerMessages = convos.filter(c => c.incoming);
  let frtHours: number | null = null;

  if (customerMessages.length && agentReplies.length) {
    const firstCustomer = new Date(customerMessages[0].created_at).getTime();
    const firstAgent = new Date(agentReplies[0].created_at).getTime();
    if (firstAgent > firstCustomer) {
      frtHours = Math.round((firstAgent - firstCustomer) / (1000 * 60 * 60) * 10) / 10;
    }
  }

  const ageHours = hoursSince(t.created_at);
  const waitHours = hoursSince(t.updated_at);
  const status = STATUS_MAP[t.status] ?? String(t.status);
  const priority = PRIORITY_MAP[t.priority] ?? String(t.priority);

  // Time to deadline
  let deadlineNote = "";
  if (t.due_by && !t.is_escalated) {
    const remaining = Math.round((new Date(t.due_by).getTime() - Date.now()) / (1000 * 60 * 60));
    deadlineNote = remaining > 0
      ? `⚠️ **${formatHours(remaining)} remaining** until resolution deadline`
      : `🔴 **Deadline passed** ${formatHours(Math.abs(remaining))} ago`;
  }

  const lines = [
    `## 📊 SLA Story — Ticket #${t.id}`,
    `**${t.subject}**`,
    ``,
    `### Ticket Context`,
    `- **Status**: ${status} | **Priority**: ${priority}`,
    `- **Source**: ${SOURCE_MAP[t.source] ?? t.source}`,
    `- **Created**: ${formatDate(t.created_at)} (${formatHours(ageHours)} ago)`,
    `- **Last updated**: ${formatDate(t.updated_at)} (${formatHours(waitHours)} ago)`,
    `- **Assignee**: ${t.responder_id ?? "unassigned"} | **Group**: ${t.group_id ?? "none"}`,
    ``,
    `### ⏱ SLA Metrics (Native Freshdesk Policy)`,
    `- **First response due**: ${t.fr_due_by ? formatDate(t.fr_due_by) : "Not set"}`,
    `- **First response SLA**: ${t.fr_escalated ? "🔴 BREACHED" : "✅ Within target"}`,
    `- **Resolution due**: ${t.due_by ? formatDate(t.due_by) : "Not set"}`,
    `- **Resolution SLA**: ${t.is_escalated ? "🔴 BREACHED" : "✅ Within target"}`,
    deadlineNote ? `- ${deadlineNote}` : "",
    ``,
    `### Response Analysis`,
    frtHours !== null ? `- **Actual first reply time**: ${frtHours}h` : `- **First reply time**: Not yet recorded`,
    `- **Total conversations**: ${convos.length} (${agentReplies.length} agent, ${customerMessages.length} customer)`,
    convos.filter(c => c.private).length > 0 ? `- **Internal notes**: ${convos.filter(c => c.private).length}` : "",
    ``,
    `### Risk Verdict`,
  ];

  if (t.status === 4 || t.status === 5) {
    lines.push(`> Ticket is **${status}**. SLA clock stopped.`);
  } else if (t.is_escalated && t.fr_escalated) {
    lines.push(`> 🔴 **CRITICAL**: Both first response and resolution SLAs breached. Immediate escalation required.`);
  } else if (t.is_escalated) {
    lines.push(`> 🔴 **HIGH**: Resolution SLA breached. Prioritise and update customer immediately.`);
  } else if (t.fr_escalated) {
    lines.push(`> 🟠 **HIGH**: First response SLA breached. Customer hasn't received a reply.`);
  } else if (waitHours > 24) {
    lines.push(`> 🟡 **MEDIUM**: ${formatHours(waitHours)} since last update. Monitor against SLA deadline.`);
  } else {
    lines.push(`> 🟢 **ON TRACK**: No SLA breach. ${deadlineNote || "Within targets."}`);
  }

  return lines.filter(l => l !== undefined).join("\n");
}
