'use strict';
require('dotenv').config();
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { sign } = require('./shared/protocol');

const CONFIG = {
  agentId: process.env.AGENT_ID || os.hostname(),
  token: process.env.AUTH_TOKEN,
  operatorHost: (process.env.OPERATOR_HOST || '').trim(),
  settingsFile: path.join(process.env.ProgramData || 'C:\\ProgramData', 'ComputerSwarm', 'agent-settings.json'),
  operatorWsPort: Number(process.env.OPERATOR_WS_PORT || 3001),
  agentPort: Number(process.env.AGENT_PORT || 8080),
  discoveryPort: Number(process.env.DISCOVERY_PORT || 41234),
  heartbeatMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 5000),
  stateMs: Number(process.env.STATE_INTERVAL_MS || 3000),
  reconnectMs: Number(process.env.RECONNECT_DELAY_MS || 3000),
  discoveryTimeoutMs: Number(process.env.DISCOVERY_TIMEOUT_MS || 2500),
  releaseFile: process.env.AGENT_RELEASE_FILE || path.join(process.env.ProgramData || 'C:\\ProgramData', 'ComputerSwarm', 'release.flag'),
  taskName: process.env.AGENT_TASK_NAME || 'Computer Swarm Agent Watchdog'
};
if (!CONFIG.token) CONFIG.token = 'DMPS_SWARM_2026_SECRET_83921';
// Persist first-run settings outside the install folder so the Agent remains a single-file app.
try {
  const saved = JSON.parse(fs.readFileSync(CONFIG.settingsFile, 'utf8'));
  if (!CONFIG.operatorHost && typeof saved.operatorHost === 'string') CONFIG.operatorHost = saved.operatorHost.trim();
} catch {}

let ws = null, reconnectTimer = null, stopped = false, discoveredOperator = null;
const log = (...x) => { const line = `[${new Date().toLocaleTimeString()}] ${x.join(' ')}`; console.log(line); try { process.emit('swarm-log', line); } catch {} };
function isReleased(){ try { return fs.existsSync(CONFIG.releaseFile); } catch { return false; } }
function ensureReleaseDir(){ try { fs.mkdirSync(path.dirname(CONFIG.releaseFile), {recursive:true}); } catch {} }
function disableWatchdog(){
  if(process.platform!=='win32') return;
  try { execFile('schtasks.exe',['/Change','/TN',CONFIG.taskName,'/DISABLE'],{windowsHide:true},()=>{}); } catch {}
}
function operatorRelease(){
  ensureReleaseDir();
  try { fs.writeFileSync(CONFIG.releaseFile, JSON.stringify({releasedAt:new Date().toISOString(),agentId:CONFIG.agentId}), 'utf8'); } catch {}
  disableWatchdog();
  log('Operator-authorized release received. Agent will stop and remain stopped until re-enabled.');
  stopped=true; clearTimeout(reconnectTimer);
  try { ws?.close(1000,'operator release'); } catch {}
  try { httpServer.close(); } catch {}
  setTimeout(()=>process.exit(0),200);
}


function localIP() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) return n.address;
  return '127.0.0.1';
}
function execFileP(file, args = [], timeout = 6000) {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => resolve(err ? '' : stdout || '')));
}
function execFileResult(file, args = [], timeout = 6000) {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err })));
}
function parseCsvLine(line) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function getProcessInventory() {
  if (process.platform !== 'win32') {
    const out = await execFileP('ps', ['-eo', 'pid=,comm=']);
    return out.split(/\r?\n/).map(line => {
      const m = line.trim().match(/^(\d+)\s+(.+)$/); return m ? { pid:Number(m[1]), name:m[2].trim(), windowTitle:'', user:'', session:'', memory:'' } : null;
    }).filter(Boolean).slice(0, 500);
  }
  const out = await execFileP('tasklist', ['/V', '/FO', 'CSV', '/NH']);
  const rows = [];
  for (const line of out.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const p = parseCsvLine(line);
    if (p.length < 9) continue;
    const pid = Number(String(p[1]).replace(/[^\d]/g, ''));
    if (!pid) continue;
    rows.push({
      name: p[0],
      pid,
      session: p[2],
      sessionId: p[3],
      memory: p[4],
      user: p[6],
      cpuTime: p[7],
      windowTitle: p[8] === 'N/A' ? '' : p[8]
    });
  }
  return rows.slice(0, 500);
}

