export const INSTRUMENT_ID = "ETH-USDT-SWAP";
// OKX V5 规范: ETH-USDT-SWAP 1张合约 = 0.1 ETH
// 注意: 实际交易前请核对 OKX 文档，部分币种为 0.01 或 10 USD
export const CONTRACT_VAL_ETH = 0.1;

export const DEFAULT_CONFIG = {
  okxApiKey: "",
  okxSecretKey: "",
  okxPassphrase: "",
  deepseekApiKey: "", 
  isSimulation: true, 
};

// 10U 战神策略阶段定义 (低风险版)
export const STRATEGY_STAGES = {
  STAGE_1: {
    name: "起步期 (稳健搏杀)", 
    max_equity: 20,
    leverage: 20, // 从 100x 降为 20x
    risk_factor: 0.8, 
    allow_pyramiding: true, 
    pyramid_condition: "profit_only",
    max_pos_ratio: 3.0, 
  },
  STAGE_2: {
    name: "滚仓期 (资金积累)",
    max_equity: 80,
    leverage: 10, // 从 50x 降为 10x
    risk_factor: 0.5, 
  },
  STAGE_3: {
    name: "稳健期 (模式转型)",
    min_equity: 80,
    leverage: 5, // 从 30x 降为 5x
    split_parts: 8, 
  }
};

export const MOCK_TICKER = {
  instId: INSTRUMENT_ID,
  last: "3250.50",
  lastSz: "1.2",
  askPx: "3250.60",
  bidPx: "3250.40",
  open24h: "3100.00",
  high24h: "3300.00",
  low24h: "3050.00",
  volCcy24h: "500000000",
  ts: Date.now().toString(),
};
