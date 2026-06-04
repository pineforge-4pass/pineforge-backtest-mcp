import { spawn } from "node:child_process";
const C={g:"\x1b[32m",c:"\x1b[36m",y:"\x1b[33m",d:"\x1b[90m",b:"\x1b[1m",r:"\x1b[0m",m:"\x1b[35m"};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SRC=`//@version=6
strategy("momentum")
len = input.int(10, "Lookback")
if close > close[len]
    strategy.entry("L", strategy.long)
if close < close[len]
    strategy.close("L")`;
const OV={initial_capital:100000,default_qty_type:"percent_of_equity",default_qty_value:20};
const CSV="/work/demo.csv";
const child=spawn("docker",["run","--rm","-i","-v",process.cwd()+":/work","pineforge-codegen-mcp:local"],{stdio:["pipe","pipe","ignore"]});
let buf="";const pend=new Map();let id=1;
child.stdout.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}});
const rpc=(meth,par)=>new Promise(r=>{const i=id++;pend.set(i,r);child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:meth,params:par})+"\n")});
const call=async(n,a)=>{const r=await rpc("tools/call",{name:n,arguments:a});const t=r.result?.content?.[0]?.text??"";try{return JSON.parse(t)}catch{return t}};
const line=(ic,n,det)=>console.log(`${C.g}${ic}${C.r} ${C.b}${n.padEnd(19)}${C.r}${C.d}→${C.r} ${det}`);

await rpc("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"demo",version:"0"}});
child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized",params:{}})+"\n");

console.log(`\n${C.m}${C.b}  pineforge-codegen-mcp${C.r}  ${C.d}Pine v6 → C++ → backtest, fully local${C.r}\n`);
await sleep(800);
const info=await call("engine_info",{});
line("●","engine_info",`${C.c}mode=${info.mode}  baked_in=${info.baked_in}  engine=v${info.version}${C.r}`); await sleep(1000);

const f=await call("fetch_binance_ohlcv",{symbol:"BTCUSDT",interval:"1h",market:"spot",limit:1000,output_path:CSV});
line("⤓","fetch_binance_ohlcv",`BTCUSDT 1h ${C.d}·${C.r} ${C.y}${f.bars}${C.r} bars ${C.d}→${C.r} ${C.c}demo.csv${C.r}`); await sleep(1100);

const cpp=await call("transpile_pine",{source:SRC});
line("✎","transpile_pine",`momentum.pine ${C.d}→${C.r} C++ ${C.y}${cpp.length} B${C.r}`); await sleep(1000);

const bt=await call("backtest_pine",{source:SRC,ohlcv_csv_path:CSV,overrides:OV,inputs:{Lookback:10}});
const s=bt.summary||{};
line("▶","backtest_pine",`${s.bars_processed} bars ${C.d}→${C.r} trades=${C.y}${s.total_trades}${C.r} net=${(s.net_pnl??0)>=0?C.g:C.y}${(s.net_pnl??0).toFixed(0)}${C.r} win=${C.c}${(s.win_rate_pct??0).toFixed(0)}%${C.r}`); await sleep(1100);

const g=await call("backtest_pine_grid",{source:SRC,ohlcv_csv_path:CSV,fixed_overrides:OV,inputs:{Lookback:[3,5,10,20,40]},concurrency:3,sort_by:"net_pnl"});
const bst=g.best||{};
line("⊞","backtest_pine_grid",`${C.y}${g.total_combinations} combos${C.r} ${C.d}→${C.r} best Lookback=${C.c}${bst.inputs?.Lookback}${C.r} net=${(bst.summary?.net_pnl??0)>=0?C.g:C.y}${(bst.summary?.net_pnl??0).toFixed(0)}${C.r} win=${C.c}${(bst.summary?.win_rate_pct??0).toFixed(0)}%${C.r}`); await sleep(1300);

console.log(`\n${C.d}  no host Docker · no API key · npx -y @pineforge/codegen-mcp${C.r}`);
child.stdin.end();child.kill();await sleep(150);process.exit(0);
