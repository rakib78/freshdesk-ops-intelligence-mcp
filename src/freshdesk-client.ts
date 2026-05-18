/**
 * Freshdesk REST API v2 client
 *
 * Auth: Basic {api_key}:X  (API key as username, literal "X" as password)
 * Base: https://{domain}.freshdesk.com/api/v2
 *
 * Rate limits:
 *   - Sprout/Free: 100 req/min
 *   - Growth+: 1000 req/min
 *   - Enterprise: 2000 req/min
 */

export interface FreshdeskConfig {
  domain: string;   // e.g. "mycompany" for mycompany.freshdesk.com
  apiKey: string;
}

export class FreshdeskClient {
  private baseUrl: string;
  private authHeader: string;
  private maxRetries = 3;

  constructor(config: FreshdeskConfig) {
    this.baseUrl = `https://${config.domain}.freshdesk.com/api/v2`;
    // Freshdesk auth: api_key as user, "X" as password
    this.authHeader = `Basic ${Buffer.from(`${config.apiKey}:X`).toString("base64")}`;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });

      // Rate limited
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        if (attempt < this.maxRetries) {
          await sleep(retryAfter * 1000);
          attempt++;
          continue;
        }
        throw new FreshdeskApiError(
          `Rate limited. Retry after ${retryAfter}s. Freshdesk rate limit depends on your plan (100–2000 req/min).`,
          429
        );
      }

      // Transient 5xx
      if (res.status >= 500 && attempt < this.maxRetries) {
        await sleep(exponentialDelay(attempt));
        attempt++;
        continue;
      }

      if (!res.ok) {
        let body: Record<string, unknown> = {};
        try { body = await res.json() as Record<string, unknown>; } catch { /* ignore */ }
        throw new FreshdeskApiError(formatError(body, res.status), res.status);
      }

      if (res.status === 204) return {} as T;
      return await res.json() as T;
    }

    throw new FreshdeskApiError("Max retries exceeded", 503);
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }
}

export class FreshdeskApiError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "FreshdeskApiError";
  }
}

// ─── Status / Priority helpers ────────────────────────────────────────────────

export const STATUS_MAP: Record<number, string> = {
  2: "open",
  3: "pending",
  4: "resolved",
  5: "closed",
};

export const STATUS_REVERSE: Record<string, number> = {
  open: 2,
  pending: 3,
  resolved: 4,
  closed: 5,
};

export const PRIORITY_MAP: Record<number, string> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "urgent",
};

export const PRIORITY_REVERSE: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

export const SOURCE_MAP: Record<number, string> = {
  1: "email",
  2: "portal",
  3: "phone",
  7: "chat",
  8: "mobihelp",
  9: "feedback widget",
  10: "outbound email",
  11: "ecommerce",
  13: "whatsapp",
};

function formatError(body: Record<string, unknown>, status: number): string {
  const desc = (body.description as string) ?? "";
  const errors = body.errors ? JSON.stringify(body.errors) : "";
  if (status === 401) {
    return `Auth error (401): Invalid API key or domain. Check FRESHDESK_DOMAIN and FRESHDESK_API_KEY. ${desc}`;
  }
  if (status === 403) {
    return `Permission denied (403): Your API key may lack required scopes. ${desc}`;
  }
  if (status === 404) {
    return `Not found (404): ${desc || "Resource does not exist"}`;
  }
  return `Freshdesk API error ${status}: ${desc} ${errors}`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function exponentialDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

export function clientFromEnv(): FreshdeskClient {
  const domain = process.env.FRESHDESK_DOMAIN;
  const apiKey = process.env.FRESHDESK_API_KEY;

  if (!domain || !apiKey) {
    throw new Error(
      "Missing required environment variables: FRESHDESK_DOMAIN, FRESHDESK_API_KEY"
    );
  }
  return new FreshdeskClient({ domain, apiKey });
}
