type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

export class BackendClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl = process.env.AFTERSTAGE_API_URL ?? "http://127.0.0.1:8787",
    token = process.env.AFTERSTAGE_ACCESS_TOKEN ?? "",
    timeoutMs = Number(process.env.AFTERSTAGE_API_TIMEOUT_MS ?? 60_000),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 60_000;
  }

  async get<T>(pathname: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const search = new URLSearchParams(
      Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const suffix = search.size ? `?${search.toString()}` : "";
    return this.request<T>(`${pathname}${suffix}`);
  }

  async send<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(pathname, options);
  }

  private async request<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    if (!this.token) {
      throw new Error("AFTERSTAGE_ACCESS_TOKEN no está configurado para el MCP");
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    });
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${this.baseUrl}${pathname}`, init);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : text;
      throw new Error(`Afterstage API ${response.status}: ${String(detail || response.statusText)}`);
    }
    return payload as T;
  }
}
