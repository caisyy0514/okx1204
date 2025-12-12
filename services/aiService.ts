
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

// EMA Array Calculator
const calcEMAArray = (prices: number[], period: number): number[] => {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emas = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    const val = prices[i] * k + emas[i - 1] * (1 - k);
    emas.push(val);
  }
  return emas;
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

// --- News Fetcher (Internet Search Capability) ---
const fetchRealTimeNews = async (): Promise<string> => {
    try {
        // Fetch Top latest crypto news (Public API)
        const url = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest&limit=6";
        const res = await fetch(url);
        if (!res.ok) return "暂无法连接互联网新闻源";
        
        const json = await res.json();
        if (json.Data && Array.isArray(json.Data)) {
            // Format: Title + Source
            const items = json.Data.slice(0, 6).map((item: any) => {
                const time = new Date(item.published_on * 1000).toLocaleTimeString();
                return `- [${time}] ${item.title} (Source: ${item.source_info?.name || 'Web'})`;
            });
            return items.join("\n");
        }
        return "扫描未发现即时重大新闻";
    } catch (e) {
        // Fail gracefully to keep trading logic running
        return "实时搜索暂时不可用 (API Connection Error)";
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
  const totalEquity = parseFloat(accountData.balance.totalEq);
  const availableEquity = parseFloat(accountData.balance.availEq);
  const sharpeRatio = accountData.sharpeRatio || 0; // Performance Metric

  // K-Line Data Arrays (15m for short term indicators)
  const candles = marketData.candles15m || [];
  const closes = candles.map(c => parseFloat(c.c));
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));

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

  // --- 3. 核心：1小时级别 EMA 趋势判断 (EMA15 vs EMA60) ---
  const candles1H = marketData.candles1H || [];
  let emaTrend1H = "NEUTRAL";
  let emaTrendStr = "震荡/无明确趋势";
  
  if (candles1H.length > 60) {
      const closes1H = candles1H.map(c => parseFloat(c.c));
      const latestClose1H = closes1H[closes1H.length - 1];
      const latestOpen1H = parseFloat(candles1H[candles1H.length - 1].o);
      const latestTime1H = new Date(parseInt(candles1H[candles1H.length - 1].ts)).toLocaleTimeString();
      
      const ema15_1H = calcEMA(closes1H, 15);
      const ema60_1H = calcEMA(closes1H, 60);
      
      const isUpCross = ema15_1H > ema60_1H; 
      const isYang = latestClose1H > latestOpen1H; // Green Candle
      const isYin = latestClose1H < latestOpen1H; // Red Candle

      if (isUpCross && isYang) {
          emaTrend1H = "UP";
          emaTrendStr = `UP (EMA15>60 & 收阳) @ ${latestTime1H}`;
      } else if (!isUpCross && isYin) {
          emaTrend1H = "DOWN";
          emaTrendStr = `DOWN (EMA15<60 & 收阴) @ ${latestTime1H}`;
      } else {
          emaTrendStr = isUpCross ? "震荡偏多 (EMA多头但收阴)" : "震荡偏空 (EMA空头但收阳)";
      }
  }

  // --- 4. 核心：3分钟图 入场/出场信号 (Entry/Exit Signals) ---
  const candles3m = marketData.candles3m || [];
  let entrySignal3m = "NONE";
  let stopLossTarget3m = 0;
  
  if (candles3m.length > 65) {
      const closes3m = candles3m.map(c => parseFloat(c.c));
      const lows3m = candles3m.map(c => parseFloat(c.l));
      const highs3m = candles3m.map(c => parseFloat(c.h));
      
      // Calculate full EMA arrays to look back for crossovers
      const ema15Array = calcEMAArray(closes3m, 15);
      const ema60Array = calcEMAArray(closes3m, 60);
      
      const idx = closes3m.length - 1; // Current Candle Index
      
      // Detect Golden Cross (EMA15 crosses above EMA60)
      // Check last 3 candles for fresh cross
      // Cross happens if prev: 15 < 60 AND curr: 15 > 60
      const isGoldenCross = (ema15Array[idx] > ema60Array[idx]) && (ema15Array[idx-1] <= ema60Array[idx-1]);
      
      // Detect Death Cross (EMA15 crosses below EMA60)
      const isDeathCross = (ema15Array[idx] < ema60Array[idx]) && (ema15Array[idx-1] >= ema60Array[idx-1]);

      if (isGoldenCross) {
          entrySignal3m = "BUY_SIGNAL"; // Golden Cross
          // Find Lowest Low in the previous Death Cross Interval (where 15 < 60)
          let searchIdx = idx - 1;
          let minLow = lows3m[idx];
          // Look back max 50 candles
          while(searchIdx > 0 && (idx - searchIdx) < 50) {
              if (ema15Array[searchIdx] > ema60Array[searchIdx]) break; // End of death cross interval
              if (lows3m[searchIdx] < minLow) minLow = lows3m[searchIdx];
              searchIdx--;
          }
          stopLossTarget3m = minLow;
      } 
      else if (isDeathCross) {
          entrySignal3m = "SELL_SIGNAL"; // Death Cross
          // Find Highest High in the previous Golden Cross Interval (where 15 > 60)
          let searchIdx = idx - 1;
          let maxHigh = highs3m[idx];
           // Look back max 50 candles
          while(searchIdx > 0 && (idx - searchIdx) < 50) {
              if (ema15Array[searchIdx] < ema60Array[searchIdx]) break; // End of golden cross interval
              if (highs3m[searchIdx] > maxHigh) maxHigh = highs3m[searchIdx];
              searchIdx--;
          }
          stopLossTarget3m = maxHigh;
      }
  }

  // --- 5. 持仓分析与分层止盈 (Position Analysis & Tiered TP) ---
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
  let tpAdvice = "暂无";
  
  if (hasPosition) {
      const p = primaryPosition!;
      const sizeContracts = parseFloat(p.pos);
      const sizeCoin = sizeContracts * CONTRACT_VAL_ETH;
      const entryPrice = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      const uplRatio = parseFloat(p.uplRatio);
      
      // Strict Breakeven Calculation
      let localBreakeven = 0;
      if (p.posSide === 'long') {
          localBreakeven = entryPrice * (1 + TAKER_FEE_RATE) / (1 - TAKER_FEE_RATE);
      } else {
          localBreakeven = entryPrice * (1 - TAKER_FEE_RATE) / (1 + TAKER_FEE_RATE);
      }
      const exchangeBreakeven = parseFloat(p.breakEvenPx || "0");
      breakevenPrice = exchangeBreakeven > 0 ? exchangeBreakeven : localBreakeven;
      
      // Net Profit
      const currentVal = sizeCoin * currentPrice;
      const entryVal = sizeCoin * entryPrice;
      estimatedTotalFees = (currentVal * TAKER_FEE_RATE) + (entryVal * TAKER_FEE_RATE);
      netPnL = upl - estimatedTotalFees;

      // Tiered Take Profit Logic
      if (uplRatio > 0.15) tpAdvice = "触发 15% 止盈线: 建议全部平仓";
      else if (uplRatio > 0.10) tpAdvice = "触发 10% 止盈线: 平仓 30%, 止损移至 +5% 处";
      else if (uplRatio > 0.05) tpAdvice = "触发 5% 止盈线: 平仓 50%";
      else tpAdvice = "持有中 (收益 < 5%)";
      
      // 1H Trend Reversal Check
      if (p.posSide === 'long' && emaTrend1H === 'DOWN') tpAdvice += " [警告] 1H 趋势反转 (变为DOWN), 建议立即全平";
      if (p.posSide === 'short' && emaTrend1H === 'UP') tpAdvice += " [警告] 1H 趋势反转 (变为UP), 建议立即全平";

      positionContext = `
      === 持仓详情 ===
      方向: ${p.posSide.toUpperCase()}
      持仓量: ${p.pos} 张 (${sizeCoin.toFixed(2)} ETH)
      开仓均价: ${entryPrice.toFixed(2)}
      当前市价: ${currentPrice.toFixed(2)}
      
      === 盈亏分析 (Net Profit) ===
      浮动盈亏 (UPL): ${upl.toFixed(2)} U (${(uplRatio*100).toFixed(2)}%)
      预估双边手续费: ${estimatedTotalFees.toFixed(2)} U
      【净利润】: ${netPnL.toFixed(2)} U
      
      === 保护锚点 ===
      【盈亏平衡价 (Breakeven)】: ${breakevenPrice.toFixed(2)}
      当前止损 (SL): ${p.slTriggerPx || "未设置"}
      当前止盈 (TP): ${p.tpTriggerPx || "未设置"}
      
      === 分层止盈建议 ===
      ${tpAdvice}
      `;
  }

  // --- NEW: Perform "Internet Search" (Fetch Real-time News) ---
  const newsContext = await fetchRealTimeNews();

  // --- 6. 构建 Prompt (Strategy Update) ---
  
  const marketDataBlock = `
价格: ${currentPrice.toFixed(2)}
波动: ${dailyChange.toFixed(2)}%
【1H 趋势】: ${emaTrendStr} (判断基准: EMA15 vs EMA60)
【3m 信号】: ${entrySignal3m === 'NONE' ? '无新信号' : entrySignal3m}
【3m 计算止损位】: ${stopLossTarget3m > 0 ? stopLossTarget3m.toFixed(2) : '等待信号'}
MACD: ${macdSignalStr}
RSI: ${rsi14.toFixed(2)}
`;

  const performanceBlock = `
【绩效分析 (夏普比率 Sharpe Ratio)】: ${sharpeRatio.toFixed(2)}
- Sharpe < 0: 平均亏损 -> 若计划开仓或补仓，强制大幅降低仓位。
`;

  const systemPrompt = `
你是一名精通 **ETH 合约交易** 专家。
你的首要任务是执行 **保护本金的情况下最大化盈利** 。
你具备 **实时联网搜索能力**，必须结合下方的【实时互联网情报】进行综合研判。

**当前环境**:
- 阶段: ${stageName} (基础杠杆 ${currentStageParams.leverage}x)
- 市场: ${marketDataBlock}
- 绩效: ${performanceBlock}

**实时互联网情报**:
${newsContext}

**持仓状态**:
${positionContext}

---

**核心策略规则 (Strict Rules)**:

1. **1H 趋势判断 (Trend)**:
   - 必须严格遵循上方提供的 【1H 趋势】 信号。
   - UP = EMA15 > EMA60 且 K线阳线。
   - DOWN = EMA15 < EMA60 且 K线阴线。

2. **入场时机 (Entry)**:
   - **必须在 1H 趋势方向上操作**。
   - **做多 (Long)**: 1H趋势为 UP，且 3m 图出现 [死叉 EMA15<60] -> [金叉 EMA15>60]。当前是否触发: ${entrySignal3m === 'BUY_SIGNAL' ? 'YES' : 'NO'}。
   - **做空 (Short)**: 1H趋势为 DOWN，且 3m 图出现 [金叉 EMA15>60] -> [死叉 EMA15<60]。当前是否触发: ${entrySignal3m === 'SELL_SIGNAL' ? 'YES' : 'NO'}。
   - 如果满足条件，在收盘后立即开仓。

3. **止损 (Ratchet Mechanism)**:
   - 始终使用硬止损 (Algo Order)。
   - **多单**: 仅允许上移。初始目标 = 3m趋势下最新完成的死叉区间最低点 (${stopLossTarget3m})。
   - **空单**: 仅允许下移。初始目标 = 3m趋势下最新完成的金叉区间最高点 (${stopLossTarget3m})。
   - 随价格有利变动，持续按此逻辑推进 SL。

4. **止盈 (分层 Tiered TP)**:
   - 收益 > 5%: 平仓 30%。
   - 收益 > 10%: 再平仓 30%，并将止损移至盈利 50% 处。
   - 收益 > 15%: 全部平仓。
   - **1H 趋势反转**: 立即全部平仓。

5. **资金管理**:
   - **首仓**: 30% 权益。
   - **补仓 (Smart DCA)**: 触发条件为浮亏+支撑位+逻辑未坏。单次补仓仅使用剩余资金的 10%-30%。循序渐进。
   - 夏普比率 < 0 时，进一步降低开仓规模。

6. **锚点战术**:
   - **Breakeven Price** 是最重要的战场分界线。
   - 战术路径：触达 Breakeven -> 确保 SL 安全跨越 Breakeven 线 -> 开启无限追利。

7. **核心目标**:
   - 一切决策以 **净利润 (Net Profit)** 为核心。

**操作指令**:
- **UPDATE_TPSL**: 调整止损止盈 (最常用)。
- **BUY / SELL**: 开仓或加仓/补仓。
- **CLOSE**: 立即市价全平。
- **HOLD**: 暂时不动。

**输出要求**:
1. 返回格式必须为 JSON。
2. **重要**: 所有文本分析字段（stage_analysis, market_assessment, hot_events_overview, eth_analysis, reasoning, invalidation_condition）必须使用 **中文 (Simplified Chinese)** 输出。
3. **hot_events_overview** 字段：请仔细阅读提供的 News 英文数据，将其翻译并提炼为简练的中文市场热点摘要。
4. **market_assessment** 字段：必须明确包含以下两行结论：
   - 【1H趋势】：${trend1H.description} 明确指出当前1小时级别EMA15和EMA60的关系（ [金叉 EMA15>60] 或 [死叉 EMA15<60]）是上涨还是下跌。
   - 【3m入场】：：${entry3m.structure} - ${entry3m.signal ? "满足入场" : "等待机会"}明确指出当前3分钟级别是否满足策略定义的入场条件，并说明原因。

请输出 JSON 决策。
`;

  const responseSchema = `
  {
    "stage_analysis": "简述...",
    "hot_events_overview": "结合上述实时互联网情报，简述关键市场事件...",
    "market_assessment": "重点点评 1H 趋势与 3m 信号...",
    "eth_analysis": "...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "数量(张), 仅在BUY/SELL时有效",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "按分层止盈逻辑，通常留空由系统监控，除非全平",
      "stop_loss": "严格计算后的新SL (必须遵守棘轮机制)",
      "invalidation_condition": "..."
    },
    "reasoning": "解释是否符合 1H 趋势？3m 信号是否触发？止损位如何计算？"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: `当前净利润: ${netPnL.toFixed(2)} U。请根据新版策略及实时情报给出最佳操作。` }
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
        
        // --- 核心资金管理修改 (修正版) ---
        // 1. 若为加仓/补仓：使用可用余额的 10%-30%
        // 2. 若为首次开仓：使用可用余额的 30%

        // Apply Sharpe Ratio Adjustment Logic (Systematic Override)
        let sharpeModifier = 1.0;
        if (sharpeRatio < 0) {
            sharpeModifier = 0.5; // Cut size in half if performance is bad
        }

        // 1. Determine Target Contracts from Algo
        const priceForCalc = currentPrice > 0 ? currentPrice : 1; 
        
        // Calculate Base Margin based on Strategy
        let baseRiskRatio = 0;
        if (isAdding) {
            baseRiskRatio = 0.15; // DCA use ~15% (Range 10-30%)
        } else {
            baseRiskRatio = 0.30; // Initial Entry use 30%
        }
        
        // Apply Sharpe Modifier to Risk Ratio
        const effectiveRiskRatio = baseRiskRatio * sharpeModifier;
        const marginToUse = availableEquity * effectiveRiskRatio;
        const posValue = marginToUse * safeLeverage;
        const algoContracts = posValue / (CONTRACT_VAL_ETH * priceForCalc);

        // 2. Process AI Suggestion
        let finalContracts = 0;
        let aiContracts = 0;
        
        if (decision.trading_decision.position_size && decision.trading_decision.position_size !== "0") {
             aiContracts = parseFloat(decision.trading_decision.position_size);
        }

        // 3. Decision Logic: AI vs Algo
        // If AI gives valid number, verify it against cap.
        if (aiContracts > 0 && !isNaN(aiContracts)) {
             finalContracts = aiContracts;
        } else {
             finalContracts = algoContracts;
        }

        // 4. Calculate Max Available Contracts (Safety Cap)
        // Hard Cap: Initial Trade Max 30%, DCA Max 30% of current available
        const capRatio = 0.30; 
        const maxMarginCap = availableEquity * capRatio;
        const maxPosValueCap = maxMarginCap * safeLeverage;
        const maxContractsCap = maxPosValueCap / (CONTRACT_VAL_ETH * priceForCalc);

        if (finalContracts > maxContractsCap) {
            console.warn(`[Risk Control] Size ${finalContracts.toFixed(2)} exceeds cap. Limited to ${maxContractsCap.toFixed(2)}`);
            decision.reasoning += ` [资金管控: 仓位限制在余额的 ${(capRatio*100).toFixed(0)}% (${maxContractsCap.toFixed(2)}张)]`;
            finalContracts = maxContractsCap;
        }

        decision.size = Math.max(finalContracts, 0.01).toFixed(2);
        decision.leverage = safeLeverage.toString();

        // Final check
        if (parseFloat(decision.size) < 0.01 || isNaN(parseFloat(decision.size))) {
             decision.action = 'HOLD';
             decision.size = "0";
             decision.reasoning += " [系统拦截: 账户余额不足以开出最小仓位]";
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
