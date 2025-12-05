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
  
  // Dynamic SL Levels Calculation based on Net PnL (Amount)
  let safeBreakEvenPrice = 0;
  let recommendedSL = 0;
  let profitLockStage = "A: 观察/浮亏期";
  let netPnL = 0;
  let netROI = 0;
  
  if (hasPosition) {
      const p = primaryPosition!;
      avgPx = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      const posSize = parseFloat(p.pos);
      const margin = parseFloat(p.margin);
      const isLong = p.posSide === 'long';
      
      // 1. 计算实际净收益 (Net PnL)
      // 估算双边手续费 (Estimated Fees): 市值 * 0.12% (保守估计, OKX Taker ~0.05% x2 = 0.1%)
      const positionValue = posSize * CONTRACT_VAL_ETH * currentPrice;
      const estimatedFee = positionValue * 0.0012; // 0.12%
      netPnL = upl - estimatedFee;
      
      // 计算净收益率 (Net ROI based on Margin)
      netROI = margin > 0 ? (netPnL / margin) * 100 : 0;

      // 2. 获取或计算交易所保本价
      let rawBreakEven = p.breakEvenPx ? parseFloat(p.breakEvenPx) : 0;
      if (rawBreakEven === 0) {
          // Fallback: Entry +/- 0.12% fee impact
          rawBreakEven = isLong ? avgPx * 1.0012 : avgPx * 0.9988;
      }
      safeBreakEvenPrice = rawBreakEven;

      // 3. 利润阶段判断 (基于实际净收益 Net ROI)
      // Stage A: Net PnL <= 0 (Friction Zone)
      // Stage B: Net PnL > 0 (Break-Even Zone)
      // Stage C: Net ROI > 10% (Lock 50% Profit)
      // Stage D: Net ROI > 30% (Lock 80% Profit)

      const buffer = currentPrice * 0.002; // 0.2% price buffer for execution safety

      if (netPnL <= 0) {
          profitLockStage = "A: 浮亏或磨损期 (保持原止损)";
          recommendedSL = 0; // Don't change
      } else if (netPnL > 0 && netROI < 10) {
          profitLockStage = "B: 微利保本期 (Break-Even)";
          recommendedSL = safeBreakEvenPrice;
      } else if (netROI >= 10 && netROI < 30) {
          profitLockStage = "C: 利润增长期 (Lock 50%)";
          const profitDiff = Math.abs(currentPrice - avgPx);
          // Lock entry + 50% of the run
          recommendedSL = isLong 
              ? avgPx + (profitDiff * 0.5) 
              : avgPx - (profitDiff * 0.5);
      } else {
          profitLockStage = "D: 丰厚利润期 (Lock 80%)";
          const profitDiff = Math.abs(currentPrice - avgPx);
          // Lock entry + 80% of the run
          recommendedSL = isLong 
              ? avgPx + (profitDiff * 0.8) 
              : avgPx - (profitDiff * 0.8);
      }

      // 4. 棘轮效应 (Ratchet Logic) - 禁止反向移动止损
      const currentSL = p.slTriggerPx ? parseFloat(p.slTriggerPx) : 0;
      
      // 如果计算出了推荐止损
      if (recommendedSL > 0) {
          // 安全性修正：防止挂单太近
          if (isLong) {
               if (recommendedSL > currentPrice - buffer) recommendedSL = currentPrice - buffer;
               // 核心逻辑：如果不比当前止损好，就保持当前的（不回撤）
               if (currentSL > 0 && recommendedSL < currentSL) {
                   recommendedSL = currentSL; 
                   profitLockStage += " [维持更优旧止损]";
               }
          } else { // Short
               if (recommendedSL < currentPrice + buffer) recommendedSL = currentPrice + buffer;
               // 核心逻辑：如果不比当前止损好，就保持当前的（不回撤）
               if (currentSL > 0 && recommendedSL > currentSL) {
                   recommendedSL = currentSL;
                   profitLockStage += " [维持更优旧止损]";
               }
          }
      }

      positionStr = `
      持有: ${p.posSide.toUpperCase()} ${p.pos}张
      开仓均价: ${p.avgPx} | 当前价格: ${currentPrice}
      ----------------------------------------
      【实际收益分析 (已扣除双边手续费)】
      * 未结盈亏 (UPL): ${upl.toFixed(2)} U
      * 估算手续费: ${estimatedFee.toFixed(2)} U
      * 净盈亏 (Net PnL): ${netPnL.toFixed(2)} U (${netROI.toFixed(2)}% ROI)
      ----------------------------------------
      【利润保护策略】
      * 交易所保本价: ${safeBreakEvenPrice.toFixed(2)}
      * 当前阶段: ${profitLockStage}
      * 推荐新止损: ${recommendedSL > 0 ? recommendedSL.toFixed(2) : "无 (保持原样)"}
      ----------------------------------------
      当前生效止损 (SL): ${p.slTriggerPx || "⚠️未设置"}
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

**三、核心决策指令 (HIGHEST PRIORITY: REAL NET PROFIT PROTECTION)**:

1. **基于净盈亏的利润保护 (Net PnL Protection)**:
   - **判断依据**: 请严格基于【实际收益分析】中的 **净盈亏 (Net PnL)** 进行判断，忽略单纯的 UPL。
   - **棘轮规则 (Anti-Reverse)**: 已经锁定的利润（止损位）**严禁回调**。除非是止损被打掉，否则绝不将止损位向亏损方向移动。
   - **操作指令**: 
     - 如果推荐新止损 (recommendedSL) 与 当前生效止损 (SL) **不同**，且推荐值 **更优**（更贴近现价但保持安全距离），请立即执行 **UPDATE_TPSL**。
     - 如果净盈亏 <= 0 (浮亏或磨损)，**保持耐心**，不要随意移动止损，除非技术破位。

2. **实时联网搜索 (ONLINE SEARCH)**:
   - **指令**: 立即搜索全网 Crypto 热点 (6h/24h)。
   - **禁止模拟**: 必须基于真实数据。

3. **交易执行**:
   - **Action**: BUY / SELL / HOLD / CLOSE / UPDATE_TPSL
   - **Update TPSL**: 仅在需要调整止损以锁定更多利润时使用。
   - **Stop Loss**: 
      - 如果是 UPDATE_TPSL，请直接填入【系统计算参考值】中的 **推荐新止损**。
      - 如果是开新仓，必须填入初始止损。

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
      "stop_loss": "价格 (SL, 2位小数 - 请优先采用推荐值，严禁反向回调)",
      "invalidation_condition": "..."
    },
    "reasoning": "..."
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY, NO MARKDOWN:\n" + responseSchema },
        { role: "user", content: "请调用你的搜索能力获取实时数据，并根据【净盈亏】和【棘轮止损原则】检查是否需要调整止损。" }
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
