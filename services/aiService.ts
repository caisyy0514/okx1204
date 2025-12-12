

import { AIDecision, MarketDataCollection, AccountContext } from "../types";
import { CONTRACT_VAL_ETH, STRATEGY_STAGES, INSTRUMENT_ID, TAKER_FEE_RATE } from "../constants";

// --- Technical Indicator Helpers ---

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
                temperature: 0.8, // Slightly lower temp for strict logic
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
        const url = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest&limit=6";
        const res = await fetch(url);
        if (!res.ok) return "暂无法连接互联网新闻源";
        
        const json = await res.json();
        if (json.Data && Array.isArray(json.Data)) {
            const items = json.Data.slice(0, 6).map((item: any) => {
                const time = new Date(item.published_on * 1000).toLocaleTimeString();
                return `- [${time}] ${item.title} (Source: ${item.source_info?.name || 'Web'})`;
            });
            return items.join("\n");
        }
        return "扫描未发现即时重大新闻";
    } catch (e) {
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
  const totalEquity = parseFloat(accountData.balance.totalEq);
  const availableEquity = parseFloat(accountData.balance.availEq);

  // Core Data: 4H Candles
  const candles4H = marketData.candles4H || [];
  
  // --- 2. 核心指标计算 (EMA 21/55 on 4H) ---
  let emaAnalysis = {
      ema21: 0,
      ema55: 0,
      trend: "NEUTRAL",
      isGoldenCross: false,
      isDeathCross: false,
      signalCandleColor: "NEUTRAL", // 'GREEN' or 'RED'
      prevHigh: 0,
      prevLow: 0
  };

  if (candles4H.length > 60) {
      const closes4H = candles4H.map(c => parseFloat(c.c));
      const ema21Arr = calcEMAArray(closes4H, 21);
      const ema55Arr = calcEMAArray(closes4H, 55);
      
      const lastIdx = closes4H.length - 1; 
      // Current (Last Closed) Candle values
      const currEma21 = ema21Arr[lastIdx];
      const currEma55 = ema55Arr[lastIdx];
      const prevEma21 = ema21Arr[lastIdx - 1];
      const prevEma55 = ema55Arr[lastIdx - 1];
      
      const lastCandle = candles4H[lastIdx];
      const close = parseFloat(lastCandle.c);
      const open = parseFloat(lastCandle.o);
      
      emaAnalysis.ema21 = currEma21;
      emaAnalysis.ema55 = currEma55;
      emaAnalysis.trend = currEma21 > currEma55 ? "BULLISH" : "BEARISH";
      
      // Cross Detection (Happened on the latest closed candle)
      emaAnalysis.isGoldenCross = (prevEma21 <= prevEma55) && (currEma21 > currEma55);
      emaAnalysis.isDeathCross = (prevEma21 >= prevEma55) && (currEma21 < currEma55);
      
      emaAnalysis.signalCandleColor = close >= open ? "GREEN" : "RED";
      
      // Previous Candle High/Low (for Stop Loss) based on the candle BEFORE the signal (or the signal candle itself?)
      // Spec says: "Stop loss placed at High/Low of previous 4H candle".
      // Relative to a potential entry NOW, the "previous" candle is the last closed candle (index lastIdx).
      // Or strictly the one before that. Let's use the last closed candle's High/Low as strict reference.
      emaAnalysis.prevHigh = parseFloat(lastCandle.h);
      emaAnalysis.prevLow = parseFloat(lastCandle.l);
  }

  // --- 3. 持仓分析 (Position Analysis) ---
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  
  let netPnL = 0;
  let uplRatio = 0;
  let rollingTrigger = false;
  let positionContext = "当前无持仓";

  if (hasPosition) {
      const p = primaryPosition!;
      const sizeContracts = parseFloat(p.pos);
      const sizeCoin = sizeContracts * CONTRACT_VAL_ETH;
      const entryPrice = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      uplRatio = parseFloat(p.uplRatio);
      
      const currentVal = sizeCoin * currentPrice;
      const entryVal = sizeCoin * entryPrice;
      const fees = (currentVal * TAKER_FEE_RATE) + (entryVal * TAKER_FEE_RATE);
      netPnL = upl - fees;

      // Rolling Logic Trigger: Profit > 5%
      // Note: uplRatio is a good proxy. 0.05 = 5%.
      if (uplRatio >= 0.05) {
          rollingTrigger = true;
      }

      positionContext = `
      === 持仓详情 ===
      方向: ${p.posSide.toUpperCase()}
      持仓量: ${p.pos} 张
      开仓均价: ${entryPrice.toFixed(2)}
      浮盈比例: ${(uplRatio * 100).toFixed(2)}%
      净利润: ${netPnL.toFixed(2)} U
      
      === 滚仓状态 ===
      是否满足加仓条件 (Profit > 5%): ${rollingTrigger ? "YES (建议加仓)" : "NO"}
      `;
  }

  // --- 4. 构建 Prompt (The New 4 Rules) ---
  
  // Real-time News
  const newsContext = await fetchRealTimeNews();

  const marketDataBlock = `
当前价格: ${currentPrice.toFixed(2)}
【EMA指标 (4H)】
- EMA21: ${emaAnalysis.ema21.toFixed(2)}
- EMA55: ${emaAnalysis.ema55.toFixed(2)}
- EMA趋势方向: ${emaAnalysis.trend}
- 当前交叉状态: ${emaAnalysis.isGoldenCross ? "金叉 (Golden Cross)" : emaAnalysis.isDeathCross ? "死叉 (Death Cross)" : "趋势延续中(无新交叉)"}
- 最新K线颜色: ${emaAnalysis.signalCandleColor} (Close ${emaAnalysis.signalCandleColor === 'GREEN' ? '>' : '<'} Open)
- 前K高点: ${emaAnalysis.prevHigh}
- 前K低点: ${emaAnalysis.prevLow}
`;

  const systemPrompt = `
你是一个严格执行 **EMA趋势策略** 的交易机器人。
你 **必须** 忽略所有其他指标（RSI, MACD, Bollinger等），仅关注 **EMA21** 和 **EMA55** 的 **4H** 走势。

**市场技术面数据**:
${marketDataBlock}

**互联网情报**:
${newsContext}

**四大核心原则 (不可违背)**:

1. **趋势定义 (EMA 4H)**:
   - 依据: EMA21 (短期) 和 EMA55 (长期) 在 **4小时** 级别图表上的关系。
   - 趋势判断: EMA21 > EMA55 为多头 (BULLISH); EMA21 < EMA55 为空头 (BEARISH)。

2. **入场时机 (Entry Rules - 宽容模式)**:
   *鉴于4H K线时间跨度大，不要因错过交叉瞬间而放弃良好趋势。*
   - **做多 (Long)**: 
     - 基础条件: EMA21 > EMA55 (趋势向上)。
     - 触发时机 A: 刚刚发生金叉 (Golden Cross) 且 K线收阳。
     - 触发时机 B (宽容): 趋势已确立，但价格回调至 EMA21 附近 (Pullback Support) 且未跌破 EMA55。
     - 触发时机 C (宽容): 金叉发生后的 1-3 根K线内，价格处于合理区间，未过度偏离 (无暴涨追高嫌疑)。
   
   - **做空 (Short)**: 
     - 基础条件: EMA21 < EMA55 (趋势向下)。
     - 触发时机 A: 刚刚发生死叉 (Death Cross) 且 K线收阴。
     - 触发时机 B (宽容): 趋势已确立，但价格反弹至 EMA21 附近 (Pullback Resistance) 且未突破 EMA55。
     - 触发时机 C (宽容): 死叉发生后的 1-3 根K线内，价格处于合理区间，未过度偏离 (无暴跌追低嫌疑)。

3. **止损坚决带好 (Stop Loss)**:
   - **位置**: 必须设在前一根 4H K线的 高点(空单SL) 或 低点(多单SL)。
   - **多单 SL**: ${emaAnalysis.prevLow}
   - **空单 SL**: ${emaAnalysis.prevHigh}
   - **风控**: 单笔亏损不得超过总本金的 5%。如果计算出的 SL 导致亏损 > 5%，必须减少开仓数量。

4. **"滚仓式"加码 (Rolling)**:
   - **首仓**: 资金的 5%。
   - **加码**: 当持仓盈利达到 5% 时，立即加仓 (使用另外 5% 资金)。
   - **循环**: 每盈利 5% 加一次，直到趋势反转 (EMA再次交叉)。
   - **退出**: 一旦 EMA 发生反向交叉，立即平掉所有仓位。

5. **情报整合**: 
   - 请结合提供的【互联网情报】，在 'hot_events_overview' 字段中简要分析当前市场宏观情绪（利多/利空/中性）及可能影响趋势的重大风险事件。

**当前持仓状态**:
${positionContext}

**操作指令**:
- **BUY / SELL**: 开首仓 或 滚仓加码。
- **CLOSE**: 趋势反转全平。
- **UPDATE_TPSL**: 仅用于移动止损，严禁取消止损。
- **HOLD**: 无信号、趋势不明或持仓未达加码标准。

请输出 JSON 决策。
`;

  const responseSchema = `
  {
    "stage_analysis": "EMA 4H 趋势分析...",
    "market_assessment": "当前是否满足入场(含回调宽容)/滚仓条件...",
    "hot_events_overview": "结合上方[互联网情报]分析当前市场宏观情绪及潜在风险事件...",
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "数量(张) 或 留空由代码计算",
      "leverage": "20", 
      "stop_loss": "必须填入前K高低点",
      "profit_target": "0"
    },
    "reasoning": "严格基于四大原则解释原因"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: `账户总权益: ${totalEquity} U。可用: ${availableEquity} U。请给出操作。` }
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

    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    // --- 资金管理逻辑 (Code Logic Override for Safety) ---
    // Rule: Initial 5% of Equity. Rolling 5% of Equity.
    const targetMargin = totalEquity * 0.05; // 5% of Total Equity
    const leverage = 20; // Standardize leverage for this strategy to sensible level or user config
    
    // Calculate contracts for 5% equity
    const priceForCalc = currentPrice > 0 ? currentPrice : 1;
    const contractVal = CONTRACT_VAL_ETH * priceForCalc; // Value of 1 contract in USDT
    const targetPosValue = targetMargin * leverage;
    const targetContracts = targetPosValue / contractVal;
    
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        // Enforce 5% sizing
        decision.size = Math.max(targetContracts, 0.01).toFixed(2);
        decision.leverage = leverage.toString();
        
        // Rolling Logic Check
        if (hasPosition) {
            // If AI says BUY/SELL while holding, it must be rolling or reversing
            // If reversing, AI should say CLOSE + OPEN (Complex, but let's assume CLOSE first then next tick OPEN)
            // If Rolling:
            if (!rollingTrigger) {
                 // Prevent adding if profit < 5%
                 console.warn("AI attempted to add position but profit < 5%. Forcing HOLD.");
                 decision.action = 'HOLD';
                 decision.reasoning += " [系统拦截: 未达 5% 盈利加仓标准]";
            }
        }
    } else {
        decision.size = "0";
        decision.leverage = leverage.toString();
    }
    
    // Fill required fields
    // Ensure news analysis is populated even if AI misses it (though schema enforces it)
    if (!decision.hot_events_overview) {
        decision.hot_events_overview = "AI未提供具体情报分析";
    }
    decision.eth_analysis = `EMA21: ${emaAnalysis.ema21.toFixed(1)}, EMA55: ${emaAnalysis.ema55.toFixed(1)}`;

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
