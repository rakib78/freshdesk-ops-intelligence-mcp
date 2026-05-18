import { FreshdeskClient } from "../freshdesk-client.js";

interface FreshdeskAgent {
  id: number;
  contact: {
    name: string;
    email: string;
    active: boolean;
  };
  role_ids?: number[];
  occasional?: boolean;
  ticket_scope?: number;
}

export async function freshdeskWhoami(client: FreshdeskClient): Promise<string> {
  const [agentData, groupsData] = await Promise.allSettled([
    client.get<FreshdeskAgent>("/agents/me"),
    client.get<Array<{ id: number; name: string }>>("/groups"),
  ]);

  if (agentData.status === "rejected") {
    throw new Error(
      `Cannot verify Freshdesk connection: ${agentData.reason?.message ?? "Auth failed"}. Check FRESHDESK_DOMAIN and FRESHDESK_API_KEY.`
    );
  }

  const agent = agentData.value;
  const groups = groupsData.status === "fulfilled" ? groupsData.value : [];

  const scopeLabel: Record<number, string> = {
    1: "Global (all tickets)",
    2: "Restricted (assigned group/agent)",
    3: "Assigned tickets only",
  };

  return [
    `## ✅ Freshdesk Connection Verified`,
    ``,
    `- **Agent**: ${agent.contact.name} (${agent.contact.email})`,
    `- **Active**: ${agent.contact.active ? "Yes" : "No"}`,
    `- **Ticket scope**: ${scopeLabel[agent.ticket_scope ?? 1] ?? "Unknown"}`,
    `- **Agent type**: ${agent.occasional ? "Occasional" : "Full-time"}`,
    groups.length ? `- **Groups available**: ${groups.map(g => g.name).join(", ")}` : "",
    ``,
    `**Auth type**: API Key (Basic)`,
    `**Status**: Connected and authenticated`,
    ``,
    `> Run \`search_tickets\` or \`weekly_support_summary\` to start.`,
    `> Note: Ticket scope determines which tickets this API key can access.`,
  ].filter(Boolean).join("\n");
}
