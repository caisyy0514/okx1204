
import React, { useEffect, useState } from 'react';
import CandleChart from './components/CandleChart';
import SettingsModal from './components/SettingsModal';
import HistoryModal from './components/HistoryModal';
import DecisionReport from './components/DecisionReport';
import { MarketDataCollection, AccountContext, AIDecision, SystemLog, AppConfig, PositionData } from './types';
import { Settings, Play, Pause, Activity, Terminal, History, Wallet, TrendingUp, AlertTriangle, ExternalLink, ShieldCheck, Crosshair, DollarSign, Layers, X } from 'lucide-react';
import { DEFAULT_CONFIG, INSTRUMENT_ID, CONTRACT_VAL_ETH } from './constants';

const App: React.FC = () => {
  const [marketData, setMarketData] = useState<MarketDataCollection | null>(null);
  const [accountData, setAccountData] = useState<AccountContext | null>(null);
  const [decision, setDecision] = useState<AIDecision | null>(null);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isFullReportOpen, setIsFullReportOpen] = useState(false);

  // Fetch Status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        setMarketData(data.marketData);
        setAccountData(data.accountData);
        setDecision(data.latestDecision);
        setLogs(data.logs);
        setIsRunning(data.isRunning);
        setConfig(data.config);
      } catch (e) {
        console.error("Fetch status failed", e);
      }
    };

    const interval = setInterval(fetchStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const toggleStrategy = async () => {
    try {
      await fetch('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running: !isRunning })
      });
      setIsRunning(!isRunning);
    } catch (e) {
      console.error(e);
    }
  };

  const saveConfig = async (newConfig: AppConfig) => {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
      setConfig(newConfig);
      setIsSettingsOpen(false);
    } catch (e) {
      console.error(e);
    }
  };

  // Helper to render a single position card
  const renderPositionCard = (pos: PositionData) => {
    const isLong = pos.posSide === 'long';
    const upl = parseFloat(pos.upl);
    const sizeEth = (parseFloat(pos.pos) * CONTRACT_VAL_ETH).toFixed(2);
    const margin = parseFloat(pos.margin).toFixed(2);
    
    return (
      <div key={pos.instId + pos.posSide} className="bg-[#121214] border border-okx-border rounded-lg p-4 shadow-sm hover:border-okx-primary/50 transition-colors">
        {/* Header */}
        <div className="flex justify-between items-center mb-3 pb-2 border-b border-gray-800">
           <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 text-xs font-bold rounded uppercase ${isLong ? 'bg-okx-up/20 text-okx-up' : 'bg-okx-down/20 text-okx-down'}`}>
                {pos.posSide}
              </span>
              <span className="font-bold text-white text-sm">{pos.instId}</span>
              <span className="text-xs text-okx-subtext bg-gray-800 px-1.5 rounded">{pos.mgnMode}</span>
           </div>
           <div className={`text-sm font-mono font-bold ${upl >= 0 ? 'text-okx-up' : 'text-okx-down'}`}>
              {upl > 0 ? '+' : ''}{upl} U
           </div>
        </div>

        {/* Grid Stats */}
        <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-xs">
           <div className="space-y-1">
              <div className="text-okx-subtext flex items-center gap-1">
                 <Layers size={10} /> 持仓规模
              </div>
              <div className="text-gray-200 font-mono">
                 {pos.pos} 张 <span className="text-gray-500">({sizeEth} ETH)</span>
              </div>
           </div>

           <div className="space-y-1 text-right">
              <div className="text-okx-subtext flex items-center justify-end gap-1">
                 <DollarSign size={10} /> 保证金 (Margin)
              </div>
              <div className="text-gray-200 font-mono">{margin} U</div>
           </div>

           <div className="space-y-1">
              <div className="text-okx-subtext">持仓均价 (Avg)</div>
              <div className="text-white font-mono">{pos.avgPx}</div>
           </div>

           <div className="space-y-1 text-right">
              <div className="text-yellow-500/90 flex items-center justify-end gap-1 font-bold">
                 <AlertTriangle size={10} /> 盈亏平衡 (BE)
              </div>
              <div className="text-yellow-500 font-mono font-bold">{pos.breakEvenPx || '--'}</div>
           </div>

           <div className="col-span-2 h-px bg-gray-800/50"></div>

           <div className="space-y-1">
              <div className="text-okx-subtext flex items-center gap-1">
                 <ShieldCheck size={10} /> 止损触发 (SL)
              </div>
              <div className="text-orange-400 font-mono">{pos.slTriggerPx || '未设置'}</div>
           </div>

           <div className="space-y-1 text-right">
              <div className="text-okx-subtext flex items-center justify-end gap-1">
                 <Crosshair size={10} /> 止盈触发 (TP)
              </div>
              <div className="text-green-400 font-mono">{pos.tpTriggerPx || '未设置'}</div>
           </div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen bg-okx-bg text-okx-text font-sans selection:bg-okx-primary selection:text-white flex flex-col overflow-hidden">
      {/* Header (Fixed) */}
      <header className="h-14 shrink-0 border-b border-okx-border bg-okx-card/50 backdrop-blur-md z-40">
        <div className="max-w-[1920px] mx-auto px-4 h-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-colors duration-500 ${isRunning ? 'bg-okx-up animate-pulse' : 'bg-okx-subtext'}`}></div>
            <h1 className="font-bold text-lg tracking-tight flex items-center gap-2">
              ETH 10U 战神 
              <span className="text-xs font-normal text-okx-subtext px-2 py-0.5 bg-okx-border rounded-full">Cloud Pro</span>
            </h1>
          </div>
          
          <div className="flex items-center gap-2">
             <div className="hidden md:flex items-center gap-6 mr-6 text-xs font-mono text-okx-subtext bg-okx-bg/30 px-3 py-1.5 rounded-lg border border-okx-border/50">
                <div className="flex items-center gap-2">
                   <Wallet size={14} className="text-gray-400"/>
                   权益: <span className="text-white font-bold">{accountData?.balance.totalEq || '0.00'}</span>
                </div>
                <div className="w-px h-3 bg-gray-700"></div>
                <div>
                   可用: <span className="text-white font-bold">{accountData?.balance.availEq || '0.00'}</span>
                </div>
             </div>

            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="p-2 hover:bg-okx-border rounded-lg text-okx-subtext hover:text-white transition-colors flex items-center gap-2"
              title="历史回溯"
            >
              <History size={18} />
              <span className="text-xs font-bold hidden sm:block">历史推演</span>
            </button>

            <button 
              onClick={toggleStrategy}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg font-bold text-sm transition-all shadow-lg ${
                isRunning 
                  ? 'bg-okx-down/10 text-okx-down hover:bg-okx-down/20 border border-okx-down/20' 
                  : 'bg-okx-up text-okx-bg hover:bg-okx-up/90'
              }`}
            >
              {isRunning ? <Pause size={16} /> : <Play size={16} />}
              {isRunning ? '停止策略' : '启动引擎'}
            </button>

            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 hover:bg-okx-border rounded-lg text-okx-subtext hover:text-white transition-colors"
            >
              <Settings size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content (Fixed Layout) */}
      <main className="flex-1 overflow-hidden p-4">
        <div className="max-w-[1920px] mx-auto w-full h-full grid grid-cols-1 lg:grid-cols-12 gap-4">
        
          {/* Left Col: Chart (60%) & Logs (40%) */}
          <div className="lg:col-span-8 flex flex-col gap-4 h-full min-h-0">
            {/* Chart Area */}
            <div className="h-[60%] bg-okx-card rounded-xl border border-okx-border overflow-hidden relative group shadow-lg shrink-0">
               {marketData?.candles15m && marketData.candles15m.length > 0 ? (
                  <CandleChart data={marketData.candles15m} />
               ) : (
                  <div className="w-full h-full flex items-center justify-center text-okx-subtext">
                    <Activity className="animate-pulse mr-2" /> 等待市场数据...
                  </div>
               )}
               {/* Floating Ticker Info */}
               <div className="absolute top-4 left-4 bg-black/60 backdrop-blur px-4 py-2 rounded-lg border border-white/10 text-xs font-mono shadow-xl pointer-events-none">
                  <div className="text-2xl font-bold text-white mb-1 flex items-center gap-2">
                    {marketData?.ticker?.last || '0.00'}
                    <span className="text-xs font-normal text-okx-subtext px-1.5 py-0.5 bg-gray-800 rounded">USDT</span>
                  </div>
                  <div className="flex gap-4 text-gray-400">
                      <span className="flex items-center gap-1"><TrendingUp size={10}/> 24H: {marketData?.ticker?.volCcy24h ? (parseInt(marketData.ticker.volCcy24h)/1000000).toFixed(1) + 'M' : '0'}</span>
                  </div>
               </div>
            </div>

            {/* Logs Area - Fixed Height (Remaining) */}
            <div className="h-[40%] bg-okx-card rounded-xl border border-okx-border flex flex-col shadow-lg overflow-hidden shrink-0">
              <div className="px-4 py-2 border-b border-okx-border bg-okx-bg/50 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <Terminal size={14} className="text-okx-primary" />
                  <span className="text-xs font-bold text-okx-subtext uppercase tracking-wider">System Logs (Live)</span>
                </div>
                <div className="text-[10px] text-gray-500">倒序排列 (最新在前)</div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1.5 custom-scrollbar bg-[#0c0c0e]">
                {logs.length === 0 && <div className="text-okx-subtext opacity-50 italic text-center py-4">System initialized. Waiting for events...</div>}
                {/* Reverse logs to show newest first */}
                {logs.slice().reverse().map((log) => (
                  <div key={log.id} className="flex gap-2 hover:bg-white/5 p-1 rounded leading-relaxed border-b border-white/5 last:border-0">
                    <span className="text-gray-600 select-none shrink-0 w-16">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className={`font-bold w-16 text-center shrink-0 ${
                      log.type === 'ERROR' ? 'text-okx-down' :
                      log.type === 'SUCCESS' ? 'text-okx-up' :
                      log.type === 'WARNING' ? 'text-yellow-500' :
                      log.type === 'TRADE' ? 'text-blue-400' :
                      'text-gray-400'
                    }`}>[{log.type}]</span>
                    <span className="text-gray-300 break-all">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Col: Positions (Flex) & AI Summary (Fixed Bottom) */}
          <div className="lg:col-span-4 flex flex-col gap-4 h-full min-h-0">
             
              {/* 1. Multi-Position Dashboard (Flex Grow) */}
              <div className="flex-1 bg-okx-card rounded-xl border border-okx-border shadow-lg overflow-hidden flex flex-col min-h-0">
                  <div className="px-4 py-3 border-b border-okx-border bg-okx-bg/30 flex justify-between items-center shrink-0">
                      <div className="flex items-center gap-2 font-bold text-white text-sm">
                          <Wallet size={16} className="text-blue-500"/>
                          持仓监控 ({accountData?.positions.length || 0})
                      </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                     {accountData && accountData.positions.length > 0 ? (
                         accountData.positions.map(p => renderPositionCard(p))
                     ) : (
                         <div className="h-full flex flex-col items-center justify-center text-okx-subtext opacity-40 gap-2">
                             <Wallet size={32} />
                             <span className="text-sm">当前无持仓 / 空仓观望</span>
                         </div>
                     )}
                  </div>
              </div>

              {/* 2. AI Compact Summary (Fixed Height) */}
              <div className="h-auto bg-okx-card rounded-xl border border-okx-border flex flex-col overflow-hidden shadow-lg shrink-0">
                  <div className="p-3 border-b border-okx-border bg-gradient-to-r from-purple-900/20 to-transparent flex justify-between items-center">
                      <h2 className="font-bold text-white text-sm flex items-center gap-2">
                          <Activity size={16} className="text-purple-500" />
                          AI 决策核心
                      </h2>
                      <span className="text-[10px] font-mono text-gray-500">
                          {decision?.timestamp ? new Date(decision.timestamp).toLocaleTimeString() : '--:--:--'}
                      </span>
                  </div>
                  
                  <div className="p-4 bg-[#121214]">
                      {decision ? (
                          <div className="space-y-4">
                              {/* Top Row: Action & Confidence */}
                              <div className="flex items-center justify-between">
                                  <span className={`px-4 py-1.5 rounded text-sm font-bold shadow-sm tracking-wide ${
                                      decision.action === 'BUY' ? 'bg-okx-up text-black' :
                                      decision.action === 'SELL' ? 'bg-okx-down text-white' :
                                      decision.action === 'UPDATE_TPSL' ? 'bg-yellow-500 text-black' :
                                      'bg-gray-700 text-gray-300'
                                  }`}>
                                      {decision.action}
                                  </span>
                                  <div className="text-right">
                                      <div className="text-[10px] text-okx-subtext">AI 置信度</div>
                                      <div className="text-purple-400 font-bold font-mono">{decision.trading_decision?.confidence}</div>
                                  </div>
                              </div>

                              {/* Execution Plan Grid */}
                              <div className="grid grid-cols-2 gap-2 text-xs bg-black/20 p-3 rounded border border-gray-800">
                                   <div>
                                       <span className="text-gray-500 block">执行数量</span>
                                       <span className="text-white font-mono font-bold">
                                           {decision.size !== "0" ? `${decision.size} 张` : '--'}
                                       </span>
                                   </div>
                                   <div className="text-right">
                                       <span className="text-gray-500 block">建议杠杆</span>
                                       <span className="text-yellow-500 font-mono">
                                           {decision.leverage !== "0" ? `${decision.leverage}x` : '--'}
                                       </span>
                                   </div>
                                   <div className="pt-2">
                                       <span className="text-gray-500 block">止损价格 (SL)</span>
                                       <span className="text-orange-400 font-mono font-bold">
                                           {decision.trading_decision?.stop_loss || '未设定'}
                                       </span>
                                   </div>
                                   <div className="text-right pt-2">
                                       <span className="text-gray-500 block">止盈价格 (TP)</span>
                                       <span className="text-green-500 font-mono">
                                           {decision.trading_decision?.profit_target || '未设定'}
                                       </span>
                                   </div>
                              </div>

                              <button 
                                onClick={() => setIsFullReportOpen(true)}
                                className="w-full py-2 bg-gray-800 hover:bg-gray-700 text-xs text-okx-subtext hover:text-white rounded border border-gray-700 transition-colors flex items-center justify-center gap-2"
                              >
                                  <ExternalLink size={12} /> 查看完整推演报告
                              </button>
                          </div>
                      ) : (
                          <div className="py-6 flex flex-col items-center justify-center text-okx-subtext opacity-50">
                              <div className="animate-spin mb-2 text-okx-primary"><Activity size={20} /></div>
                              <p className="text-xs">正在连接深思引擎...</p>
                          </div>
                      )}
                  </div>
              </div>
          </div>

        </div>
      </main>

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        config={config}
        onSave={saveConfig}
      />
      
      <HistoryModal
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
      />

      {/* Full Report Modal */}
      {isFullReportOpen && decision && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-okx-card w-full max-w-4xl max-h-[85vh] rounded-xl border border-okx-border shadow-2xl flex flex-col">
                  <div className="p-4 border-b border-okx-border flex justify-between items-center">
                      <h3 className="text-lg font-bold text-white flex items-center gap-2">
                          <Activity size={20} className="text-purple-500"/> AI 完整推演报告
                      </h3>
                      <button onClick={() => setIsFullReportOpen(false)} className="text-okx-subtext hover:text-white">
                          <X size={24} />
                      </button>
                  </div>
                  <div className="flex-1 overflow-hidden p-0">
                      <DecisionReport decision={decision} />
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};

export default App;
