import type { ScriptDoc } from "./types.js";

/**
 * 插件目录（插件市场模板）：每个模板 = 一份可直接安装的脚本草稿。
 * 安装即按名 upsert 成脚本，走同一套审批/轨迹/定时任务；模板本身
 * 不含任何密钥，只声明所需连接（requiresConnection），配置状态由
 * 服务层在列表时填入（configured），前端据此提示但不阻塞安装。
 */

export interface PluginTemplate {
  id: string;
  name: string;
  provider: string;
  description: string;
  requiresConnection: "okx";
  doc: ScriptDoc;
}

export const PLUGIN_TEMPLATES: readonly PluginTemplate[] = [
  {
    id: "okx-spot",
    name: "OKX 现货买入",
    provider: "OKX 交易所",
    description: "查行情 → 审批后在 OKX 市价买入/卖出现货（默认模拟盘，不动真钱）。",
    requiresConnection: "okx",
    doc: {
      name: "OKX 现货买入",
      description: "查行情 → 审批后在 OKX 市价买入/卖出现货（默认模拟盘，不动真钱）。",
      params: [
        { key: "inst_id", label: "交易对", type: "string", default: "BTC-USDT" },
        { key: "side", label: "方向（buy/sell）", type: "string", default: "buy" },
        { key: "amount_usd", label: "金额（美元）", type: "number", default: 100 },
      ],
      steps: [{ tool: "okx.ticker", args: { inst_id: "${inst_id}" }, save_as: "tick" }],
      requires_approval_before_step: 1,
      final_step: {
        tool: "okx.spot_order",
        args: { inst_id: "${inst_id}", side: "${side}", amount_usd: "${amount_usd}" },
      },
    },
  },
  {
    id: "okx-perp",
    name: "OKX 永续做多/做空",
    provider: "OKX 交易所",
    description: "查行情 → 审批后在 OKX 市价开永续仓位（默认模拟盘，不动真钱）。",
    requiresConnection: "okx",
    doc: {
      name: "OKX 永续做多/做空",
      description: "查行情 → 审批后在 OKX 市价开永续仓位（默认模拟盘，不动真钱）。",
      params: [
        { key: "inst_id", label: "合约", type: "string", default: "BTC-USDT-SWAP" },
        { key: "side", label: "方向（long/short）", type: "string", default: "long" },
        { key: "amount_usd", label: "金额（美元）", type: "number", default: 100 },
      ],
      steps: [{ tool: "okx.ticker", args: { inst_id: "${inst_id}" }, save_as: "tick" }],
      requires_approval_before_step: 1,
      final_step: {
        tool: "okx.perp_order",
        args: { inst_id: "${inst_id}", side: "${side}", amount_usd: "${amount_usd}" },
      },
    },
  },
  {
    id: "okx-balance",
    name: "OKX 余额查询",
    provider: "OKX 交易所",
    description: "查询 OKX 账户余额（只读，默认模拟盘资产）。",
    requiresConnection: "okx",
    doc: {
      name: "OKX 余额查询",
      description: "查询 OKX 账户余额（只读，默认模拟盘资产）。",
      params: [{ key: "ccy", label: "币种（空为全部）", type: "string" }],
      steps: [{ tool: "okx.balance", args: { ccy: "${ccy}" }, save_as: "balance" }],
    },
  },
];
