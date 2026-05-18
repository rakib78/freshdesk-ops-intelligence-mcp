import { FreshdeskClient } from "../freshdesk-client.js";
import { formatDate } from "./tickets.js";

interface FreshdeskContactFull {
  id: number;
  name: string;
  email: string;
  phone?: string;
  mobile?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  company_id?: number;
  tags?: string[];
  other_emails?: string[];
  twitter_id?: string;
  facebook_id?: string;
  custom_fields?: Record<string, unknown>;
}

interface FreshdeskCompany {
  id: number;
  name: string;
  domains?: string[];
}

export async function getContact(
  client: FreshdeskClient,
  args: { contact_id?: number; email?: string }
): Promise<string> {
  let contact: FreshdeskContactFull;

  if (args.email) {
    const results = await client.get<FreshdeskContactFull[]>(
      `/contacts?email=${encodeURIComponent(args.email)}`
    );
    if (!results.length) return `No contact found with email "${args.email}".`;
    contact = results[0];
  } else if (args.contact_id) {
    contact = await client.get<FreshdeskContactFull>(`/contacts/${args.contact_id}`);
  } else {
    return `Provide either \`contact_id\` or \`email\`.`;
  }

  // Fetch company if present
  let companyLine = "";
  if (contact.company_id) {
    try {
      const company = await client.get<FreshdeskCompany>(`/companies/${contact.company_id}`);
      companyLine = `- **Company**: ${company.name} (ID: ${company.id})`;
    } catch {
      companyLine = `- **Company ID**: ${contact.company_id}`;
    }
  }

  const channels: string[] = [];
  if (contact.email) channels.push(`Email: ${contact.email}`);
  if (contact.phone) channels.push(`Phone: ${contact.phone}`);
  if (contact.mobile) channels.push(`Mobile: ${contact.mobile}`);
  if (contact.twitter_id) channels.push(`Twitter: @${contact.twitter_id}`);
  if (contact.facebook_id) channels.push(`Facebook: ${contact.facebook_id}`);
  if (contact.other_emails?.length) channels.push(`Other emails: ${contact.other_emails.join(", ")}`);

  return [
    `## Contact: ${contact.name}`,
    ``,
    `- **Freshdesk ID**: ${contact.id}`,
    `- **Active**: ${contact.active ? "Yes" : "No"}`,
    channels.length ? `- **Channels**: ${channels.join(" | ")}` : "",
    companyLine,
    contact.tags?.length ? `- **Tags**: ${contact.tags.join(", ")}` : "",
    `- **Created**: ${formatDate(contact.created_at)}`,
    `- **Updated**: ${formatDate(contact.updated_at)}`,
    contact.custom_fields && Object.keys(contact.custom_fields).length
      ? `\n### Custom Fields\n${Object.entries(contact.custom_fields)
          .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
          .join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
}

export async function searchContacts(
  client: FreshdeskClient,
  args: { query: string; limit?: number }
): Promise<string> {
  const encoded = encodeURIComponent(`"${args.query}"`);
  const data = await client.get<{ total: number; results: FreshdeskContactFull[] }>(
    `/search/contacts?query=${encoded}`
  );

  if (!data.results.length) return `No contacts found for "${args.query}".`;

  const limit = Math.min(args.limit ?? 10, data.results.length);
  const contacts = data.results.slice(0, limit);

  const lines = [`## Contact Search — "${args.query}" (${data.total} total)`, ``];
  for (const c of contacts) {
    lines.push(
      `**ID ${c.id}** — ${c.name} (${c.email})`,
      c.phone ? `  Phone: ${c.phone}` : "",
      c.company_id ? `  Company ID: ${c.company_id}` : "",
      ``
    );
  }

  return lines.filter(Boolean).join("\n");
}
