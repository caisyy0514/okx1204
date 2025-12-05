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
                temperature: 1.0, // 降低一点温度，使逻辑更严谨
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
  if (kdj.k > 80 && kdj.d > 80) kdjSignalStr = "超买 (死叉预警)";
  else if (kdj.k < 20 && kdj.d < 20) kdjSignalStr = "超卖 (金叉预警)";
  else if (kdj.k > kdj.d) kdjSignalStr = "金叉向上";
  else kdjSignalStr = "死叉向下";

  // 量能
  const vma5 = calcSMA(volumes, 5);
  const vma10 = calcSMA(volumes, 10);
  const volRatio = vma5 > 0 ? volumes[volumes.length - 1] / vma5 : 1;
  const volRatioStr = volRatio.toFixed(2);

  // --- 3. 账户与阶段 ---
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
  
  let stageName = "";
  let currentStageParams = null;
  let stagePromptAddition = "";

  if (totalEquity < 20) {
      stageName = STRATEGY_STAGES.STAGE_1.name;
      currentStageParams = STRATEGY_STAGES.STAGE_1;
      stagePromptAddition = "【起步搏杀阶段】当前资金较少，允许 **高风险高收益** 操作。如果出现确定性机会，允许重仓。**但必须严守移动止损以保护本金。**";
  } else if (totalEquity < 80) {
      stageName = STRATEGY_STAGES.STAGE_2.name;
      currentStageParams = STRATEGY_STAGES.STAGE_2;
      stagePromptAddition = "【资金积累阶段】风险偏好中等，追求稳健增长，注重回撤控制，使用 trailing stop 锁定利润。";
  } else {
      stageName = STRATEGY_STAGES.STAGE_3.name;
      currentStageParams = STRATEGY_STAGES.STAGE_3;
      stagePromptAddition = "【稳健盈利阶段】低风险偏好，保本第一。";
  }

  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  let positionStr = "当前无持仓 (Empty)";
  let avgPx = 0;
  let uplRatio = 0;
  let upl = 0;
  
  // Dynamic SL Levels Calculation
  let breakEvenPrice = 0;
  let lockProfitPrice_Level1 = 0; // Lock small profit
  let lockProfitPrice_Level2 = 0; // Lock big profit
  
  if (hasPosition) {
      const p = primaryPosition!;
      avgPx = parseFloat(p.avgPx);
      upl = parseFloat(p.upl);
      uplRatio = parseFloat(p.uplRatio) * 100;
      
      const isLong = p.posSide === 'long';
      // Fee estimation ~0.15% round trip
      const feeBuffer = avgPx * 0.0015; 

      if (isLong) {
          breakEvenPrice = avgPx + feeBuffer; // Price must go UP to break even
          // If price moves up 2%, lock 1% profit
          lockProfitPrice_Level1 = avgPx + (currentPrice - avgPx) * 0.5; 
          // If price moves up 5%, lock 3.5% profit
          lockProfitPrice_Level2 = currentPrice - (avgPx * 0.015); // Trail closely
      } else {
          breakEvenPrice = avgPx - feeBuffer; // Price must go DOWN to break even
          lockProfitPrice_Level1 = avgPx - (avgPx - currentPrice) * 0.5;
          lockProfitPrice_Level2 = currentPrice + (avgPx * 0.015);
      }

      positionStr = `
      持有: ${p.posSide.toUpperCase()} ${p.pos}张
      开仓均价: ${p.avgPx}
      当前价格: ${currentPrice}
      收益率: ${uplRatio.toFixed(2)}% (未结: ${p.upl} U)
      ----------------------------------------
      【系统计算参考值】
      1. 预估保本价 (Break-Even): ${breakEvenPrice.toFixed(2)}
      2. 推荐锁利价 (若收益>2%): ${lockProfitPrice_Level1.toFixed(2)}
      3. 推荐锁利价 (若收益>5%): ${lockProfitPrice_Level2.toFixed(2)}
      ----------------------------------------
      当前生效止损 (SL): ${p.slTriggerPx || "⚠️未设置"}
      当前生效止盈 (TP): ${p.tpTriggerPx || "⚠️未设置"}
      `;
  }

  // --- 4. 构建 Prompt (Rich Format) ---
  
  const marketDataBlock = `
价格数据:
- 收盘价：${currentPrice.toFixed(2)}
- 日内波动率：${dailyChange.toFixed(2)}%
- 成交量：${volWanShou.toFixed(0)}万 (24H Value)
- 市场活跃度(换手率)：${turnoverRate.toFixed(2)}%

技术面数据 (15m):
趋势指标:
- MACD信号：${macdSignalStr} (Diff: ${macdData.macd.toFixed(2)})
- 布林带：${bollPosStr} (Up: ${boll.upper.toFixed(2)}, Low: ${boll.lower.toFixed(2)})

超买超卖:
- RSI(14)：${rsi14.toFixed(2)}
- KDJ信号：${kdjSignalStr} (K:${kdj.k.toFixed(1)}, D:${kdj.d.toFixed(1)})

量能:
- 量比：${volRatioStr} (当前Vol / MA5)
`;

  const systemPrompt = `
你是一名专注于ETH合约的 **超短线战神策略交易员**。
你拥有全面的市场数据，并具备 **实时联网搜索能力 (Real-Time Web Search)**。

**一、全面行情分析数据**:
${marketDataBlock}

**二、当前账户状态**:
- **阶段**: ${stageName}
- **策略偏好**: ${stagePromptAddition}
- **余额**: ${availableEquity.toFixed(2)} U
- **持仓状态**: ${positionStr}

**三、核心决策指令 (HIGHEST PRIORITY: PROFIT LADDER PROTECTION)**:

1. **阶梯式止盈与浮亏容忍 (Ladder Trailing Stop Logic)**:
   请严格根据当前的 **收益率 (ROI)** 决定止损调整策略：

   *   **阶段 A: 浮亏或微利期 (ROI < 0.6%)**: 
       - **策略**: **容忍波动**。不要急于将止损移至保本价，以免被正常震荡扫出。
       - **动作**: 保持初始止损 (HOLD)，除非技术形态完全破位。

   *   **阶段 B: 保本期 (0.6% <= ROI < 2%)**:
       - **策略**: **本金安全第一**。利润已覆盖手续费。
       - **动作**: 立即执行 **UPDATE_TPSL**，将止损上移至 **预估保本价** (Break-Even) 附近。

   *   **阶段 C: 利润增长期 (2% <= ROI < 5%)**:
       - **策略**: **锁定部分利润**。
       - **动作**: 执行 **UPDATE_TPSL**，将止损上移至 **推荐锁利价 Level 1** (锁定约 50% 的浮盈)。

   *   **阶段 D: 利润收割期 (ROI >= 5%)**:
       - **策略**: **紧跟趋势 (Tight Trail)**。防止大幅回撤。
       - **动作**: 执行 **UPDATE_TPSL**，将止损上移至 **推荐锁利价 Level 2** (锁定约 80% 的浮盈)。

   *   **注意**: 止损价格只能 **更有利于盈利** 的方向移动 (单向棘轮)，严禁回调止损线（严禁扛单）。

2. **实时联网搜索 (ONLINE SEARCH)**:
   - **指令**: 立即搜索全网 Crypto 热点 (6h/24h)。
   - **禁止模拟**: 必须基于真实数据。

3. **技术面研判**:
   - 关注量价背离和共振信号。

4. **交易执行**:
   - **Action**: BUY / SELL / HOLD / CLOSE / UPDATE_TPSL
   - **Update TPSL**: 保护利润时使用。
   - **Stop Loss 必填**: 开新仓必须带止损。

请生成纯净的 JSON 格式交易决策。
`;

  const responseSchema = `
  {
    "stage_analysis": "...",
    "hot_events_overview": "【联网搜索结果】...",
    "market_assessment": "...",
    "eth_analysis": "...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "动态计算",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "价格 (TP, 2位小数)",
      "stop_loss": "价格 (SL, 2位小数 - 重点关注此字段，执行阶梯止盈)",
      "invalidation_condition": "..."
    },
    "reasoning": "..."
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY, NO MARKDOWN:\n" + responseSchema },
        { role: "user", content: "请调用你的搜索能力获取实时数据，并根据【阶梯式止盈逻辑】检查是否需要调整止损。" }
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

    // --- Post-Processing & Validation ---
    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    const leverage = parseFloat(decision.trading_decision.leverage);
    const confidence = parseFloat(decision.trading_decision.confidence) || 50;
    const safeLeverage = isNaN(leverage) ? currentStageParams.leverage : leverage;
    
    // Robust Sizing Logic
    let targetMargin = availableEquity * currentStageParams.risk_factor * (confidence / 100);
    const maxSafeMargin = availableEquity * 0.95; 
    let finalMargin = Math.min(targetMargin, maxSafeMargin);

    const MIN_OPEN_VALUE = 100;
    let positionValue = finalMargin * safeLeverage;

    // 自动修正逻辑：如果钱不够 100U 名义价值，但属于 Stage 1 且置信度高，尝试用最大余额
    if (positionValue < MIN_OPEN_VALUE && availableEquity * 0.9 * safeLeverage > MIN_OPEN_VALUE) {
        if (confidence >= 40) {
             finalMargin = MIN_OPEN_VALUE / safeLeverage;
             positionValue = MIN_OPEN_VALUE;
             console.log(`[AI] 仓位自动修正: 提升至最小名义价值 ${MIN_OPEN_VALUE} USDT`);
        }
    }

    if (decision.action === 'BUY' || decision.action === 'SELL') {
        if (positionValue < MIN_OPEN_VALUE) {
             console.warn(`[AI] 仓位价值过小 (${positionValue.toFixed(2)} U)，转为 HOLD`);
             decision.action = 'HOLD';
             decision.size = "0";
             decision.reasoning += ` [系统修正: 资金不足以满足最小开仓门槛]`;
        } else {
            const numContractsRaw = positionValue / (CONTRACT_VAL_ETH * currentPrice);
            const numContracts = Math.floor(numContractsRaw * 100) / 100;
            if (numContracts < 0.01) {
                decision.action = 'HOLD';
                decision.size = "0";
            } else {
                decision.size = numContracts.toFixed(2);
                decision.leverage = safeLeverage.toString();
            }
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
            action: 'hold' as any,
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
