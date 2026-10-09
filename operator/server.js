'use strict';
require('dotenv').config();
const express=require('express');
const http=require('http');
const dgram=require('dgram');
const os=require('os');
const crypto=require('crypto');
const WebSocket=require('ws');
const path=require('path');
const {spawn}=require('child_process');
const {sign,safeEqualHex}=require('./shared/protocol');

const PORT=Number(process.env.PORT||3000);
const WS_PORT=Number(process.env.WS_PORT||3001);
const DISCOVERY_PORT=Number(process.env.DISCOVERY_PORT||41234);
const TIMEOUT=Number(process.env.HEARTBEAT_TIMEOUT_MS||15000);
const TOKEN=process.env.AUTH_TOKEN || 'DMPS_SWARM_2026_SECRET_83921';

const app=express(); app.use(express.json({limit:'1mb'})); app.use(express.static(path.join(__dirname,'public')));
const dashboardServer=http.createServer(app);
const agents=new Map(), logs=[];
function log(msg){
  const line=`[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.push(line); if(logs.length>500)logs.shift();
  console.log(line); broadcast({type:'LOG',line}); broadcast(snapshot());
}
function localIPs(){return Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address)}
function bestLanIP(){return localIPs()[0]||null}
function publicState(){
  const out={};
  for(const [id,a] of agents) out[id]={
    id,online:a.online,hostname:a.hostname,ip:a.ip,os:a.os,system:a.system,agentVersion:a.agentVersion,
    locked:a.locked!==false,
    lastHeartbeat:a.lastHeartbeat,connectedAt:a.connectedAt,applications:a.applications||[],
    openApps:a.openApps||[],processes:a.processes||[],processCount:a.processCount||0
  };
  return out;
}
function analysis(){
  const online=[...agents.values()].filter(a=>a.online);
  const counts=new Map();
  for(const a of online) for(const n of a.applications||[]) counts.set(n,(counts.get(n)||0)+1);
  const common=[...counts].filter(([,c])=>online.length>0&&c===online.length).map(([name])=>({name,count:online.length}));
  const shared=[...counts].filter(([,c])=>c>1&&c<online.length).map(([name,count])=>({name,count}));
  const unique=[...counts].filter(([,c])=>c===1).map(([name])=>({name,pc:online.find(a=>(a.applications||[]).includes(name))?.id}));
  const byPc={};
  for(const a of online) byPc[a.id]=a.applications||[];
  return {onlineCount:online.length,totalKnown:agents.size,common,shared,unique,byPc};
}
function snapshot(){return {type:'STATE',serverTime:Date.now(),agents:publicState(),analysis:analysis(),logs:logs.slice(-120)}}
const dashboardWss=new WebSocket.Server({server:dashboardServer,path:'/ws'});
dashboardWss.on('connection',ws=>{ws.send(JSON.stringify(snapshot()))});
function broadcast(obj){
  const s=JSON.stringify(obj);
  dashboardWss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(s)});
}

const agentServer=http.createServer();
const agentWss=new WebSocket.Server({server:agentServer});
agentWss.on('connection',ws=>{
  ws.send(JSON.stringify(snapshot()));
  ws.on('message',raw=>{try{handleAgent(ws,JSON.parse(raw.toString()))}catch(e){log(`Malformed agent message: ${e.message}`)}});
  ws.on('close',()=>{
    if(ws.agentId){
      const a=agents.get(ws.agentId);
      if(a&&a.ws===ws){a.online=false;a.lastHeartbeat=Date.now();log(`${a.id} disconnected`)}
    }
  });
});
agentServer.listen(WS_PORT,'0.0.0.0',()=>log(`Agent WebSocket listening on 0.0.0.0:${WS_PORT} (LAN: ${bestLanIP()||'not found'})`));

function handleAgent(ws,msg){
  let a=agents.get(msg.agentId);
  if(msg.type==='HELLO'){
    if(!msg.agentId||!msg.nonce||!msg.proof||!msg.hostname)return ws.close(1008,'Invalid hello');
    const expected=sign(TOKEN,msg.nonce+'|'+msg.agentId+'|'+msg.hostname);
    if(!safeEqualHex(expected,msg.proof))return ws.close(1008,'Authentication failed');
    a=a||{id:msg.agentId};
    Object.assign(a,{ws,online:true,hostname:msg.hostname,ip:msg.ip,os:msg.os,system:msg.system||a.system,
      agentVersion:msg.agentVersion,locked:true,lastHeartbeat:Date.now(),connectedAt:a.connectedAt||Date.now(),
      applications:a.applications||[],openApps:a.openApps||[],processes:a.processes||[]});
    agents.set(a.id,a);ws.agentId=a.id;ws.authenticated=true;
    ws.send(JSON.stringify({type:'AUTH_OK',serverTime:Date.now()}));
    log(`${a.id} connected (${a.hostname}, ${a.ip})`);
    return;
  }
  if(!ws.authenticated||!a)return ws.close(1008,'Unauthenticated');
  if(msg.type==='HEARTBEAT'){
    a.lastHeartbeat=Date.now();a.ip=msg.ip||a.ip;broadcast(snapshot());
  } else if(msg.type==='STATE'){
    a.lastHeartbeat=Date.now();
    a.applications=Array.isArray(msg.applications)?msg.applications:[];
    a.openApps=Array.isArray(msg.openApps)?msg.openApps:[];
    a.processes=Array.isArray(msg.processes)?msg.processes:[];
    a.processCount=msg.processCount||a.processes.length;
    a.os=msg.os||a.os;a.system=msg.system||a.system;a.ip=msg.ip||a.ip;
    broadcast(snapshot());
  } else if(msg.type==='RESULT'){
    a.lastHeartbeat=Date.now();
    log(`${a.id} ${msg.command}: ${msg.ok?'success':'failed'}${msg.error?' — '+msg.error:''}`);
    broadcast({type:'RESULT',result:msg}); broadcast(snapshot());
  }
}

setInterval(()=>{
  let changed=false;
  for(const a of agents.values()) if(a.online&&Date.now()-a.lastHeartbeat>TIMEOUT){a.online=false;log(`${a.id} heartbeat timeout; marked offline`);changed=true}
  if(changed)broadcast(snapshot());
},2000);

const udp=dgram.createSocket('udp4');
udp.on('error',e=>log(`UDP discovery error: ${e.message}`));
udp.on('message',(buf,rinfo)=>{
  let m;try{m=JSON.parse(buf.toString())}catch{return}
  if(m.type!=='SWARM_DISCOVERY')return;
  const host=bestLanIP()||rinfo.address;
  const payload={type:'SWARM_DISCOVERY_RESPONSE',host,port:WS_PORT,nonce:crypto.randomBytes(16).toString('hex')};
  udp.send(Buffer.from(JSON.stringify(payload)),rinfo.port,rinfo.address);
});
udp.bind(DISCOVERY_PORT,'0.0.0.0',()=>{udp.setBroadcast(true);log(`Discovery responder listening on 0.0.0.0:${DISCOVERY_PORT}`)});
setInterval(()=>{
  const msg=Buffer.from(JSON.stringify({type:'SWARM_DISCOVERY',operator:true,port:WS_PORT}));
  udp.send(msg,0,msg.length,DISCOVERY_PORT,'255.255.255.255');
},Number(process.env.DISCOVERY_INTERVAL_MS||3000));

app.get('/api/config',(req,res)=>res.json({wsPort:WS_PORT,discoveryPort:DISCOVERY_PORT,operatorHost:bestLanIP()}));
app.get('/api/state',(req,res)=>res.json(snapshot()));
app.post('/api/command',(req,res)=>{
  const {targets,command,payload}=req.body||{};
  const allowed=new Set(['OPEN_APP','CLOSE_APP','CLOSE_PROCESS','CLOSE_PROCESS_NAME','OPEN_URL','RESTART','SHUTDOWN','RELEASE_AGENT']);
  if(!allowed.has(command))return res.status(400).json({results:[],error:'Command not allowed'});
  let ids=targets==='ALL'?[...agents.keys()]:Array.isArray(targets)?targets:[targets];
  ids=[...new Set(ids)].filter(Boolean);
  const results=[];
  for(const id of ids){
    const a=agents.get(id);
    if(!a||!a.online||!a.ws||a.ws.readyState!==WebSocket.OPEN){results.push({agentId:id,ok:false,error:'PC offline'});continue}
    if(command==='CLOSE_PROCESS'){
      const pid=Number(payload?.pid);
      if(!Number.isInteger(pid)||pid<=0){results.push({agentId:id,ok:false,error:'Invalid process ID'});continue}
    }
    const requestId=crypto.randomUUID();
    a.ws.send(JSON.stringify({type:'COMMAND',requestId,command,payload}));
    log(`Command ${command} sent to ${id}${payload?.app?' ['+payload.app+']':''}${payload?.pid?' [PID '+payload.pid+']':''}`);
    results.push({agentId:id,accepted:true,requestId});
  }
  res.json({results});
});
app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
dashboardServer.listen(PORT,'0.0.0.0',()=>{
  const url=`http://localhost:${PORT}`;
  log(`Dashboard running on ${url} (LAN: http://${bestLanIP()||'OPERATOR-IP'}:${PORT})`);
  if(process.platform==='win32' && process.env.SWARM_OPEN_BROWSER!=='0') {
    try { spawn('cmd.exe',['/c','start','',url],{windowsHide:true,detached:true,stdio:'ignore'}).unref(); } catch {}
  }
});