const PROTECTED = new Set([
  'system','system idle process','smss.exe','csrss.exe','wininit.exe','services.exe','lsass.exe',
  'winlogon.exe','svchost.exe','dwm.exe','explorer.exe','fontdrvhost.exe','registry',
  'memory compression','secure system','conhost.exe'
]);
const APP_CANDIDATES = {
  chrome: ['chrome.exe', `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  edge: ['msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  vscode: ['Code.exe', `${process.env.LOCALAPPDATA || ''}\\Programs\\Microsoft VS Code\\Code.exe`, 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'],
  notepad: ['notepad.exe'],
  calculator: ['calc.exe'],
  'file explorer': ['explorer.exe']
};
const APP_ALIASES = {
  chrome:'chrome','google chrome':'chrome',edge:'edge','microsoft edge':'edge',
  vscode:'vscode','vs code':'vscode','visual studio code':'vscode',
  notepad:'notepad',calculator:'calculator','file explorer':'file explorer',explorer:'file explorer'
};
const APP_PROCESS = {
  chrome:['chrome.exe'], edge:['msedge.exe'], vscode:['Code.exe'], notepad:['notepad.exe'],
  calculator:['CalculatorApp.exe','ApplicationFrameHost.exe','calc.exe'], 'file explorer':['explorer.exe']
};

async function resolveExecutable(key) {
  const candidates = APP_CANDIDATES[key] || [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('\\') || candidate.includes(':')) {
      try { require('fs').accessSync(candidate); return candidate; } catch {}
    } else {
      const found = await execFileP('where.exe', [candidate], 3000);
      const first = found.split(/\r?\n/).map(x=>x.trim()).find(Boolean);
      if (first) return first;
    }
  }
  return null;
}
function runDetached(file, args=[]) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached:true, stdio:'ignore', windowsHide:true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function getState() {
  const processes = await getProcessInventory();
  const openApps = processes.filter(p =>
    p.windowTitle && p.session && p.session.toLowerCase() !== 'services' &&
    p.user && !/system|local service|network service/i.test(p.user)
  );
  const appNames = [...new Set((openApps.length ? openApps : processes)
    .map(p => p.name).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  return {
    type:'STATE', agentId:CONFIG.agentId, ip:localIP(), hostname:os.hostname(),
    os:`${os.platform()} ${os.release()}`,
    system:{platform:os.platform(),arch:os.arch(),cpus:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem()},
    applications: appNames,
    openApps, processes: processes.slice(0,500), processCount: processes.length
  };
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function hello() {
  const nonce=crypto.randomBytes(16).toString('hex'), hostname=os.hostname();
  return { type:'HELLO', agentId:CONFIG.agentId, nonce, hostname, ip:localIP(),
    os:`${os.platform()} ${os.release()}`, system:{arch:os.arch(),cpus:os.cpus().length,totalMemory:os.totalmem()},
    agentVersion:'1.3.0', proof:sign(CONFIG.token, nonce+'|'+CONFIG.agentId+'|'+hostname) };
}
function askOperatorHost() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox('Enter the Operator PC IPv4 address (for example 192.168.1.20). Leave blank to retry automatic discovery.', 'Computer Swarm Agent - Connect to Operator', '')`;
    execFile('powershell.exe', ['-NoProfile','-STA','-Command', ps], {windowsHide:false, timeout:120000}, (err, stdout) => {
      const host = String(stdout || '').trim();
      if (err || !host || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return resolve(null);
      CONFIG.operatorHost = host;
      try { fs.mkdirSync(path.dirname(CONFIG.settingsFile), {recursive:true}); fs.writeFileSync(CONFIG.settingsFile, JSON.stringify({operatorHost:host}, null, 2)); } catch {}
      log(`Saved Operator address ${host} in ProgramData; future starts will connect automatically.`);
      resolve(host);
    });
  });
}
function discovery() {
  return new Promise(resolve => {
    if (CONFIG.operatorHost) return resolve({host:CONFIG.operatorHost,port:CONFIG.operatorWsPort,source:'env'});
    const socket=dgram.createSocket('udp4'); let done=false;
    const finish=result=>{if(done)return;done=true;try{socket.close()}catch{}resolve(result)};
    socket.on('message',buf=>{try{const m=JSON.parse(buf.toString());if(m.type==='SWARM_DISCOVERY_RESPONSE'&&m.host)finish({host:m.host,port:Number(m.port)||CONFIG.operatorWsPort,source:'discovery'})}catch{}});
    socket.on('error',()=>finish(null));
    socket.bind(()=>{try{socket.setBroadcast(true);const b=Buffer.from(JSON.stringify({type:'SWARM_DISCOVERY',agentId:CONFIG.agentId}));socket.send(b,0,b.length,CONFIG.discoveryPort,'255.255.255.255')}catch{finish(null)}});
    setTimeout(()=>finish(null),CONFIG.discoveryTimeoutMs);
  });
}
async function connect() {
  if (stopped) return;
  const target=discoveredOperator||await discovery();
  if (!target) {
    log('Automatic discovery did not find Operator. A one-time address prompt will open.');
    const host = await askOperatorHost();
    if (host) return connect();
    log('Operator not found; retrying discovery. Check same LAN and Windows Firewall.');
    return scheduleReconnect();
  }
  discoveredOperator=target;
  const url=`ws://${target.host}:${target.port}`;
  log(`Connecting to Operator ${url} (${target.source})`);
  ws=new WebSocket(url);
  ws.on('open',()=>{log('TCP/WebSocket connection established');send(hello())});
  ws.on('message',async raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return}
    if(msg.type==='AUTH_OK'){log('Authenticated');await sendState()}
    else if(msg.type==='COMMAND') await handleCommand(msg);
  });
  ws.on('close',()=>{log('Operator connection closed; retrying');ws=null;discoveredOperator=null;scheduleReconnect()});
  ws.on('error',err=>log(`WebSocket error: ${err.message}`));
}
function scheduleReconnect(){if(reconnectTimer||stopped)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect()},CONFIG.reconnectMs)}
async function sendState(){if(!ws||ws.readyState!==WebSocket.OPEN)return;try{send(await getState())}catch(e){log(`State error: ${e.message}`)}}
function heartbeat(){send({type:'HEARTBEAT',agentId:CONFIG.agentId,ip:localIP(),timestamp:Date.now()})}

