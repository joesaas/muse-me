import { createHmac } from "node:crypto";
import type { OkxConfig } from "../../config.js";
import { GuardrailDenied } from "../../domain/errors.js";

/**
 * OKX 交易所 REST v5 客户端（最小集：余额/行情/合约规格/下单/订单/持仓）。
 * 鉴权：OK-ACCESS-KEY + OK-ACCESS-SIGN（HMAC-SHA256 + Base64，预哈希 =
 * timestamp + METHOD + requestPath + body）+ OK-ACCESS-TIMESTAMP +
 * OK-ACCESS-PASSPHRASE。模拟盘与实盘同域名（https://www.okx.com），
 * 环境只由 x-simulated-trading: 1 区分——模拟盘必须用在模拟盘环境内
 * 创建的独立 API Key，实盘 Key + header 混用不生效。
 * 密钥只经构造函数传入，永不记日志、不进返回体。
 */

export class OkxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_FETCH: FetchImpl = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
};

export interface OkxBalanceRow {
  ccy: string;
  bal: string;
  availBal: string;
  frozenBal: string;
}

export interface OkxTicker {
  instId: string;
  last: string;
}

export interface OkxInstrument {
  instId: string;
  ctVal: string;
  lotSz: string;
  minSz: string;
  tickSz: string;
}

export interface OkxOrderResult {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class OkxClient {
  constructor(
    private readonly config: OkxConfig,
    private readonly fetchImpl: FetchImpl = DEFAULT_FETCH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 三件套是否齐全（未配置时读工具直接拒绝，不发请求）。 */
  get configured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiSecret && this.config.passphrase);
  }

  /** 当前执行环境：demo（默认）或 live（仅 OKX_ALLOW_LIVE=true 时）。 */
  get environment(): "demo" | "live" {
    return this.config.demo ? "demo" : "live";
  }

  /**
   * 交易执行门：demo 直接放行；live 必须显式 OKX_ALLOW_LIVE=true，
   * 否则拒绝——防「以为在模拟盘、实际在实盘」的误触。
   */
  assertTradable(): void {
    if (!this.configured) {
      throw new GuardrailDenied(
        "OKX 未配置：请设置 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE（模拟盘 Key 在模拟盘环境内创建）",
      );
    }
    if (!this.config.demo && !this.config.allowLive) {
      throw new GuardrailDenied(
        "真实交易未开启：OKX_DEMO=false 且未设置 OKX_ALLOW_LIVE=true，拒绝下单",
      );
    }
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new GuardrailDenied(
        "OKX 未配置：请设置 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE（模拟盘 Key 在模拟盘环境内创建）",
      );
    }
  }

  /** 签名头（可单测：固定时间戳时签名可复算）。 */
  signHeaders(
    method: string,
    requestPath: string,
    body: string,
    timestamp: string,
  ): Record<string, string> {
    const prehash = `${timestamp}${method}${requestPath}${body}`;
    const sign = createHmac("sha256", this.config.apiSecret)
      .update(prehash, "utf8")
      .digest("base64");
    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.config.apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.config.passphrase,
    };
    if (this.config.demo) headers["x-simulated-trading"] = "1";
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    authed = true,
  ): Promise<T> {
    if (authed) this.requireConfigured();
    const bodyText = body ? JSON.stringify(body) : "";
    const timestamp = this.now().toISOString();
    const headers: Record<string, string> = authed
      ? this.signHeaders(method, path, bodyText, timestamp)
      : this.config.demo
        ? { "x-simulated-trading": "1" }
        : {};
    if (body) headers["Content-Type"] = "application/json";
    const url = `${this.config.baseUrl}${path}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body ? bodyText : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new OkxError("network", `OKX 请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const payload = (await res.json()) as unknown;
    if (!isRecord(payload)) {
      throw new OkxError("bad_response", `OKX 返回非 JSON 对象（HTTP ${res.status}）`);
    }
    const code = String(payload.code ?? "");
    if (code !== "0") {
      const msg = String(payload.msg ?? "未知错误");
      throw new OkxError(code, `OKX ${code}：${msg}`);
    }
    return payload.data as T;
  }

  /** 账户余额（模拟盘返回模拟盘资产）。 */
  async balance(ccy?: string): Promise<OkxBalanceRow[]> {
    const path = ccy ? `/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}` : "/api/v5/account/balance";
    const data = await this.request<Array<Record<string, unknown>>>("GET", path);
    const details = (data[0]?.details ?? []) as Array<Record<string, unknown>>;
    return details.map((d) => ({
      ccy: String(d.ccy ?? ""),
      bal: String(d.bal ?? "0"),
      availBal: String(d.availBal ?? "0"),
      frozenBal: String(d.frozenBal ?? "0"),
    }));
  }

  /** 行情现价（公开接口，无需密钥）。 */
  async ticker(instId: string): Promise<OkxTicker> {
    const data = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`,
      undefined,
      false,
    );
    const row = data[0];
    if (!row || row.last === undefined) {
      throw new OkxError("no_ticker", `OKX 无行情：${instId}`);
    }
    return { instId: String(row.instId ?? instId), last: String(row.last) };
  }

  /** 合约规格（公开接口）：张面值 ctVal、最小下单量 lotSz。 */
  async instrument(instId: string): Promise<OkxInstrument> {
    const data = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`,
      undefined,
      false,
    );
    const row = data[0];
    if (!row) throw new OkxError("no_instrument", `OKX 无此合约：${instId}`);
    return {
      instId: String(row.instId ?? instId),
      ctVal: String(row.ctVal ?? "0"),
      lotSz: String(row.lotSz ?? "0"),
      minSz: String(row.minSz ?? "0"),
      tickSz: String(row.tickSz ?? "0"),
    };
  }

  /** 下单（市价）。返回首条结果；sCode 非 0 时当错误抛（订单级失败不静默）。 */
  async placeOrder(body: Record<string, unknown>): Promise<OkxOrderResult> {
    const data = await this.request<Array<Record<string, unknown>>>("POST", "/api/v5/trade/order", body);
    const row = data[0];
    if (!row) throw new OkxError("no_order", "OKX 下单无返回");
    const sCode = String(row.sCode ?? "");
    if (sCode !== "0") {
      throw new OkxError(sCode, `OKX 下单失败 ${sCode}：${String(row.sMsg ?? "")}`);
    }
    return {
      ordId: String(row.ordId ?? ""),
      clOrdId: String(row.clOrdId ?? ""),
      sCode,
      sMsg: String(row.sMsg ?? ""),
    };
  }

  /** 订单详情。 */
  async orderDetail(instId: string, ordId: string): Promise<Record<string, unknown>> {
    const data = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`,
    );
    const row = data[0];
    if (!row) throw new OkxError("no_order", `OKX 无此订单：${ordId}`);
    return row;
  }

  /** 持仓（默认永续）。 */
  async positions(instType = "SWAP"): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(
      "GET",
      `/api/v5/account/positions?instType=${encodeURIComponent(instType)}`,
    );
  }
}
