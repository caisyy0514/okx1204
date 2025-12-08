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
  const vol24h = parseFloat(marketData.ticker?.volCcy24h || "0"); // USDT Volume
  const totalEquity = parseFloat(accountData.balance.totalEq);
  const availableEquity = parseFloat(accountData.balance.availEq);
  const openInterest = parseFloat(marketData.openInterest || "1"); 
  const sharpeRatio = accountData.sharpeRatio || 0; // Performance Metric

  // K-Line Data Arrays (15m for short term indicators)
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

  // --- 3. 核心：1小时级别 EMA 趋势判断 (EMA15 vs EMA60) ---
  const candles1H = marketData.candles1H || [];
  let emaTrendStr = "震荡/无明确趋势";
  
  if (candles1H.length > 60) {
      const closes1H = candles1H.map(c => parseFloat(c.c));
      const latestClose1H = closes1H[closes1H.length - 1];
      const latestOpen1H = parseFloat(candles1H[candles1H.length - 1].o);
      
      const ema15_1H = calcEMA(closes1H, 15);
      const ema60_1H = calcEMA(closes1H, 60);
      
      const isUpCross = ema15_1H > ema60_1H; // Simplified check: if 15 above 60
      const isYang = latestClose1H > latestOpen1H; // Red/Green candle check
      const isYin = latestClose1H < latestOpen1H;

      if (isUpCross && isYang) {
          emaTrendStr = "强上涨趋势 (EMA15 > EMA60 + 收阳)";
      } else if (!isUpCross && isYin) {
          emaTrendStr = "强下跌趋势 (EMA15 < EMA60 + 收阴)";
      } else if (isUpCross) {
          emaTrendStr = "多头排列 (但K线收阴, 需观察)";
      } else {
          emaTrendStr = "空头排列 (但K线收阳, 需观察)";
      }
  }

  // --- 4. 核心：持仓分析与利润保护计算 (Advanced Position Analysis) ---
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
      
      // Strict Breakeven Calculation
      // 1. Calculate Local Estimate (Validation)
      let localBreakeven = 0;
      if (p.posSide === 'long') {
          localBreakeven = entryPrice * (1 + TAKER_FEE_RATE) / (1 - TAKER_FEE_RATE);
      } else {
          localBreakeven = entryPrice * (1 - TAKER_FEE_RATE) / (1 + TAKER_FEE_RATE);
      }

      // 2. Get Exchange Data (Primary Source)
      const exchangeBreakeven = parseFloat(p.breakEvenPx || "0");
      
      // 3. Decision & Validation Logic
      let validationNote = "";
      if (exchangeBreakeven > 0) {
          breakevenPrice = exchangeBreakeven;
          // Verify with local calc
          const diff = Math.abs(exchangeBreakeven - localBreakeven);
          const diffPct = (diff / localBreakeven) * 100;
          
          if (diffPct > 0.1) { // 0.1% tolerance
              validationNote = `[数据警告] 交易所BE(${exchangeBreakeven}) 与 本地估算(${localBreakeven.toFixed(2)}) 差异 ${diffPct.toFixed(2)}%`;
          } else {
              validationNote = `[数据校验通过] (Exchange Data)`;
          }
      } else {
          // Fallback to local if exchange data missing
          breakevenPrice = localBreakeven;
          validationNote = `[使用本地估算] (Exchange Data Unavailable)`;
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
      【盈亏平衡价 (Breakeven)】: ${breakevenPrice.toFixed(2)} ${validationNote}
      当前止损 (SL): ${p.slTriggerPx || "未设置"}
      当前止盈 (TP): ${p.tpTriggerPx || "未设置 (建议不设，用移动止损)"}
      `;
  }

  // --- NEW: Perform "Internet Search" (Fetch Real-time News) ---
  const newsContext = await fetchRealTimeNews();

  // --- 5. 构建 Prompt (Refined 9 Rules + Internet Search + EMA Trend + Sharpe) ---
  
  const marketDataBlock = `
价格: ${currentPrice.toFixed(2)}
波动: ${dailyChange.toFixed(2)}%
【1H 趋势信号】: ${emaTrendStr} (关键决策参考)
MACD: ${macdSignalStr}
RSI: ${rsi14.toFixed(2)}
KDJ: ${kdjSignalStr}
布林: ${bollPosStr}
`;

  const performanceBlock = `
【绩效分析 (夏普比率 Sharpe Ratio)】: ${sharpeRatio.toFixed(2)}
- Sharpe < 0: 平均亏损 -> 若**空仓**，请大幅减小头寸，严格止损，极度挑剔。
- Sharpe 0-1: 正回报但波动大 -> 若**空仓**，保持谨慎，适当减小头寸。
- Sharpe 1-2: 良好表现 -> 策略有效，正常交易。
- Sharpe > 2: 卓越表现 -> 保持纪律，防止飘飘然。
`;

  const systemPrompt = `
你是一名精通 **ETH 合约交易** 专家。
你的首要任务是执行 **保护本金的情况下最大化盈利** 。
你具备 **实时联网搜索能力**，必须结合下方的【实时互联网情报】进行综合研判。

**当前环境**:
- 阶段: ${stageName} (基础杠杆 ${currentStageParams.leverage}x)
- 市场: ${marketDataBlock}
- 绩效: ${performanceBlock}

**实时互联网情报 (Real-time Internet Search)**:
${newsContext}

**持仓状态**:
${positionContext}

---

**核心决策九大军规 (The 9 Commandments)**:

1. **本金保护 (Capital Protection)**:
   - 使用 **棘轮机制 (Ratchet)** 移动止损：止损价 **只能向盈利更多的方向移动**，严禁回调。
   - **关键调整**：在【净利润 < 0】的亏损/回本途中，**严禁激进回调止损**，**只能向盈利更多的方向移动**。
   - 除非出现极强的结构性支撑，否则不要因为微小的价格反弹就紧跟移动止损，这会导致在达到盈亏平衡前被市场噪音震荡出局。
   - **多头 (Long)**: 目标是 SL 向上移至 Breakeven 甚至更高。**New SL 必须 >= Old SL**。
   - **空头 (Short)**: 目标是 SL 向下移至 Breakeven 甚至更低。**New SL 必须 <= Old SL**。

2. **锁定利润 (Lock-in Profit)**:
   - 只有当【净利润 (Net PnL) > 0】且价格明显脱离成本区时，才迅速调整 SL：
     - **Long**: SL 设在 Breakeven 价格 **之上**。
     - **Short**: SL 设在 Breakeven 价格 **之下**。
     - 这是优先级最高的任务：先保证不亏，再追求盈利，此时才是“零风险博弈”的开始，此前应以“生存”为主，容忍合理波动。

3. **趋势上限探索 (Trend Exploration)**:
   - **不要设置硬止盈 (TP)** 限制收益上限，除非遇到极强阻力。
   - 使用 **移动止损 (Trailing SL)** 来跟随趋势，让利润奔跑，直到趋势反转触碰 SL 离场。
   - **新增趋势判定**: 必须参考【1H 趋势信号】。若 EMA15 上穿 EMA60 且收阳，坚定看涨；若 EMA15 下穿 EMA60 且收阴，坚定看跌。

4. **补仓机制 (Smart DCA)**:
   - 触发条件：浮亏状态 + 触及关键支撑位 + 逻辑未破坏 + 风险可控 (Risk Controllable)。
   - 目的：摊低成本 (Average Down)。
   - **资金分配原则**: 补仓金额应基于**当前账户可用余额 (Available Equity)**，而非当前持仓量。
   - 建议每次补仓使用 **可用余额的 10%-20%**，循序渐进。
   - 禁忌：趋势已反转或仓位过重时，严禁补仓，应该直接止损。

5. **金字塔加仓 (Pyramiding)**:
   - 触发条件：【净利润 > 0】 + 趋势确认突破 + 风险可控。
   - 目的：捕捉本次交易的最大收益。
   - 原则：加仓部分应小于底仓 (倒金字塔是找死)。

6. **核心目标**:
   - 一切决策以 **净利润 (Net Profit)** 为核心。净利润 = 浮盈 - 双边手续费。

7. **波动容忍 (Volatility Filter)**:
   - 在价格未达到 Breakeven Price 之前，**给予市场充分的波动空间**。
   - 不要为了减少那一点点潜在亏损而频繁操作 SL。在这个阶段，SL 应保持在初始逻辑失效点（Invaldiation Level），而不是跟随价格移动，以免被微小噪音扫损。
   - 但一旦进入盈利区，容忍度应迅速收紧。

8. **锚点战术 (Anchor Point)**:
   - 交易所的 **Breakeven Price** 是最重要的战场分界线。
   - 你的战术路径：忍受波动 -> 触达 Breakeven -> 确保 SL 尽快跨越 Breakeven 线（多单向上跨越，空单向下跨越） -> 开启无限追利模式。

9. **AI 动态风控与绩效校准**:
   - 一旦实现盈亏平衡 (持有多单情况下 SL 向上跨越 Breakeven，持有空单情况下 SL 向下跨越 Breakeven)，由你根据 **市场热点(基于提供的互联网情报)**、技术指标全权接管 SL 的移动节奏。
   - **夏普比率校准 (仅针对开仓/加仓)**: 
     - 若当前**持有仓位**：夏普比率影响**降至最低**。此时应优先遵循价格行为和止盈止损规则。
     - 若当前**空仓或计划加仓**：且 Sharpe < 0，必须**降低开仓规模**，提高入场标准。

**资金管理红线 (重要)**:
- **[首次开仓]**: 保证金严禁超过 **可用余额的 (Available Equity) 30%**。
- **[补仓/加仓]**: 单次保证金使用 **可用余额的 (Available Equity) 10%-20%**。
- 请在 reasoning 中明确说明你是 "首次开仓" 还是 "补仓/加仓"。

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
    "hot_events_overview": "结合上述实时互联网情报，简述关键市场事件...",
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
    "reasoning": "明确说明：这是[首次开仓]还是[补仓]？解释是否触发棘轮？夏普比率如何影响了你的决策？"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: `当前净利润: ${netPnL.toFixed(2)} U。请根据九大军规及实时情报给出最佳操作。` }
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
        // 1. 若为加仓/补仓：使用可用余额的 10%-20%
        // 2. 若为首次开仓：使用可用余额的 30%
        // 注意：不依赖AI的position_size，而是基于当前 availableEquity 重新计算推荐值，
        // 除非AI给出的数值非常明确且在合理范围内。这里为了稳健，如果AI数值异常，则回退到算法。

        // Apply Sharpe Ratio Adjustment Logic (Systematic Override)
        let sharpeModifier = 1.0;
        if (sharpeRatio < 0) {
            sharpeModifier = 0.5; // Cut size in half if performance is bad
        } else if (sharpeRatio > 0 && sharpeRatio < 1) {
            sharpeModifier = 0.8; // Reduce slightly
        }

        // 1. Determine Target Contracts from Algo
        const priceForCalc = currentPrice > 0 ? currentPrice : 1; 
        
        // Calculate Base Margin based on Strategy
        let baseRiskRatio = 0;
        if (isAdding) {
            baseRiskRatio = 0.15; // DCA use 15% of *remaining* equity
        } else {
            baseRiskRatio = 0.30; // Initial Entry use 30% of equity
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
        // If AI gives 0 or NaN, use Algo.
        if (aiContracts > 0 && !isNaN(aiContracts)) {
             finalContracts = aiContracts;
        } else {
             finalContracts = algoContracts;
        }

        // 4. Calculate Max Available Contracts (Safety Cap)
        // Hard Cap: Initial Trade Max 30%, DCA Max 20% of current available
        const capRatio = isAdding ? 0.20 : 0.30;
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

        // Final check: if calculated size is still effectively 0 or invalid given min size constraints vs balance
        if (parseFloat(decision.size) < 0.01 || isNaN(parseFloat(decision.size))) {
             console.warn("[Risk Control] Insufficient balance for minimum order size (or NaN). Forcing HOLD.");
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
