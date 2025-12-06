import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Play, Pause, RefreshCw, Activity, Zap, TrendingUp, AlertCircle, Terminal, Shield, Target, Brain, X, Eye, Flame, Cloud } from 'lucide-react';
import { MarketDataCollection, AccountContext, AIDecision, SystemLog, AppConfig } from './types';
import { DEFAULT_CONFIG, INSTRUMENT_ID, CONTRACT_VAL_ETH } from './constants';
import SettingsModal from './components/SettingsModal';
import CandleChart from './components/CandleChart';

const App: React.FC = () => {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAnalysisOpen, setIsAnalysisOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  
  const [marketData, setMarketData] = useState<MarketDataCollection | null>(null);
  const [accountData, setAccountData] = useState<AccountContext | null>(null);
  
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [latestDecision, setLatestDecision] = useState<AIDecision | null>(null);

  // Poll Server Status
  const fetchStatus = useCallback(async () => {
    try {
        const res = await fetch('/api/status');
        
        if (!res.ok) {
           return; 
        }

        const text = await res.text();
        try {
            const data = JSON.parse(text);
            setIsRunning(data.isRunning);
            setMarketData(data.marketData);
            setAccountData(data.accountData);
            setLatestDecision(data.latestDecision);
            setLogs(data.logs); 
        } catch (parseError) {
             // Ignore
        }
    } catch (e) {
        // Ignore
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchStatus, 1000);
    fetchStatus();
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const toggleRunning = async () => {
      try {
        await fetch('/api/toggle', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ running: !isRunning })
        });
        fetchStatus();
      } catch (e) {
        console.error("Failed to toggle:", e);
      }
  };

  const saveConfig = async (newConfig: AppConfig) => {
      try {
        await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(newConfig)
        });
        setConfig(newConfig);
        setIsSettingsOpen(false);
      } catch (e) {
        console.error("Failed to save config:", e);
      }
  };

  const formatPrice = (p?: string) => parseFloat(p || "0").toLocaleString('en-US', { minimumFractionDigits: 2 });
  const formatPct = (p?: string) => parseFloat(p || "0").toFixed(2) + '%';

  return (
    <div className="min-h-screen bg-okx-bg text-okx-text font-sans selection:bg-okx-primary selection:text-white">
      {/* HEADER */}
      <header className="h-16 border-b border-okx-border flex items-center justify-between px-6 bg-okx-card/50 backdrop-blur-md sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-red-600 to-purple-600 rounded-lg flex items-center justify-center text-white font-bold shadow-lg shadow-red-500/20">
            ⚔️
          </div>
          <div>
            <h1 className="font-bold text-white leading-tight">ETH 10U战神系统</h1>
            <div className="text-xs text-okx-subtext flex items-center gap-1">
              <Cloud size={12} className="text-blue-400"/>
              {config.isSimulation ? '云端模拟 (Server Sim)' : '云端实盘 (Server Live)'}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-4 py-1.5 bg-okx-bg border border-okx-border rounded-full text-sm">
            <span className="text-okx-subtext">总权益:</span>
            <span className={`font-mono font-bold ${parseFloat(accountData?.balance.totalEq || "0") < 20 ? 'text-red-400' : 'text-green-400'}`}>
                {formatPrice(accountData?.balance.totalEq)} USDT
            </span>
          </div>
          
          <button 
            onClick={toggleRunning}
            className={`flex items-center gap-2 px-4 py-2 rounded font-medium transition-all ${
              isRunning 
                ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20' 
                : 'bg-okx-primary text-white hover:bg-blue-600'
            }`}
          >
            {isRunning ? <><Pause size={18} /> 暂停云端</> : <><Play size={18} /> 启动云端</>}
          </button>
          
          <button onClick={() => setIsSettingsOpen(true)} className="p-2 text-okx-subtext hover:text-white">
            <Settings size={20} />
          </button>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main className="p-6 grid grid-cols-12 gap-6 max-w-[1600px] mx-auto">
        
        {/* LEFT COLUMN: DATA */}
        <div className="col-span-12 lg:col-span-3 space-y-4">
          {/* Market Card */}
          <div className="bg-okx-card border border-okx-border rounded-xl p-5">
            <div className="flex justify-between items-start">
                 <div>
                    <div className="text-okx-subtext text-sm">{INSTRUMENT_ID}</div>
                    <div className="text-3xl font-bold text-white font-mono mt-1">
                    {formatPrice(marketData?.ticker?.last)}
                    </div>
                 </div>
                 <div className="text-right">
                    <div className={`text-sm font-bold ${parseFloat(marketData?.ticker?.open24h || "0") < parseFloat(marketData?.ticker?.last || "0") ? "text-okx-up" : "text-okx-down"}`}>
                        {formatPct(marketData ? ((parseFloat(marketData.ticker!.last) - parseFloat(marketData.ticker!.open24h)) / parseFloat(marketData.ticker!.open24h) * 100).toString() : "0")}
                    </div>
                 </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-okx-subtext">
                <div className="bg-okx-bg p-2 rounded">
                    <div>资金费率</div>
                    <div className="text-white font-mono">{formatPct(marketData?.fundingRate)}</div>
                </div>
                <div className="bg-okx-bg p-2 rounded">
                    <div>持仓量 (OI)</div>
                    <div className="text-white font-mono">{parseInt(marketData?.openInterest || "0").toLocaleString()}</div>
                </div>
            </div>
          </div>

          {/* Position Cards (Render All Positions) */}
          <div className="space-y-3">
             <div className="flex items-center gap-2 text-white font-bold text-sm px-1">
                <Shield size={16} /> 账户持仓 ({accountData?.positions.length || 0})
             </div>
             
             {accountData?.positions && accountData.positions.length > 0 ? (
                accountData.positions.map((pos, idx) => (
                    <div key={`${pos.instId}-${pos.posSide}-${idx}`} className={`bg-okx-card border rounded-xl p-5 relative overflow-hidden ${pos ? 'border-okx-primary' : 'border-okx-border'}`}>
                        <div className="absolute top-0 right-0 p-1 bg-okx-primary text-xs font-bold text-white rounded-bl-lg">
                            {pos.instId}
                        </div>
                        <div className="space-y-3 text-sm mt-2">
                            <div className="flex justify-between">
                                <span className="text-okx-subtext">方向</span>
                                <span className={`font-bold uppercase ${pos.posSide === 'long' ? 'text-okx-up' : 'text-okx-down'}`}>
                                    {pos.posSide}
                                </span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-okx-subtext">规模</span>
                                <span className="text-white font-mono">{pos.pos} 张</span>
                            </div>
                            <div className="flex justify-between border-t border-okx-border pt-2">
                                <span className="text-okx-subtext">保证金</span>
                                <span className="text-white font-mono">{pos.margin} U</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-okx-subtext">持仓市值</span>
                                <span className="text-white font-mono">{(parseFloat(pos.pos) * CONTRACT_VAL_ETH * parseFloat(pos.avgPx)).toLocaleString(undefined, {maximumFractionDigits:2})} U</span>
                            </div>
                            <div className="flex justify-between border-t border-okx-border pt-2">
                                <span className="text-okx-subtext">未结盈亏</span>
                                <span className={`font-mono font-bold ${parseFloat(pos.upl) > 0 ? 'text-okx-up' : 'text-okx-down'}`}>
                                    {pos.upl} U ({formatPct(pos.uplRatio)})
                                </span>
                            </div>
                            {(pos.slTriggerPx || pos.tpTriggerPx) && (
                                <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-okx-border">
                                    <div className="bg-okx-bg p-1.5 rounded text-center">
                                        <div className="text-xs text-okx-subtext">止损 (SL)</div>
                                        <div className="text-xs font-mono text-red-400">{pos.slTriggerPx || "--"}</div>
                                    </div>
                                    <div className="bg-okx-bg p-1.5 rounded text-center">
                                        <div className="text-xs text-okx-subtext">止盈 (TP)</div>
                                        <div className="text-xs font-mono text-green-400">{pos.tpTriggerPx || "--"}</div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                ))
             ) : (
                <div className="bg-okx-card border border-okx-border rounded-xl p-6 text-okx-subtext text-center text-sm">
                    空仓等待战机...
                </div>
             )}
          </div>
        </div>

        {/* MIDDLE COLUMN: CHART */}
        {/* Fixed height to prevent page stretching/pulling as per user request */}
        <div className="col-span-12 lg:col-span-6 h-[500px] bg-okx-card border border-okx-border rounded-xl p-1 flex flex-col overflow-hidden">
           <CandleChart data={marketData?.candles15m || []} />
        </div>

        {/* RIGHT COLUMN: STRATEGY */}
        <div className="col-span-12 lg:col-span-3 flex flex-col gap-4 h-[500px] lg:h-auto">
           {/* Strategy Status */}
           <div className="bg-gradient-to-b from-gray-800 to-okx-card border border-okx-border rounded-xl p-5 flex flex-col">
              <div className="flex items-center gap-2 text-purple-400 font-bold mb-3">
                 <Brain size={18} /> 云端战神引擎
              </div>
              
              {latestDecision ? (
                  <div className="space-y-3 flex-1">
                      <div className="flex items-center justify-between">
                          <span className="text-xs text-okx-subtext">当前阶段</span>
                          <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-1 rounded border border-purple-500/30 truncate max-w-[150px]">
                              {latestDecision.stage_analysis.split(' ')[0] || "分析中"}
                          </span>
                      </div>
                      
                      <div className="flex items-center justify-between bg-okx-bg p-3 rounded-lg border border-okx-border">
                          <div className="text-center">
                              <div className="text-xs text-okx-subtext mb-1">建议</div>
                              <div className={`text-xl font-bold ${
                                  latestDecision.action === 'BUY' ? 'text-okx-up' : 
                                  latestDecision.action === 'SELL' ? 'text-okx-down' : 
                                  latestDecision.action === 'UPDATE_TPSL' ? 'text-yellow-400' : 'text-gray-400'
                              }`}>{latestDecision.action === 'UPDATE_TPSL' ? 'TPSL' : latestDecision.action}</div>
                          </div>
                          <div className="h-8 w-px bg-okx-border mx-2"></div>
                          <div className="text-center flex-1">
                               <div className="text-xs text-okx-subtext mb-1">置信度</div>
                               <div className="w-full bg-gray-700 h-2 rounded-full mt-1">
                                   <div 
                                      className="h-full bg-purple-500 rounded-full transition-all" 
                                      style={{width: latestDecision.trading_decision?.confidence || '0%'}}
                                   ></div>
                               </div>
                               <div className="text-xs text-right mt-1">{latestDecision.trading_decision?.confidence}</div>
                          </div>
                      </div>

                      <div className="text-xs text-okx-subtext italic line-clamp-3 bg-okx-bg/50 p-2 rounded">
                          "{latestDecision.reasoning}"
                      </div>
                      
                      <button 
                        onClick={() => setIsAnalysisOpen(true)}
                        className="w-full mt-1 flex items-center justify-center gap-2 bg-okx-primary/10 hover:bg-okx-primary/20 border border-okx-primary/30 py-2 rounded text-xs text-okx-primary transition-colors font-bold"
                      >
                        <Eye size={14} /> 查看完整推演报告
                      </button>
                  </div>
              ) : (
                  <div className="text-center text-okx-subtext text-sm py-8 flex flex-col items-center">
                      <div className="animate-spin mb-2"><RefreshCw size={16}/></div>
                      AI 正在云端扫描战场...
                  </div>
              )}
           </div>

           {/* Logs */}
           <div className="flex-1 bg-black/40 border border-okx-border rounded-xl p-4 overflow-hidden flex flex-col max-h-[300px] lg:max-h-none">
             <div className="flex items-center gap-2 mb-2 text-okx-subtext text-xs uppercase tracking-wider font-semibold">
                <Terminal size={12} /> 云端战地日志
             </div>
             <div className="flex-1 overflow-y-auto space-y-2 pr-2 font-mono text-xs">
                 {[...logs].reverse().map(log => (
                    <div key={log.id} className="break-words border-b border-gray-800/50 pb-1 mb-1 last:border-0">
                        <span className="text-gray-500">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                        <span className={
                            log.type === 'ERROR' ? 'text-red-500' :
                            log.type === 'SUCCESS' ? 'text-green-500' :
                            log.type === 'TRADE' ? 'text-yellow-400' :
                            'text-gray-300'
                        }>
                            {log.message}
                        </span>
                    </div>
                 ))}
             </div>
          </div>
        </div>

      </main>

      {/* Analysis Details Modal */}
      {isAnalysisOpen && latestDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-okx-card w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-xl border border-okx-border shadow-2xl flex flex-col">
                <div className="p-4 border-b border-okx-border flex justify-between items-center bg-okx-card">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                        <Brain size={20} className="text-purple-500"/> 
                        云端 AI 推演报告
                    </h3>
                    <button onClick={() => setIsAnalysisOpen(false)} className="text-okx-subtext hover:text-white transition-colors">
                        <X size={24} />
                    </button>
                </div>
                
                <div className="p-6 overflow-y-auto space-y-6 font-mono text-sm leading-relaxed text-gray-300">
                    <div className="space-y-2">
                        <h4 className="flex items-center gap-2 text-purple-400 font-bold uppercase tracking-wider text-xs">
                            <Activity size={14}/> 01. 资金阶段分析
                        </h4>
                        <div className="p-4 bg-gray-900/50 border border-purple-500/20 rounded-lg shadow-inner">
                            {latestDecision.stage_analysis}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <h4 className="flex items-center gap-2 text-orange-400 font-bold uppercase tracking-wider text-xs">
                            <Flame size={14}/> 02. 实时热点情报
                        </h4>
                        <div className="p-4 bg-gray-900/50 border border-orange-500/20 rounded-lg text-orange-50">
                            {latestDecision.hot_events_overview}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                             <h4 className="flex items-center gap-2 text-blue-400 font-bold uppercase tracking-wider text-xs">
                                <TrendingUp size={14}/> 03. 市场整体评估
                             </h4>
                             <div className="p-4 bg-gray-900/50 border border-blue-500/20 rounded-lg h-full">
                                {latestDecision.market_assessment}
                             </div>
                        </div>
                        <div className="space-y-2">
                             <h4 className="flex items-center gap-2 text-indigo-400 font-bold uppercase tracking-wider text-xs">
                                <Zap size={14}/> 04. ETH 专项分析
                             </h4>
                             <div className="p-4 bg-gray-900/50 border border-indigo-500/20 rounded-lg h-full">
                                {latestDecision.eth_analysis}
                             </div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <h4 className="flex items-center gap-2 text-yellow-400 font-bold uppercase tracking-wider text-xs">
                            <Target size={14}/> 05. 最终决策推理
                        </h4>
                        <div className="p-4 bg-gray-900/50 border border-yellow-500/20 rounded-lg border-l-4 border-l-yellow-500">
                            {latestDecision.reasoning}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <h4 className="flex items-center gap-2 text-red-400 font-bold uppercase tracking-wider text-xs">
                            <AlertCircle size={14}/> 06. 策略失效条件
                        </h4>
                        <div className="p-3 bg-red-900/10 border border-red-500/20 rounded text-red-300">
                            {latestDecision.trading_decision?.invalidation_condition}
                        </div>
                    </div>
                </div>
            </div>
        </div>
      )}

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        config={config} 
        onSave={saveConfig} 
      />
    </div>
  );
};

export default App;
