
import { AIDecision, MarketDataCollection, AccountContext, CandleData } from "../types";
import { CONTRACT_VAL_ETH, STRATEGY_STAGES, INSTRUMENT_ID, TAKER_FEE_RATE } from "../constants";

// --- Technical Indicator Helpers ---

// Simple Moving Average
const calcSMA = (data: number[], period: number): number => {
  if (data.length < period) return 0;
  const slice = data.slice(data.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
};

// Standard Deviation
const calcStdDev = (data: number[], period: number): number => {
  if (data.length < period) return 0;
  const sma = calcSMA(data, period);
  const slice = data.slice(data.length - period);
  const squaredDiffs = slice.map(x => Math.pow(x - sma, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(avgSquaredDiff);
};

// RSI
const calcRSI = (prices: number[], period: number = 14): number => {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  // Calculate initial average
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothing
  for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

// EMA
const calcEMA = (prices: number[], period: number): number => {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
};

// MACD
const calcMACD = (prices: number[]) => {
  const shortPeriod = 12;
  const longPeriod = 26;
  const signalPeriod = 9;
  
  if (prices.length < longPeriod) return { macd: 0, signal: 0, hist: 0 };
  
  // Calculate EMA12 and EMA26 arrays to get MACD line array
  // Simplified: Just calculating the *latest* values for prompt
  const ema12 = calcEMA(prices.slice(-shortPeriod * 2), shortPeriod); 
  const ema26 = calcEMA(prices.slice(-longPeriod * 2), longPeriod);
  
  const macdLine = ema12 - ema26;
  const signalLine = macdLine * 0.8; 
  
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
};

// Bollinger Bands
const calcBollinger = (prices: number[], period: number = 20, multiplier: number = 2) => {
    const mid = calcSMA(prices, period);
    const std = calcStdDev(prices, period);
    return {
        upper: mid + multiplier * std,
        mid: mid,
        lower: mid - multiplier * std
    };
};

// KDJ
const calcKDJ = (highs: number[], lows: number[], closes: number[], period: number = 9) => {
    let k = 50, d = 50, j = 50;
    
    // We iterate through the data to smooth K and D
    // Starting from index 'period'
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) continue;
        
        // Find Highest High and Lowest Low in last 9 periods
        let localLow = lows[i];
        let localHigh = highs[i];
        for (let x = 0; x < period; x++) {
             if (lows[i-x] < localLow) localLow = lows[i-x];
             if (highs[i-x] > localHigh) localHigh = highs[i-x];
        }
        
        const rsv = (localHigh === localLow) ? 50 : ((closes[i] - localLow) / (localHigh - localLow)) * 100;
        
        k = (2/3) * k + (1/3) * rsv;
        d = (2/3) * d + (1/3) * k;
        j = 3 * k - 2 * d;
    }
    return { k, d, j };
};

// --- DeepSeek API Helper ---
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

const callDeepSeek = async (apiKey: string, messages: any[]) => {
    const cleanKey = apiKey ? apiKey.trim() : "";
    if (!cleanKey) throw new Error("API Key 为空");
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(cleanKey)) {
        throw new Error("API Key 包含非法字符(中文或特殊符号)");
    }

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cleanKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: messages,
                stream: false,
                temperature: 1.0, 
                max_tokens: 4096,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`DeepSeek API Error: ${response.status} - ${errText}`);
        }

        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e: any) {
        throw new Error(e.message || "DeepSeek 请求失败");
    }
};

export const testConnection = async (apiKey: string): Promise<string> => {
  if (!apiKey) throw new Error("API Key 为空");
  try {
    const content = await callDeepSeek(apiKey, [
        { role: "user", content: "Please respond with a JSON object containing the message 'OK'." }
    ]);
    return content || "无响应内容";
  } catch (e: any) {
    throw new Error(e.message || "连接失败");
  }
};

// --- Main Decision Function ---

