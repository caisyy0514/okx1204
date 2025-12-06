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

  // --- 1. 数据准备 ---
  const currentPrice = parseFloat(marketData.ticker?.last || "0");
  const open24h = parseFloat(marketData.ticker?.open24h || "0");
  const vol24h = parseFloat(marketData.ticker?.volCcy24h || "0");
  const totalEquity = parseFloat(accountData.balance.totalEq);
  const availableEquity = parseFloat(accountData.balance.availEq);
  const openInterest = parseFloat(marketData.openInterest || "1"); 

  const candles = marketData.candles15m || [];
  const closes = candles.map(c => parseFloat(c.c));
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  const volumes = candles.map(c => parseFloat(c.vol));

  // --- 2. 指标计算 ---
  const dailyChange = open24h > 0 ? ((currentPrice - open24h) / open24h) * 100 : 0;
  const volWanShou = vol24h / 10000; 
  const oiValue = openInterest * CONTRACT_VAL_ETH * currentPrice;
  const turnoverRate = oiValue > 0 ? (vol24h / oiValue) * 100 : 0;

  const ema20 = calcEMA(closes, 20);
  const macdData = calcMACD(closes);
  const macdSignalStr = macdData.hist > 0 ? "多头趋势" : "空头趋势";
  
  const boll = calcBollinger(closes, 20, 2);
  let bollPosStr = "中轨附近";
  if (currentPrice > boll.upper) bollPosStr = "突破上轨";
  else if (currentPrice < boll.lower) bollPosStr = "跌破下轨";
  else if (currentPrice > boll.mid) bollPosStr = "中轨上方";
  else bollPosStr = "中轨下方";

  const rsi14 = calcRSI(closes, 14);
  const kdj = calcKDJ(highs, lows, closes, 9);
  let kdjSignalStr = "观望";
  if (kdj.k > 80) kdjSignalStr = "超买";
  else if (kdj.k < 20) kdjSignalStr = "超卖";
  else if (kdj.k > kdj.d) kdjSignalStr = "金叉";
  else kdjSignalStr = "死叉";

  const vma5 = calcSMA(volumes, 5);
  const volRatio = vma5 > 0 ? volumes[volumes.length - 1] / vma5 : 1;
  const volRatioStr = volRatio.toFixed(2);

  // --- 3. 账户与持仓分析 ---
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  
  let stageName = "";
  let currentStageParams = null;
  let stagePromptAddition = "";

  if (totalEquity < 20) {
      stageName = STRATEGY_STAGES.STAGE_1.name;
      currentStageParams = STRATEGY_STAGES.STAGE_1;
      stagePromptAddition = "【起步搏杀】低杠杆稳健起步。";
  } else if (totalEquity < 80) {
      stageName = STRATEGY_STAGES.STAGE_2.name;
      currentStageParams = STRATEGY_STAGES.STAGE_2;
      stagePromptAddition = "【资金积累】稳健增长。";
  } else {
      stageName = STRATEGY_STAGES.STAGE_3.name;
      currentStageParams = STRATEGY_STAGES.STAGE_3;
      stagePromptAddition = "【稳健盈利】保本第一。";
  }

  let positionStr = "当前无持仓 (Empty)";
  let avgPx = 0;
  
  // --- 4. 强制保本逻辑 (Programmatic Force) ---
  let forcedBreakEvenAction: AIDecision | null = null;
  let systemMessage = "";

  if (hasPosition) {
      const p = primaryPosition!;
      avgPx = parseFloat(p.avgPx);
      const isLong = p.posSide === 'long';
      const currentSL = p.slTriggerPx ? parseFloat(p.slTriggerPx) : 0;

      // 计算安全保本价 (Entry +/- 0.15% to cover fees & slippage)
      // 如果 OKX API 提供了 breakEvenPx，优先使用
      let breakEvenPx = p.breakEvenPx ? parseFloat(p.breakEvenPx) : 0;
      if (breakEvenPx === 0) {
          breakEvenPx = isLong ? avgPx * 1.0015 : avgPx * 0.9985;
      }

      // 计算当前浮盈比例
      const currentROI = isLong 
          ? (currentPrice - avgPx) / avgPx 
          : (avgPx - currentPrice) / avgPx;

      // 强制保本触发阈值：0.6% (确保完全覆盖手续费并有微利)
      const TRIGGER_ROI = 0.006; 

      let needsForcedUpdate = false;

      // 检查是否满足强制保本条件
      if (currentROI > TRIGGER_ROI) {
          // 如果当前没有止损，或者止损比保本价“差”，则强制更新
          if (isLong) {
              if (currentSL < breakEvenPx) needsForcedUpdate = true;
          } else {
              if (currentSL === 0 || currentSL > breakEvenPx) needsForcedUpdate = true;
          }
      }

      if (needsForcedUpdate) {
          systemMessage = `[系统强制] 检测到浮盈 > 0.6%，且止损未设置在保本位。程序将强制执行保本策略。`;
          // 构造强制决策
          forcedBreakEvenAction = {
              stage_analysis: "SYSTEM_FORCE_PROTECTION",
              market_assessment: "PROFIT_PROTECTION",
              hot_events_overview: "N/A",
              eth_analysis: "N/A",
              trading_decision: {
                  action: 'update_tpsl',
                  confidence: "100%",
                  position_size: "0",
                  leverage: currentStageParams.leverage.toString(),
                  profit_target: "", // Keep existing or let OKX handle
                  stop_loss: breakEvenPx.toFixed(2),
                  invalidation_condition: "Mandatory Break-Even"
              },
              reasoning: `系统强制执行：浮盈已达标 (${(currentROI*100).toFixed(2)}%)，强制将止损移动至保本价 ${breakEvenPx.toFixed(2)} 以防止资金磨损。`,
              action: 'UPDATE_TPSL',
              size: "0",
              leverage: currentStageParams.leverage.toString()
          };
      }

      positionStr = `
      持有: ${p.posSide.toUpperCase()} ${p.pos}张
      开仓均价: ${p.avgPx} | 当前: ${currentPrice}
      浮盈: ${(currentROI*100).toFixed(2)}%
      保本价: ${breakEvenPx.toFixed(2)}
      当前止损: ${p.slTriggerPx || "无"}
      `;
  }

  // --- 5. 构建 Prompt ---
  const marketDataBlock = `
价格: ${currentPrice}
24H涨跌: ${dailyChange.toFixed(2)}%
MACD: ${macdSignalStr}
RSI: ${rsi14.toFixed(2)}
`;

  // 如果触发了强制保本，我们在 Prompt 中告知 AI 现状，让 AI 决定是否需要 *进一步* 锁利
  // 或者如果没触发强制，就走正常 AI 逻辑
  const systemPrompt = `
你是一名 ETH 超短线交易员。
当前状态: ${positionStr}
${systemMessage ? "**注意: " + systemMessage + "**" : ""}

**核心指令**:
1. **系统已接管基础保本**: 程序会自动监控并在浮盈 > 0.6% 时强制设置保本止损。你不需要担心基础的盈亏平衡。
2. **你的任务 - 进阶锁利**: 
   - 当利润进一步扩大 (如 > 2%, > 5%) 时，请建议将止损上移，锁定更多利润 (Trailing Stop)。
   - 严禁将止损回调（棘轮规则）。
   - 如果市场出现反转信号，果断建议 CLOSE。
3. **开仓风控**:
   - 首次开仓保证金 >= 0.5U。
   - 初始止损导致亏损 < 20%。

请根据实时数据生成 JSON 决策。
`;

  const responseSchema = `
  {
    "stage_analysis": "...",
    "hot_events_overview": "...",
    "market_assessment": "...",
    "eth_analysis": "...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "...",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "价格",
      "stop_loss": "价格",
      "invalidation_condition": "..."
    },
    "reasoning": "..."
  }
  `;

  // --- 6. AI 决策或强制返回 ---
  
  // 如果系统判定必须强制保本，直接返回构造好的决策，跳过 AI 调用以节省 Token 并确保执行
  // *除非* 我们想让 AI 看看是否应该直接平仓 (CLOSE)。
  // 为了安全起见，我们先调用 AI，然后根据结果进行融合。如果 AI 建议 CLOSE，则 CLOSE；否则如果系统要求保本，则覆盖为 UPDATE_TPSL。

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: "分析数据并给出决策。" }
    ]);

    if (!text) throw new Error("AI 返回为空");

    let decision: AIDecision;
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        decision = JSON.parse(cleanText);
    } catch (e) {
        throw new Error("AI 返回格式错误");
    }

    // --- Post-Processing & Logic Fusion ---
    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    // 融合强制保本逻辑
    if (forcedBreakEvenAction) {
        // 如果 AI 建议 CLOSE，优先级高于 UPDATE_TPSL，因为 CLOSE 是落袋为安的终极形态
        if (decision.action === 'CLOSE') {
            console.log("[Logic Fusion] AI 建议止盈平仓，优于系统强制保本。执行 CLOSE。");
        } else {
            // 否则，强制执行保本策略
            console.log("[Logic Fusion] 系统强制介入：执行保本止损设置。");
            decision = forcedBreakEvenAction;
        }
    }

    // 通用后处理 (计算 Size 等)
    const leverage = parseFloat(decision.trading_decision.leverage);
    const safeLeverage = isNaN(leverage) ? currentStageParams.leverage : leverage;
    
    let targetMargin = availableEquity * currentStageParams.risk_factor * (parseFloat(decision.trading_decision.confidence)/100 || 0.5);
    const maxSafeMargin = availableEquity * 0.95; 
    let finalMargin = Math.min(targetMargin, maxSafeMargin);
    let positionValue = finalMargin * safeLeverage;

    // 首仓门槛修正
    const isInitialOpen = !hasPosition;
    const MIN_MARGIN = 0.5;
    if (isInitialOpen && finalMargin < MIN_MARGIN && availableEquity > MIN_MARGIN * 1.05) {
        finalMargin = MIN_MARGIN;
        positionValue = finalMargin * safeLeverage;
    }

    // 赋值
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        let rawSize = parseFloat(decision.trading_decision.position_size || "0");
        const calcSize = positionValue / (CONTRACT_VAL_ETH * currentPrice);
        let finalSize = (rawSize > 0 && rawSize < calcSize) ? rawSize : calcSize;
        const numContracts = Math.floor(finalSize * 100) / 100;
        
        if (numContracts < 0.01) {
            decision.action = 'HOLD';
            decision.size = "0";
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
    // Error Fallback
    return {
        stage_analysis: "Error",
        market_assessment: "Error",
        hot_events_overview: "Error",
        eth_analysis: "Error",
        trading_decision: {
            action: 'hold' as any,
            confidence: "0",
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
