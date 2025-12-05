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
  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  
  let stageName = "";
  let currentStageParams = null;
  let stagePromptAddition = "";

  if (totalEquity < 20) {
      stageName = STRATEGY_STAGES.STAGE_1.name;
      currentStageParams = STRATEGY_STAGES.STAGE_1;
      stagePromptAddition = "【起步搏杀阶段】允许 **高风险高收益** 操作。支持亏损补仓 (DCA) 和 盈利加仓 (Pyramiding)。";
  } else if (totalEquity < 80) {
      stageName = STRATEGY_STAGES.STAGE_2.name;
      currentStageParams = STRATEGY_STAGES.STAGE_2;
      stagePromptAddition = "【资金积累阶段】稳健增长，允许少量补仓和加仓。";
  } else {
      stageName = STRATEGY_STAGES.STAGE_3.name;
      currentStageParams = STRATEGY_STAGES.STAGE_3;
      stagePromptAddition = "【稳健盈利阶段】保本第一，禁止逆势补仓。";
  }

  let positionStr = "当前无持仓 (Empty)";
  let avgPx = 0;
  
  // Dynamic SL Levels Calculation based on Net PnL (Amount)
  let safeBreakEvenPrice = 0;
  let recommendedSL = 0;
  let profitLockStage = "A: 观察/浮亏期";
  let netPnL = 0;
  let netROI = 0;
  let opSuggestion = "暂无建议";
  
  if (hasPosition) {
      const p = primaryPosition!;
      avgPx = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      const posSize = parseFloat(p.pos);
      const margin = parseFloat(p.margin);
      const isLong = p.posSide === 'long';
      
      // 1. 计算实际净收益 (Net PnL)
      const positionValue = posSize * CONTRACT_VAL_ETH * currentPrice;
      const estimatedFee = positionValue * 0.0012; 
      netPnL = upl - estimatedFee;
      netROI = margin > 0 ? (netPnL / margin) * 100 : 0;

      // 2. 获取交易所保本价 (Use OKX breakEvenPx if available, otherwise estimate)
      let rawBreakEven = p.breakEvenPx ? parseFloat(p.breakEvenPx) : 0;
      if (rawBreakEven === 0) {
          rawBreakEven = isLong ? avgPx * 1.0012 : avgPx * 0.9988;
      }
      safeBreakEvenPrice = rawBreakEven;

      const buffer = currentPrice * 0.002;

      // 3. 利润/亏损阶段判断 (Refined Step-Ladder Logic)
      if (netPnL <= 0) {
          // --- 亏损风控逻辑 ---
          const isTrendAligned = isLong 
              ? (currentPrice > ema20 && macdData.hist > -5) 
              : (currentPrice < ema20 && macdData.hist < 5);
          
          const canDCA = currentStageParams.allow_dca;
          const currentPosRatio = positionValue / totalEquity;
          const maxPosRatio = (currentStageParams as any).max_pos_ratio || 2.0;
          const hasSpaceForDCA = currentPosRatio < maxPosRatio;
          
          const drawdownPct = Math.abs((currentPrice - avgPx) / avgPx) * 100;

          if (isTrendAligned) {
              if (canDCA && hasSpaceForDCA && drawdownPct > 1.5 && drawdownPct < 8) {
                  profitLockStage = "A1: 良性回调 (建议补仓 DCA)";
                  opSuggestion = isLong ? `建议 BUY (补仓) ${posSize * 0.5} 张` : `建议 SELL (补仓) ${posSize * 0.5} 张`;
                  recommendedSL = 0; 
              } else {
                  profitLockStage = "A1: 正常震荡 (HOLD, 允许浮亏)";
                  opSuggestion = "暂不补仓 (幅度不够或仓位已满)";
                  recommendedSL = 0; 
              }
          } else {
              profitLockStage = "A2: 趋势转弱 (风控预警)";
              opSuggestion = "禁止补仓 (趋势破坏)";
              recommendedSL = isLong 
                  ? Math.max(parseFloat(p.slTriggerPx || "0"), currentPrice * 0.99) 
                  : Math.min(parseFloat(p.slTriggerPx || "999999"), currentPrice * 1.01); 
          }
      } else {
          // --- 盈利管理逻辑 (阶梯止盈 Step-Ladder) ---
          
          // 计算当前价格距离保本价的距离 (Profit Distance from Break-Even)
          const distToBE = isLong ? (currentPrice - safeBreakEvenPrice) : (safeBreakEvenPrice - currentPrice);
          const distPct = (distToBE / avgPx) * 100;

          if (distPct < 0.5) {
              // B0: 微利震荡区 (<0.5%) -> 允许浮动，不要急于移止损，防止手续费磨损
              profitLockStage = "B0: 微利震荡 (等待时机)";
              recommendedSL = 0; // 保持原止损
              opSuggestion = "持有 (等待利润扩大)";
          } else if (distPct >= 0.5 && distPct < 2.0) {
              // B1: 保本区 (0.5% - 2%) -> 锁定保本
              profitLockStage = "B1: 盈亏平衡保护 (Break-Even)";
              recommendedSL = safeBreakEvenPrice;
              opSuggestion = "调整止损至保本价";
          } else if (distPct >= 2.0 && distPct < 5.0) {
              // C: 锁定部分利润 (2% - 5%) -> 锁定 40% 浮盈
              profitLockStage = "C: 阶梯止盈 (Lock 40%)";
              const lockAmt = distToBE * 0.4;
              recommendedSL = isLong ? safeBreakEvenPrice + lockAmt : safeBreakEvenPrice - lockAmt;
              opSuggestion = "锁定部分利润";
          } else {
              // D: 深度获利 ( > 5%) -> 锁定 75% 浮盈 (Trailing)
              profitLockStage = "D: 深度止盈 (Lock 75%)";
              const lockAmt = distToBE * 0.75;
              recommendedSL = isLong ? safeBreakEvenPrice + lockAmt : safeBreakEvenPrice - lockAmt;
              opSuggestion = "强趋势跟进 (Let Profits Run)";
          }

          // 盈利加仓判定 (Pyramiding)
          const isStrongTrend = isLong
              ? (currentPrice > boll.upper || (macdData.hist > 0 && rsi14 > 55))
              : (currentPrice < boll.lower || (macdData.hist < 0 && rsi14 < 45));
          
          const currentPosRatio = positionValue / totalEquity;
          const maxPosRatio = (currentStageParams as any).max_pos_ratio || 2.0;
          const hasSpace = currentPosRatio < maxPosRatio;

          if (isStrongTrend && hasSpace && netROI > 10) {
               opSuggestion += " & 建议顺势加仓";
          }
      }

      // 4. 棘轮效应 (Strict Ratchet) - 确保止损不回撤
      const currentSL = p.slTriggerPx ? parseFloat(p.slTriggerPx) : 0;
      if (recommendedSL > 0) {
          if (isLong) {
               if (recommendedSL > currentPrice - buffer) recommendedSL = currentPrice - buffer; // 挂单安全距离
               // 棘轮: 新止损必须 >= 旧止损
               if (currentSL > 0 && recommendedSL < currentSL) {
                   console.log(`[Ratchet] 修正: 新止损 ${recommendedSL.toFixed(2)} < 旧止损 ${currentSL}，维持旧止损`);
                   recommendedSL = currentSL; 
                   profitLockStage += " [棘轮保持]";
               }
          } else { 
               if (recommendedSL < currentPrice + buffer) recommendedSL = currentPrice + buffer;
               // 棘轮: 新止损必须 <= 旧止损
               if (currentSL > 0 && recommendedSL > currentSL) {
                   console.log(`[Ratchet] 修正: 新止损 ${recommendedSL.toFixed(2)} > 旧止损 ${currentSL}，维持旧止损`);
                   recommendedSL = currentSL;
                   profitLockStage += " [棘轮保持]";
               }
          }
      }

      positionStr = `
      持有: ${p.posSide.toUpperCase()} ${p.pos}张
      开仓均价: ${p.avgPx} | 当前价格: ${currentPrice}
      ----------------------------------------
      【实际收益分析】
      * 净盈亏 (Net PnL): ${netPnL.toFixed(2)} U (${netROI.toFixed(2)}% ROI)
      ----------------------------------------
      【风控与操作建议】
      * 交易所保本价: ${safeBreakEvenPrice.toFixed(2)}
      * 当前阶段: ${profitLockStage}
      * 操作建议: ${opSuggestion}
      * 推荐止损 (棘轮修正后): ${recommendedSL > 0 ? recommendedSL.toFixed(2) : "无"}
      ----------------------------------------
      当前生效止损 (SL): ${p.slTriggerPx || "⚠️未设置"}
      技术面: EMA20=${ema20.toFixed(2)}, MACD Hist=${macdData.hist.toFixed(2)}
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

**三、核心决策指令 (HIGHEST PRIORITY: RISK, DCA & PROFIT)**:

1. **首次开仓风控 (Initial Entry Rules)**:
   - **最小市值门槛**: 首次开仓的 **实际持仓市值 (Notional Value)** 必须 >= 50 USDT。
     - **重要**: "市值" = 保证金 x 杠杆。例如 100x 杠杆下，**仅需 0.5 USDT 保证金** 即可达到 50 USDT 市值。
     - **不要误判**: 如果余额 > 0.6U，资金绝对充足！请勿因为"余额不足 50U"而放弃开仓。只要余额够付 0.5U 保证金，就大胆开！
   - **最大止损**: 首次开仓止损造成的亏损，**绝不允许超过保证金 20%**。确保 "(Abs(Entry - SL) / Entry) * Leverage < 0.2"。

2. **补仓与加仓机制 (Dynamic Sizing)**:
   - **亏损补仓 (DCA)**: 如果【操作建议】提示 "建议补仓"，且趋势未破，执行 BUY/SELL 摊低成本。
   - **盈利加仓 (Pyramiding)**: 如果【操作建议】提示 "顺势加仓"，且趋势强劲，执行 BUY/SELL 扩大战果。
   - **注意**: 无论是补仓还是加仓，执行后必须重新评估并设置新的止损。

3. **利润保护机制 (Profit Locking - B/C/D 阶段)**:
   - **执行**: 若净收益为正，且【推荐止损】有具体数值，请严格执行 **UPDATE_TPSL**。
   - **棘轮规则**: 严禁回调止损！只允许向更有利于盈利的方向移动。

4. **实时联网搜索 (ONLINE SEARCH)**:
   - **指令**: 立即搜索全网 Crypto 热点 (6h/24h)。
   - **判断**: 若有突发重大利空，立即清仓。

5. **交易执行**:
   - **Action**: BUY / SELL / HOLD / CLOSE / UPDATE_TPSL
   - **Stop Loss**: 
      - UPDATE_TPSL: 填入【推荐止损】的数值。
      - 开新仓/补仓: 必须填入逻辑止损，且符合风控要求。

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
      "position_size": "动态计算 (张数或U)",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "价格",
      "stop_loss": "价格 (注意 <20% 亏损限制)",
      "invalidation_condition": "..."
    },
    "reasoning": "..."
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY, NO MARKDOWN:\n" + responseSchema },
        { role: "user", content: "请调用你的搜索能力获取实时数据，并根据【亏损补仓】、【盈利加仓】及【首单风控】逻辑给出指令。" }
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

    let positionValue = finalMargin * safeLeverage;

    // --- 强制修正：首仓市值检查 (Min Notional Value) ---
    const isInitialOpen = !hasPosition;
    const MIN_OPEN_VALUE = isInitialOpen ? 50 : 0;

    if (isInitialOpen && positionValue < MIN_OPEN_VALUE) {
        const reqMargin = MIN_OPEN_VALUE / safeLeverage;
        if (availableEquity > reqMargin * 1.05) {
            positionValue = MIN_OPEN_VALUE;
            console.log(`[AI] 首次开仓强制修正: 市值提升至 ${MIN_OPEN_VALUE} USDT (原计算: ${(finalMargin * safeLeverage).toFixed(2)})`);
        } else {
            console.warn(`[AI] 首次开仓资金不足 (${availableEquity.toFixed(2)} < ${reqMargin.toFixed(2)})，无法满足50U市值，转为HOLD`);
            decision.action = 'HOLD';
            decision.size = "0";
            decision.reasoning += ` [系统修正: 资金不足以开启50U市值的最小底仓]`;
        }
    }

    // --- 强制风控检查 (Max SL Distance) ---
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        let rawSize = parseFloat(decision.trading_decision.position_size || "0");
        const calcSize = positionValue / (CONTRACT_VAL_ETH * currentPrice);
        
        let finalSize = calcSize;
        if (rawSize > 0 && rawSize < calcSize) {
            finalSize = rawSize;
        } else if (rawSize === 0) {
            finalSize = calcSize;
        }

        // SL Protection Check
        const proposedSL = parseFloat(decision.trading_decision.stop_loss);
        if (!isNaN(proposedSL) && proposedSL > 0) {
            const maxDeviationPct = 0.20 / safeLeverage; 
            let safeSL = proposedSL;
            let corrected = false;

            if (decision.action === 'BUY') {
                const limitPrice = currentPrice * (1 - maxDeviationPct);
                if (proposedSL < limitPrice) {
                    safeSL = limitPrice;
                    corrected = true;
                }
            } else { // SELL
                const limitPrice = currentPrice * (1 + maxDeviationPct);
                if (proposedSL > limitPrice) {
                    safeSL = limitPrice;
                    corrected = true;
                }
            }

            if (corrected) {
                console.warn(`[Risk Control] AI SL ${proposedSL} too loose. Adjusted to ${safeSL.toFixed(2)}`);
                decision.trading_decision.stop_loss = safeSL.toFixed(2);
                decision.reasoning += ` [系统修正: 止损已强制收紧至 ${safeSL.toFixed(2)} 以控制本金亏损 <20%]`;
            }
        }

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