export const getTradingDecision = async (
  apiKey: string,
  marketData: MarketDataCollection,
  accountData: AccountContext
): Promise<AIDecision> => {
  if (!apiKey) throw new Error("请输入 DeepSeek API Key");

  // --- 1. 数据准备 (Data Prep) ---
  const currentPrice = parseFloat(marketData.ticker?.last || "0");
  const open24h = parseFloat(marketData.ticker?.open24h || "0");
  const vol24h = parseFloat(marketData.ticker?.volCcy24h || "0"); // USDT Volume
  const totalEquity = parseFloat(accountData.balance.totalEq);
  const availableEquity = parseFloat(accountData.balance.availEq);
  const openInterest = parseFloat(marketData.openInterest || "1"); 

  // K-Line Data Arrays
  const candles = marketData.candles15m || [];
  const closes = candles.map(c => parseFloat(c.c));
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  const volumes = candles.map(c => parseFloat(c.vol));

  // --- 2. 指标计算 (Indicators) ---
  const dailyChange = open24h > 0 ? ((currentPrice - open24h) / open24h) * 100 : 0;
  
  // Trend & Momentum
  const macdData = calcMACD(closes);
  const macdSignalStr = macdData.hist > 0 ? "多头趋势 (MACD > Signal)" : "空头趋势 (MACD < Signal)";
  
  const boll = calcBollinger(closes, 20, 2);
  let bollPosStr = "中轨附近";
  if (currentPrice > boll.upper) bollPosStr = "突破上轨 (超买/强势)";
  else if (currentPrice < boll.lower) bollPosStr = "跌破下轨 (超卖/弱势)";
  else if (currentPrice > boll.mid) bollPosStr = "中轨上方 (偏多)";
  else bollPosStr = "中轨下方 (偏空)";

  const rsi14 = calcRSI(closes, 14);
  const kdj = calcKDJ(highs, lows, closes, 9);
  let kdjSignalStr = "观望";
  if (kdj.k > 80 && kdj.d > 80) kdjSignalStr = "超买 (死叉预警)";
  else if (kdj.k < 20 && kdj.d < 20) kdjSignalStr = "超卖 (金叉预警)";
  else if (kdj.k > kdj.d) kdjSignalStr = "金叉向上";
  else kdjSignalStr = "死叉向下";

  // --- 3. 核心：持仓分析与利润保护计算 (Advanced Position Analysis) ---
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
  
  let stageName = "";
  let currentStageParams = null;

  if (totalEquity < 20) {
      stageName = STRATEGY_STAGES.STAGE_1.name;
      currentStageParams = STRATEGY_STAGES.STAGE_1;
  } else if (totalEquity < 80) {
      stageName = STRATEGY_STAGES.STAGE_2.name;
      currentStageParams = STRATEGY_STAGES.STAGE_2;
  } else {
      stageName = STRATEGY_STAGES.STAGE_3.name;
      currentStageParams = STRATEGY_STAGES.STAGE_3;
  }

  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  let positionContext = "当前无持仓";
  let breakevenPrice = 0;
  let netPnL = 0;
  let estimatedTotalFees = 0;
  
  if (hasPosition) {
      const p = primaryPosition!;
      const sizeContracts = parseFloat(p.pos);
      const sizeCoin = sizeContracts * CONTRACT_VAL_ETH;
      const entryPrice = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      
      // Strict Breakeven Calculation (Considering Opening + Closing Fees)
      // Formula: Breakeven = Entry * (1 + Fee) / (1 - Fee) for Long
      // Formula: Breakeven = Entry * (1 - Fee) / (1 + Fee) for Short
      if (p.posSide === 'long') {
          breakevenPrice = entryPrice * (1 + TAKER_FEE_RATE) / (1 - TAKER_FEE_RATE);
      } else {
          breakevenPrice = entryPrice * (1 - TAKER_FEE_RATE) / (1 + TAKER_FEE_RATE);
      }
      
      // Calculate Real Net PnL (Floating PnL - Estimated Closing Fee - Estimated Opening Fee)
      // Note: UPL from exchange usually excludes fees. We must ensure we cover costs.
      const currentVal = sizeCoin * currentPrice;
      const entryVal = sizeCoin * entryPrice;
      estimatedTotalFees = (currentVal * TAKER_FEE_RATE) + (entryVal * TAKER_FEE_RATE);
      
      netPnL = upl - estimatedTotalFees;

      positionContext = `
      === 持仓详情 ===
      方向: ${p.posSide.toUpperCase()}
      持仓量: ${p.pos} 张 (${sizeCoin.toFixed(2)} ETH)
      开仓均价: ${entryPrice.toFixed(2)}
      当前市价: ${currentPrice.toFixed(2)}
      
      === 盈亏分析 (Net Profit) ===
      浮动盈亏 (UPL): ${upl.toFixed(2)} U
      预估双边手续费: ${estimatedTotalFees.toFixed(2)} U
      【净利润】: ${netPnL.toFixed(2)} U  <-- 决策核心依据
      
      === 保护锚点 ===
      【盈亏平衡价 (Breakeven)】: ${breakevenPrice.toFixed(2)} (含手续费)
      当前止损 (SL): ${p.slTriggerPx || "未设置"}
      当前止盈 (TP): ${p.tpTriggerPx || "未设置 (建议不设，用移动止损)"}
      `;
  }

  // --- 4. 构建 Prompt (Refined 9 Rules) ---
  
  const marketDataBlock = `
价格: ${currentPrice.toFixed(2)}
波动: ${dailyChange.toFixed(2)}%
MACD: ${macdSignalStr}
RSI: ${rsi14.toFixed(2)}
KDJ: ${kdjSignalStr}
布林: ${bollPosStr}
`;

  const systemPrompt = `
你是一名精通 **ETH 合约交易** 专家。
你的首要任务是执行 **保护本金的情况下最大化盈利** 。

**当前环境**:
- 阶段: ${stageName} (杠杆 ${currentStageParams.leverage}x)
- 市场: ${marketDataBlock}

**持仓状态**:
${positionContext}

---

**核心决策十大军规 (The 10 Commandments)**:

1. **本金保护 (Capital Protection)**:
   - 使用 **棘轮机制 (Ratchet)** 移动止损：止损价 **只能向利润更高的方向移动**，严禁回调。
   - 如 Long: New SL >= Old SL。如 Short: New SL <= Old SL。

2. **锁定利润 (Lock-in Profit)**:
   - 当【净利润 (Net PnL) > 0】且价格脱离成本区时，必须将 SL 移动到 **Breakeven Price** 之上。
   - 这是优先级最高的任务：先保证不亏，再追求盈利。

3. **趋势上限探索 (Trend Exploration)**:
   - **不要设置硬止盈 (TP)** 限制收益上限，除非遇到极强阻力。
   - 使用 **移动止损 (Trailing SL)** 来跟随趋势，让利润奔跑，直到趋势反转触碰 SL 离场。

4. **补仓机制 (Smart DCA)**:
   - 触发条件：浮亏状态 + 触及关键支撑位 + 逻辑未破坏 + 风险可控 (Risk Controllable)。
   - 目的：摊低成本 (Average Down)。
   - 禁忌：趋势已反转或仓位过重时，严禁补仓，应直接止损。

5. **金字塔加仓 (Pyramiding)**:
   - 触发条件：【净利润 > 0】 + 趋势确认突破 + 风险可控。
   - 目的：捕捉本次交易的最大收益。
   - 原则：加仓部分应小于底仓 (倒金字塔是找死)。

6. **核心目标**:
   - 一切决策以 **净利润 (Net Profit)** 为核心。净利润 = 浮盈 - 双边手续费。

7. **波动容忍 (Volatility Filter)**:
   - 在寻找调整 SL 时机时（尤其是浮亏阶段），允许一定程度的 "呼吸空间" (Technical Stop)，以免被微小噪音扫损。
   - 但一旦进入盈利区，容忍度应迅速收紧。

8. **锚点战术 (Anchor Point)**:
   - 交易所的 **Breakeven Price** 是最重要的战场分界线。
   - 你的首要战术动作：确保 SL 尽快跨越 Breakeven 线。

9. **AI 动态风控**:
   - 一旦实现盈亏平衡 (SL > Breakeven)，由你根据市场热点、技术指标全权接管 SL 的移动节奏，最大化捕捉利润。
   
10. **实时联网搜索 (ONLINE SEARCH)**:
   - **指令**: 立即搜索全网 Crypto 热点 (6h/24h)。
   - **判断**: 根据热点事件给出决策建议。

**操作指令**:
- **UPDATE_TPSL**: 调整止损止盈 (最常用)。
- **BUY / SELL**: 开仓或加仓/补仓。
- **CLOSE**: 立即市价全平。
- **HOLD**: 暂时不动。

请输出 JSON 决策。如果建议 UPDATE_TPSL，必须给出明确的 \`stop_loss\` 数值。
`;

  const responseSchema = `
  {
    "stage_analysis": "简述...",
    "hot_events_overview": "...",
    "market_assessment": "...",
    "eth_analysis": "...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "数量(张), 仅在BUY/SELL时有效",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "建议留空或设极高",
      "stop_loss": "严格计算后的新SL (必须遵守棘轮机制)",
      "invalidation_condition": "..."
    },
    "reasoning": "解释是否触发棘轮？是否已移动至保本价之上？"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: `当前净利润: ${netPnL.toFixed(2)} U。请根据九大军规给出最佳操作。` }
    ]);

    if (!text) throw new Error("AI 返回为空");

    // Parse JSON
    let decision: AIDecision;
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        decision = JSON.parse(cleanText);
    } catch (e) {
        throw new Error("AI 返回格式错误");
    }

    // --- Post-Processing & Safety Checks ---
    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    // Safety Check: Ratchet Mechanism Enforcement (System Override)
    // 强制执行棘轮机制，防止 AI 幻觉导致止损变宽
    if (decision.action === 'UPDATE_TPSL' && hasPosition) {
        const p = primaryPosition!;
        const newSL = parseFloat(decision.trading_decision.stop_loss);
        const currentSL = parseFloat(p.slTriggerPx || "0");
        
        if (!isNaN(newSL) && newSL > 0 && currentSL > 0) {
            // Rule: Only move towards higher profit
            if (p.posSide === 'long') {
                if (newSL < currentSL) {
                    console.warn(`[Ratchet Guard] 拦截无效指令: 多单止损不能下移 (${currentSL} -> ${newSL})`);
                    decision.action = 'HOLD';
                    decision.reasoning += " [系统拦截: 违反棘轮机制，禁止降低多单止损]";
                }
            } else if (p.posSide === 'short') {
                if (newSL > currentSL) {
                    console.warn(`[Ratchet Guard] 拦截无效指令: 空单止损不能上移 (${currentSL} -> ${newSL})`);
                    decision.action = 'HOLD';
                    decision.reasoning += " [系统拦截: 违反棘轮机制，禁止提高空单止损]";
                }
            }
        }
    }

    // Standard sizing logic logic...
    const leverage = parseFloat(decision.trading_decision.leverage);
    const safeLeverage = isNaN(leverage) ? currentStageParams.leverage : leverage;
    
    // Auto-fix sizing for BUY/SELL
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        const isAdding = hasPosition; // DCA or Pyramiding
        const riskFactor = isAdding ? 0.3 : currentStageParams.risk_factor; // 加仓动作风险系数较低

        if (!decision.trading_decision.position_size || decision.trading_decision.position_size === "0") {
             const confidence = parseFloat(decision.trading_decision.confidence) || 50;
             const marginToUse = availableEquity * riskFactor * (confidence / 100);
             const posValue = marginToUse * safeLeverage;
             const contracts = posValue / (CONTRACT_VAL_ETH * currentPrice);
             decision.size = Math.max(contracts, 0.01).toFixed(2);
        } else {
             decision.size = decision.trading_decision.position_size;
        }
        decision.leverage = safeLeverage.toString();
    } else {
        decision.size = "0";
        decision.leverage = safeLeverage.toString();
    }

    return decision;

  } catch (error: any) {
    console.error("AI Decision Error:", error);
    return {
        stage_analysis: "AI Error",
        market_assessment: "Unknown",
        hot_events_overview: "N/A",
        eth_analysis: "N/A",
        trading_decision: {
            action: 'hold',
            confidence: "0%",
            position_size: "0",
            leverage: "0",
            profit_target: "0",
            stop_loss: "0",
            invalidation_condition: "Error"
        },
        reasoning: "System Error: " + error.message,
        action: 'HOLD',
        size: "0",
        leverage: "0"
    };
  }
};
