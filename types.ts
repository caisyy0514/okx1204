
// OKX Data Types
export interface TickerData {
  instId: string;
  last: string;
  lastSz: string;
  askPx: string;
  bidPx: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  ts: string;
}

export interface CandleData {
  ts: string;
  o: string;
  h: string;
  l: string;
  c: string;
  vol: string;
}

export interface AccountBalance {
  totalEq: string; // Total Equity
  availEq: string; // Available Equity
  uTime: string;
}

export interface PositionData {
  instId: string;
  posSide: 'long' | 'short' | 'net';
  pos: string; // Size
  avgPx: string; // Average Price
  breakEvenPx?: string; // NEW: Exchange provided Breakeven Price
  upl: string; // Unrealized PnL
  uplRatio: string; // PnL Ratio
  mgnMode: string; // 'isolated' or 'cross'
  margin: string; // Margin used
  liqPx: string; // Liquidation Price
  cTime: string;
  // New fields for protection
  slTriggerPx?: string;
  tpTriggerPx?: string;
}

// Wrapper for account data to support multiple positions
export interface AccountContext {
  balance: AccountBalance;
  positions: PositionData[];
  sharpeRatio?: number; // NEW: Performance Metric
}

export interface MarketDataCollection {
  ticker: TickerData | null;
  candles3m: CandleData[]; // NEW: For precise entry/exit signals
  candles5m: CandleData[];
  candles15m: CandleData[]; // Used for indicators
  candles1H: CandleData[]; // NEW: Used for EMA Trend Strategy
  fundingRate: string;
  openInterest: string;
  orderbook: any; 
  trades: any[];
}

// AI Decision Types - 10U God of War Structure
export interface AIDecision {
  stage_analysis: string;
  market_assessment: string;
  hot_events_overview: string; // NEW: Real-time internet search results
  eth_analysis: string;
  trading_decision: {
    action: 'buy' | 'sell' | 'hold' | 'close' | 'update_tpsl'; // Added update_tpsl
    confidence: string; // "0-100%"
    position_size: string; // e.g. "5U" or "0.50" (Contracts if parsed, but raw AI output is U)
    leverage: string;
    profit_target: string;
    stop_loss: string;
    invalidation_condition: string;
  };
  reasoning: string;
  
  // Internal fields added by app
  action: 'BUY' | 'SELL' | 'HOLD' | 'CLOSE' | 'UPDATE_TPSL'; // Normalized Uppercase
  size: string; // Calculated Contract Size for OKX
  leverage: string; // Normalized
  rollover_trigger?: string; // Derived or default
  timestamp?: number;
}

export interface SystemLog {
  id: string;
  timestamp: Date;
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'TRADE';
  message: string;
}

export interface AppConfig {
  okxApiKey: string;
  okxSecretKey: string;
  okxPassphrase: string;
  deepseekApiKey: string; // Renamed from geminiApiKey
  isSimulation: boolean;
}