async function handleCommand(msg) {
  const allowed=new Set(['OPEN_URL','OPEN_APP','CLOSE_APP','CLOSE_PROCESS','CLOSE_PROCESS_NAME','SHUTDOWN','RESTART','RELEASE_AGENT']);
  let ok=false,error='',result=null;
  try {
    if(!allowed.has(msg.command)) throw new Error('Command not allowed');
    if(msg.command==='RELEASE_AGENT'){ operatorRelease(); return;
    } else if(msg.command==='OPEN_URL'){
      const u=String(msg.payload?.url||''); if(!/^https?:\/\/[^\s]+$/i.test(u))throw new Error('Invalid URL');
      if(process.platform==='win32') { const r=await execFileResult('cmd.exe',['/c','start','',''+u]); if(!r.ok)throw new Error(r.stderr||'Could not open URL'); }
      else { const r=await execFileResult('xdg-open',[u]); if(!r.ok)throw new Error(r.stderr||'Could not open URL'); }
      ok=true; result={url:u};
    } else if(msg.command==='OPEN_APP'){
      const key=APP_ALIASES[String(msg.payload?.app||'').toLowerCase()]; if(!key)throw new Error('App not in allowlist');
      if(process.platform!=='win32')throw new Error('OPEN_APP currently supports Windows');
      const exe=await resolveExecutable(key); if(!exe)throw new Error(`Could not find ${key} on this PC`);
      await runDetached(exe); ok=true; result={app:key,executable:exe};
    } else if(msg.command==='CLOSE_APP'){
      const key=APP_ALIASES[String(msg.payload?.app||'').toLowerCase()]; if(!key)throw new Error('App not in allowlist');
      if(process.platform!=='win32')throw new Error('CLOSE_APP currently supports Windows');
      const results=[]; for(const proc of APP_PROCESS[key]) {
        const r=await execFileResult('taskkill',['/IM',proc,'/T','/F']); results.push({process:proc,ok:r.ok});
      }
      if(!results.some(x=>x.ok)) throw new Error(`No running ${key} process was found`);
      ok=true; result={app:key,processes:results};
    } else if(msg.command==='CLOSE_PROCESS'){
      const pid=Number(msg.payload?.pid); const requested=String(msg.payload?.name||'').toLowerCase();
      if(!Number.isInteger(pid)||pid<=0||pid>999999)throw new Error('Invalid process ID');
      if(!requested)throw new Error('Process name required');
      if(PROTECTED.has(requested))throw new Error('Protected system process');
      if(process.platform!=='win32')throw new Error('CLOSE_PROCESS currently supports Windows');
      const inventory=await getProcessInventory(); const p=inventory.find(x=>x.pid===pid);
      if(!p)throw new Error('Process is no longer running');
      if(p.name.toLowerCase()!==requested)throw new Error('Process changed; refresh and try again');
      if(PROTECTED.has(p.name.toLowerCase()))throw new Error('Protected system process');
      const r=await execFileResult('taskkill',['/PID',String(pid),'/T','/F']);
      if(!r.ok)throw new Error(r.stderr||'Windows refused to close the process');
      ok=true; result={pid,name:p.name};
    } else if(msg.command==='CLOSE_PROCESS_NAME'){
      const requested=String(msg.payload?.name||'').trim().toLowerCase();
      if(!requested)throw new Error('Process name required');
      if(PROTECTED.has(requested))throw new Error('Protected system process');
      if(process.platform!=='win32')throw new Error('CLOSE_PROCESS_NAME currently supports Windows');
      const inventory=await getProcessInventory();
      const matches=inventory.filter(p=>p.name.toLowerCase()===requested&&!PROTECTED.has(p.name.toLowerCase()));
      if(!matches.length)throw new Error(`No running process named ${requested} was found`);
      const closed=[];
      for(const p of matches){
        const r=await execFileResult('taskkill',['/PID',String(p.pid),'/T','/F']);
        closed.push({pid:p.pid,name:p.name,ok:r.ok});
      }
      if(!closed.some(x=>x.ok))throw new Error(`Could not close ${requested}`);
      ok=true;result={name:requested,closed};
    } else if(msg.command==='SHUTDOWN'){
      if(process.platform!=='win32')throw new Error('Windows command only');
      spawn('shutdown',['/s','/t','5'],{detached:true,stdio:'ignore',windowsHide:true}).unref();ok=true;
    } else if(msg.command==='RESTART'){
      if(process.platform!=='win32')throw new Error('Windows command only');
      spawn('shutdown',['/r','/t','5'],{detached:true,stdio:'ignore',windowsHide:true}).unref();ok=true;
    }
  } catch(e){error=e.message}
  send({type:'RESULT',agentId:CONFIG.agentId,requestId:msg.requestId,command:msg.command,ok,error,result});
}

const httpServer=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({agentId:CONFIG.agentId,online:!!ws&&ws.readyState===WebSocket.OPEN,ip:localIP()}))});
httpServer.listen(CONFIG.agentPort,'0.0.0.0',()=>log(`Agent status server on 0.0.0.0:${CONFIG.agentPort}`));
setInterval(heartbeat,CONFIG.heartbeatMs);
setInterval(sendState,CONFIG.stateMs);
process.on('SIGINT',()=>log('Local close request ignored; operator authorization is required.'));
process.on('SIGTERM',()=>log('Local termination request received; watchdog will restore the Agent if needed.'));
if(isReleased()) {
  log('Agent is RELEASED. Run Enable-Agent.ps1 as Administrator to reconnect it.');
} else {
  log(`Starting ${CONFIG.agentId} on ${os.hostname()} (${localIP()})`);
  connect();
}
