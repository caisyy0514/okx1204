import { AIDecision, MarketDataCollection, AccountContext, CandleData } from "../types";
import { CONTRACT_VAL_ETH, STRATEGY_STAGES, INSTRUMENT_ID } from "../constants";

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
  const volWanShou = vol24h / 10000; 
  const oiValue = openInterest * CONTRACT_VAL_ETH * currentPrice;
  const turnoverRate = oiValue > 0 ? (vol24h / oiValue) * 100 : 0;

  // 趋势
  const ema20 = calcEMA(closes, 20);
  const macdData = calcMACD(closes);
  const macdSignalStr = macdData.hist > 0 ? "多头趋势 (MACD > Signal)" : "空头趋势 (MACD < Signal)";
  
  const boll = calcBollinger(closes, 20, 2);
  let bollPosStr = "中轨附近";
  if (currentPrice > boll.upper) bollPosStr = "突破上轨 (超买/强势)";
  else if (currentPrice < boll.lower) bollPosStr = "跌破下轨 (超卖/弱势)";
  else if (currentPrice > boll.mid) bollPosStr = "中轨上方 (偏多)";
  else bollPosStr = "中轨下方 (偏空)";

  // 振荡
  const rsi14 = calcRSI(closes, 14);
  const kdj = calcKDJ(highs, lows, closes, 9);
  let kdjSignalStr = "观望";
  if (kdj.k > 80) kdjSignalStr = "超买 (死叉预警)";
  else if (kdj.k < 20) kdjSignalStr = "超卖 (金叉预警)";
  else if (kdj.k > kdj.d) kdjSignalStr = "金叉向上";
  else kdjSignalStr = "死叉向下";

  // 量能
  const vma5 = calcSMA(volumes, 5);
  const vma10 = calcSMA(volumes, 10);
  const volRatio = vma5 > 0 ? volumes[volumes.length - 1] / vma5 : 1;
  const volRatioStr = volRatio.toFixed(2);

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
  let feeEstimated = 0;
  let posDetails = {};
  
  if (hasPosition) {
      const p = primaryPosition!;
      const sizeEth = parseFloat(p.pos) * CONTRACT_VAL_ETH;
      const entryPrice = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      
      // Calculate Fees: Opening Fee (paid) + Closing Fee (Estimated)
      // Approx: Size * Price * FeeRate * 2
      feeEstimated = sizeEth * entryPrice * TAKER_FEE_RATE + sizeEth * currentPrice * TAKER_FEE_RATE;
      
      // Net Profit = Floating PnL - Fees
      netPnL = upl - feeEstimated;

      // Breakeven Calculation
      // Long: Entry * (1 + 2 * FeeRate)
      // Short: Entry * (1 - 2 * FeeRate)
      if (p.posSide === 'long') {
          breakevenPrice = entryPrice * (1 + 2 * TAKER_FEE_RATE);
      } else {
          breakevenPrice = entryPrice * (1 - 2 * TAKER_FEE_RATE);
      }

      positionContext = `
      方向: ${p.posSide.toUpperCase()}
      持仓量: ${p.pos} 张
      开仓均价: ${entryPrice.toFixed(2)}
      当前市价: ${currentPrice.toFixed(2)}
      
      【盈亏分析】:
      浮动盈亏 (UPL): ${upl.toFixed(2)} U
      预估双边手续费: ${feeEstimated.toFixed(2)} U
      净利润 (Net PnL): ${netPnL.toFixed(2)} U
      
      【核心锚点】:
      保本价格 (Breakeven): ${breakevenPrice.toFixed(2)} (必须守住此线!)
      当前止损 (Current SL): ${p.slTriggerPx || "未设置"}
      当前止盈 (Current TP): ${p.tpTriggerPx || "未设置"}
      `;
      
      posDetails = {
          side: p.posSide,
          entry: entryPrice,
          breakeven: breakevenPrice,
          currentSL: parseFloat(p.slTriggerPx || "0"),
          netPnL: netPnL
      };
  }

  // --- 4. 构建 Prompt (Rich Format with 9 Rules) ---
  
  const marketDataBlock = `
价格: ${currentPrice.toFixed(2)}
波动: ${dailyChange.toFixed(2)}%
MACD: ${macdSignalStr}
RSI: ${rsi14.toFixed(2)}
KDJ: ${kdjSignalStr}
布林: ${bollPosStr} (Up:${boll.upper.toFixed(2)}, Mid:${boll.mid.toFixed(2)}, Low:${boll.lower.toFixed(2)})
`;

  const systemPrompt = `
你是一名精通 **ETH 合约移动止盈止损策略** 的风控专家。
你的核心目标是 **净利润最大化** (Net Profit Maximization)。

**当前环境**:
- 阶段: ${stageName} (杠杆 ${currentStageParams.leverage}x)
- 可用余额: ${availableEquity.toFixed(2)} U
- 市场状态: ${marketDataBlock}

**持仓状态**:
${positionContext}

---

**核心策略规则 (Strict Rules)**:

1. **移动止损 (Ratchet Mechanism)**:
   - 止损价 (SL) 采用棘轮机制：**只向利润更高的方向移动**。
   - 如果当前持仓是 LONG，新 SL 必须 >= 旧 SL (除非旧 SL 为 0)。严禁降低 SL 导致利润回吐。
   - 如果当前持仓是 SHORT，新 SL 必须 <= 旧 SL (除非旧 SL 为 0)。

2. **保本锚点 (Breakeven Anchor - PRIORITY #1)**:
   - 如果当前价格已明显脱离成本区 (例如 Long 时 Price > Breakeven + 0.3%)，且当前 SL 仍处于亏损区：
   - **必须** 将 SL 移动到 **Breakeven Price** (保本价) 之上。这是首要任务！

3. **趋势探索 (Trailing Take Profit)**:
   - 不要设置固定的止盈价 (TP) 限制上涨空间，除非遇到强阻力位。
   - 使用移动 SL 来跟随趋势，尽可能吃完整个波段。

4. **补仓机制 (DCA - Cost Averaging)**:
   - 仅在 **风险可控** (仓位轻、有支撑位) 且 **逻辑未破坏** (只是短期波动) 时允许补仓摊低成本。
   - 如果判定为趋势反转，严禁补仓，必须止损。

5. **金字塔加仓 (Pyramiding)**:
   - 当 **净利润 > 0** 且趋势强劲 (MACD张口扩大、突破新高) 时，允许加仓 (Buy/Sell) 以放大收益。

6. **净利润计算**:
   - 决策必须基于 **Net PnL** (扣除手续费后的利润)。不要被未扣费的 UPL 误导。

7. **容忍度 (Volatility Filter)**:
   - 在寻找调整 SL 时机时，允许一定程度的浮动亏损（Technical Stop），以免被微小噪音扫出局。
   - 但一旦进入盈利区，容忍度应迅速降低，转为利润保护模式。

**输出指令 (Action Guide)**:
- **UPDATE_TPSL**: 仅调整 SL/TP，不增减仓位。用于保护利润或设置初始止损。
- **BUY / SELL**: 
   - 如已有持仓且方向相同 -> 代表 **加仓/补仓** (DCA or Pyramid)。
   - 如无持仓 -> 代表 **开仓**。
- **CLOSE**: 清仓止盈或止损。
- **HOLD**: 维持现状。

请根据以上规则，结合技术指标，生成 JSON 决策。
如果建议 UPDATE_TPSL，必须给出具体的 stop_loss 价格。
`;

  const responseSchema = `
  {
    "stage_analysis": "简述资金与阶段...",
    "hot_events_overview": "...",
    "market_assessment": "...",
    "eth_analysis": "...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "如加仓填具体数量(张)，如仅调SL填0",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "建议的硬止盈(可选，一般留空靠移动止损)",
      "stop_loss": "严格计算后的止损价",
      "invalidation_condition": "..."
    },
    "reasoning": "详细说明：是否触发保本？是否触发棘轮移动？计算净利润了吗？"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: `基于上述规则 (Net PnL: ${netPnL.toFixed(2)} U)，给出最佳操作。` }
    ]);

    if (!text) throw new Error("AI 返回为空");

    // Parse JSON
    let decision: AIDecision;
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        decision = JSON.parse(cleanText);
    } catch (e) {
        console.error("JSON Parse Failed:", text);
        throw new Error("AI 返回格式错误");
    }

    // --- Post-Processing & Safety Checks ---
    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    // Safety Check: Ratchet Mechanism (Double Check AI Logic)
    if (decision.action === 'UPDATE_TPSL' && hasPosition) {
        const p = primaryPosition!;
        const newSL = parseFloat(decision.trading_decision.stop_loss);
        const currentSL = parseFloat(p.slTriggerPx || "0");
        
        // Skip check if no new SL provided
        if (!isNaN(newSL) && newSL > 0) {
            if (p.posSide === 'long' && currentSL > 0) {
                if (newSL < currentSL) {
                    console.warn(`[Risk Guard] AI 试图降低多单止损 (${currentSL} -> ${newSL})，已拦截。维持 HOLD。`);
                    decision.action = 'HOLD';
                    decision.reasoning += " [系统拦截: 违反棘轮原则，禁止降低多单止损]";
                }
            } else if (p.posSide === 'short' && currentSL > 0) {
                if (newSL > currentSL) {
                    console.warn(`[Risk Guard] AI 试图提高空单止损 (${currentSL} -> ${newSL})，已拦截。维持 HOLD。`);
                    decision.action = 'HOLD';
                    decision.reasoning += " [系统拦截: 违反棘轮原则，禁止提高空单止损]";
                }
            }
        }
    }

    // Standard sizing logic for OPEN/ADD positions
    const leverage = parseFloat(decision.trading_decision.leverage);
    const confidence = parseFloat(decision.trading_decision.confidence) || 50;
    const safeLeverage = isNaN(leverage) ? currentStageParams.leverage : leverage;
    
    // Recalculate size if AI wants to BUY/SELL
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        // If adding position (Pyramid/DCA), use conservative sizing
        const isAdding = hasPosition;
        const riskFactor = isAdding ? 0.2 : currentStageParams.risk_factor; // Add only small portions

        let targetMargin = availableEquity * riskFactor * (confidence / 100);
        const maxSafeMargin = availableEquity * 0.95; 
        let finalMargin = Math.min(targetMargin, maxSafeMargin);

        const MIN_OPEN_VALUE = 100;
        let positionValue = finalMargin * safeLeverage;

        // Auto-fix for small accounts in Stage 1
        if (!isAdding && positionValue < MIN_OPEN_VALUE && availableEquity * 0.9 * safeLeverage > MIN_OPEN_VALUE) {
             if (confidence >= 40) {
                 finalMargin = MIN_OPEN_VALUE / safeLeverage;
                 positionValue = MIN_OPEN_VALUE;
            }
        }

        if (positionValue < MIN_OPEN_VALUE && !isAdding) {
             // If opening new, must meet min requirement. If adding, maybe smaller is ok? 
             // OKX min size is usually 1 contract (0.1 ETH ~ $300). 
             // Let's stick to contract check.
        }

        const numContractsRaw = positionValue / (CONTRACT_VAL_ETH * currentPrice);
        let numContracts = Math.floor(numContractsRaw * 100) / 100;
        
        // Override with AI suggestion if AI provided specific specific small size for adding
        const aiSuggestedSize = parseFloat(decision.trading_decision.position_size);
        if (isAdding && !isNaN(aiSuggestedSize) && aiSuggestedSize > 0) {
            numContracts = aiSuggestedSize;
        }

        if (numContracts < 0.01) {
            if (!hasPosition) {
                decision.action = 'HOLD';
                decision.size = "0";
            }
        } else {
            decision.size = numContracts.toFixed(2);
            decision.leverage = safeLeverage.toString();
        }
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
