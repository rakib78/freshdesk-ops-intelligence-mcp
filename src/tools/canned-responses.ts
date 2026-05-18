import { FreshdeskClient } from "../freshdesk-client.js";

interface FreshdeskCannedResponse {
  id: number;
  title: string;
  content: string;
  content_html: string;
  visibility: number; // 0=personal, 1=all
  folder_id?: number;
}

interface FreshdeskFolder {
  id: number;
  name: string;
  visibility: number;
  canned_responses?: FreshdeskCannedResponse[];
}

// ─── List Canned Responses ────────────────────────────────────────────────────

export async function listCannedResponses(
  client: FreshdeskClient,
  args: { query?: string }
): Promise<string> {
  const folders = await client.get<FreshdeskFolder[]>("/canned_response_folders?include=canned_responses");

  if (!folders.length) return `No canned response folders found.`;

  const lines = [`## Canned Responses`, ``];
  let totalCount = 0;

  for (const folder of folders) {
    const responses = folder.canned_responses ?? [];
    const filtered = args.query
      ? responses.filter(r => r.title.toLowerCase().includes(args.query!.toLowerCase()))
      : responses;

    if (!filtered.length) continue;
    totalCount += filtered.length;

    lines.push(`### 📁 ${folder.name} (${filtered.length} responses)`);
    for (const r of filtered) {
      const visibility = r.visibility === 0 ? "Personal" : "All agents";
      lines.push(
        `**#${r.id}** — ${r.title}`,
        `  Visibility: ${visibility}`,
        ``
      );
    }
  }

  if (totalCount === 0) {
    return `No canned responses found${args.query ? ` matching "${args.query}"` : ""}.`;
  }

  lines.unshift(`Found **${totalCount}** canned responses across ${folders.length} folders.\n`);
  return lines.join("\n");
}

// ─── Get Canned Response ──────────────────────────────────────────────────────

export async function getCannedResponse(
  client: FreshdeskClient,
  args: { canned_response_id: number }
): Promise<string> {
  const r = await client.get<FreshdeskCannedResponse>(`/canned_responses/${args.canned_response_id}`);

  const visibility = r.visibility === 0 ? "Personal" : "All agents";

  return [
    `## Canned Response #${r.id}: ${r.title}`,
    `- **Visibility**: ${visibility}`,
    `- **Folder**: ${r.folder_id ?? "none"}`,
    ``,
    `### Content (plain text):`,
    r.content || "(empty)",
    ``,
    `### Content (HTML):`,
    "```html",
    r.content_html || "(empty)",
    "```",
  ].join("\n");
}

// ─── Create Canned Response ───────────────────────────────────────────────────

export async function createCannedResponse(
  client: FreshdeskClient,
  args: {
    title: string;
    content: string;
    folder_id?: number;
    visibility?: "personal" | "all";
    dry_run?: boolean;
  }
): Promise<string> {
  const dryRun = args.dry_run !== false;
  const visibility = args.visibility === "personal" ? 0 : 1;

  const payload = {
    title: args.title,
    content_html: `<p>${args.content.replace(/\n/g, "</p><p>")}</p>`,
    folder_id: args.folder_id,
    visibility,
  };

  if (dryRun) {
    return [
      `## 🔍 Dry-Run — Canned Response Preview`,
      `**Title**: ${args.title}`,
      `**Visibility**: ${args.visibility === "personal" ? "Personal (only you)" : "All agents"}`,
      args.folder_id ? `**Folder ID**: ${args.folder_id}` : "**Folder**: Default",
      ``,
      `### Content:`,
      args.content,
      ``,
      `---`,
      `No canned response has been created.`,
      `Call \`create_canned_response\` with \`dry_run: false\` to create it.`,
      ``,
      `> **Tip**: Use \`list_canned_responses\` to find a folder ID first.`,
    ].filter(Boolean).join("\n");
  }

  // If no folder_id, find or note first available folder
  let folderId = args.folder_id;
  if (!folderId) {
    try {
      const folders = await client.get<FreshdeskFolder[]>("/canned_response_folders");
      if (folders.length) {
        folderId = folders[0].id;
      }
    } catch {
      // Continue without folder
    }
  }

  if (folderId) payload.folder_id = folderId;

  const result = await client.post<FreshdeskCannedResponse>("/canned_responses", payload);

  return [
    `## ✅ Canned Response Created — #${result.id}`,
    `**Title**: ${result.title}`,
    `**Visibility**: ${result.visibility === 0 ? "Personal" : "All agents"}`,
    `**Folder**: ${result.folder_id ?? "none"}`,
    ``,
    `Use \`list_canned_responses\` to verify it appears in the library.`,
  ].join("\n");
}
