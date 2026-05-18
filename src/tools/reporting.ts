import { FreshdeskClient, STATUS_MAP, PRIORITY_MAP, SOURCE_MAP } from "../freshdesk-client.js";
import { hoursSince, formatHours } from "./tickets.js";

interface FreshdeskTicketStub {
  id: number;
  status: number;
  priority: number;
  source: number;
  created_at: string;
  updated_at: string;
  due_by?: string;
  fr_escalated: boolean;
  is_escalated: boolean;
  tags: string[];
  responder_id?: number;
  group_id?: number;
}

interface FreshdeskSatisfactionRating {
  id: number;
  ratings: { default_question: number };
  created_at: string;
  ticket_id: number;
}

export async function weeklySupportSummary(
  client: FreshdeskClient,
  args: {
    week_start?: string;
  }
): Promise<string> {
  const weekStart = args.week_start ?? getPastMonday();
  const weekEnd = getDatePlusDays(weekStart, 7);
  const weekStartIso = new Date(weekStart).toISOString();
  const weekEndIso = new Date(weekEnd).toISOString();

  const lines: string[] = [
    `## 📋 Weekly Support Summary`,
    `**Period**: ${weekStart} → ${weekEnd}`,
    ``,
  ];

  // ── Created this week ─────────────────────────────────────────────────────
  let createdTickets: FreshdeskTicketStub[] = [];
  try {
    // Freshdesk filter API for date range
    const encoded = encodeURIComponent(`created_at:>'${weekStart}' AND created_at:<'${weekEnd}'`);
    const data = await client.get<{ total: number; results: FreshdeskTicketStub[] }>(
      `/search/tickets?query=${encoded}&page=1`
    );
    createdTickets = data.results;
    lines.push(`### 📊 Volume`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Created this week | **${data.total}** |`);
  } catch {
    // Fall back to listing recently updated tickets
    const tickets = await client.get<FreshdeskTicketStub[]>(
      `/tickets?per_page=100&order_by=created_at&order_type=desc`
    );
    createdTickets = tickets.filter(t =>
      t.created_at >= weekStartIso && t.created_at < weekEndIso
    );
    lines.push(`### 📊 Volume`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Created this week (sample) | **${createdTickets.length}** |`);
  }

  // ── Open / pending counts ─────────────────────────────────────────────────
  const [openData, pendingData, resolvedData] = await Promise.allSettled([
    client.get<FreshdeskTicketStub[]>(`/tickets?status=2&per_page=1`),
    client.get<FreshdeskTicketStub[]>(`/tickets?status=3&per_page=1`),
    client.get<FreshdeskTicketStub[]>(`/tickets?status=4&per_page=1`),
  ]);

  // We need the total count — fetch with page tracking
  const [openCount, pendingCount] = await Promise.all([
    getStatusCount(client, 2),
    getStatusCount(client, 3),
  ]);

  lines.push(`| Currently open | **${openCount}** |`);
  lines.push(`| Currently pending | **${pendingCount}** |`);
  lines.push(``);

  // ── Priority breakdown of open tickets ────────────────────────────────────
  const openSample = await safeGet<FreshdeskTicketStub[]>(
    client,
    `/tickets?status=2&per_page=100&order_by=priority&order_type=desc`
  ) ?? [];

  if (openSample.length) {
    const priorityCounts: Record<string, number> = { urgent: 0, high: 0, medium: 0, low: 0 };
    openSample.forEach(t => {
      const p = PRIORITY_MAP[t.priority] ?? "low";
      priorityCounts[p] = (priorityCounts[p] ?? 0) + 1;
    });

    lines.push(`### 🔥 Open Tickets by Priority (sample of ${openSample.length})`);
    lines.push(`| Priority | Count |`);
    lines.push(`|----------|-------|`);
    lines.push(`| 🔴 Urgent | ${priorityCounts.urgent} |`);
    lines.push(`| 🟠 High | ${priorityCounts.high} |`);
    lines.push(`| 🟡 Medium | ${priorityCounts.medium} |`);
    lines.push(`| ⬜ Low | ${priorityCounts.low} |`);
    lines.push(``);
  }

  // ── Channel breakdown ─────────────────────────────────────────────────────
  if (createdTickets.length > 0) {
    const channelCounts: Record<string, number> = {};
    createdTickets.forEach(t => {
      const ch = SOURCE_MAP[t.source] ?? `source-${t.source}`;
      channelCounts[ch] = (channelCounts[ch] ?? 0) + 1;
    });

    const topChannels = Object.entries(channelCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6);

    if (topChannels.length) {
      lines.push(`### 📡 Tickets by Channel (This Week)`);
      lines.push(`| Channel | Tickets |`);
      lines.push(`|---------|---------|`);
      topChannels.forEach(([ch, count]) => lines.push(`| ${ch} | ${count} |`));
      lines.push(``);
    }

    // ── Top tags ─────────────────────────────────────────────────────────
    const tagCounts: Record<string, number> = {};
    createdTickets.forEach(t => t.tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }));
    const topTags = Object.entries(tagCounts).sort(([, a], [, b]) => b - a).slice(0, 8);

    if (topTags.length) {
      lines.push(`### 🏷 Top Tags (This Week)`);
      lines.push(`| Tag | Count |`);
      lines.push(`|-----|-------|`);
      topTags.forEach(([tag, count]) => lines.push(`| ${tag} | ${count} |`));
      lines.push(``);
    }
  }

  // ── SLA health — native breach flags ─────────────────────────────────────
  const slaBreachedFRT = openSample.filter(t => t.fr_escalated).length;
  const slaBreachedRes = openSample.filter(t => t.is_escalated).length;
  const slaTotal = slaBreachedFRT + slaBreachedRes;
  const slaEmoji = slaTotal === 0 ? "✅" : slaTotal < 5 ? "🟡" : "🔴";

  lines.push(`### ⏱ SLA Health (Native Freshdesk Policy Flags)`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| FRT SLA breached (open tickets) | ${slaBreachedFRT === 0 ? "✅ 0" : `🔴 ${slaBreachedFRT}`} |`);
  lines.push(`| Resolution SLA breached (open tickets) | ${slaBreachedRes === 0 ? "✅ 0" : `🔴 ${slaBreachedRes}`} |`);
  if (slaTotal > 0) {
    lines.push(`| | Run \`list_sla_breaches\` for full ranked list |`);
  }
  lines.push(``);

  // ── CSAT ─────────────────────────────────────────────────────────────────
  try {
    const csatData = await client.get<FreshdeskSatisfactionRating[]>(
      `/surveys/satisfaction_ratings?page=1&per_page=100`
    );

    const thisWeek = csatData.filter(r =>
      r.created_at >= weekStartIso && r.created_at < weekEndIso
    );

    if (thisWeek.length > 0) {
      const good = thisWeek.filter(r => r.ratings.default_question >= 4).length;
      const bad = thisWeek.filter(r => r.ratings.default_question <= 2).length;
      const csatPct = Math.round((good / thisWeek.length) * 100);
      const csatEmoji = csatPct >= 90 ? "✅" : csatPct >= 75 ? "🟡" : "🔴";

      lines.push(`### ⭐ CSAT`);
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Ratings received | ${thisWeek.length} |`);
      lines.push(`| Positive (4–5★) | ${good} |`);
      lines.push(`| Negative (1–2★) | ${bad} |`);
      lines.push(`| CSAT score | ${csatEmoji} **${csatPct}%** |`);
      lines.push(``);
    } else {
      lines.push(`*CSAT: No ratings received this period (or plan doesn't support satisfaction surveys).*\n`);
    }
  } catch {
    lines.push(`*CSAT: Not available on this plan or insufficient permissions.*\n`);
  }

  // ── Manager digest ────────────────────────────────────────────────────────
  lines.push(`---`);
  lines.push(`### 📝 Manager Digest`);

  if (slaTotal > 0) {
    lines.push(`⚠️ ${slaTotal} active SLA breach(es) — run \`list_sla_breaches\` immediately.`);
  } else {
    lines.push(`✅ No active SLA breaches on open tickets.`);
  }

  if (openCount > 50) {
    lines.push(`Queue depth is **${openCount} open tickets** — review staffing and backlog plan.`);
  }

  lines.push(``);
  lines.push(`> **Note**: Volume data uses Freshdesk search API (may lag a few minutes). SLA breach data uses native ticket flags and is real-time.`);

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getStatusCount(client: FreshdeskClient, status: number): Promise<number> {
  try {
    // Freshdesk doesn't return total in list — page through to get count estimate
    const page1 = await client.get<unknown[]>(`/tickets?status=${status}&per_page=1`);
    // Use search API for count
    const data = await client.get<{ total: number }>(
      `/search/tickets?query=${encodeURIComponent(`status:${status}`)}`
    );
    return data.total;
  } catch {
    return 0;
  }
}

async function safeGet<T>(client: FreshdeskClient, path: string): Promise<T | null> {
  try { return await client.get<T>(path); } catch { return null; }
}

function getPastMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split("T")[0];
}

function getDatePlusDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}
