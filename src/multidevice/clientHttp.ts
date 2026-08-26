import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { ClientRuntime } from "./clientRuntime.js";

export interface RunningClientHttp {
  url: string;
  close(): Promise<void>;
}

function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loopbackHostHeader(value: string | undefined): boolean {
  const host = String(value ?? "").trim().toLowerCase();
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?").slice(0, 4000);
}

function jsonError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

function page(adminToken: string): string {
  const tokenLiteral = JSON.stringify(adminToken);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CodexPro Control Center</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0d12; color: #edf1f7; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .shell { max-width: 1240px; margin: 0 auto; padding: 28px 24px 60px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
    .subtitle { color: #94a0b2; margin-top: 8px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .72fr); gap: 18px; }
    .card { background: #121621; border: 1px solid #252b39; border-radius: 16px; padding: 18px; box-shadow: 0 8px 30px rgba(0,0,0,.18); }
    .card + .card { margin-top: 18px; }
    .card h2 { margin: 0 0 14px; font-size: 17px; }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .between { justify-content: space-between; }
    .status { display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 999px; border: 1px solid #343c4c; color: #aab5c5; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: #657184; }
    .status.online .dot { background: #44d17a; box-shadow: 0 0 0 4px rgba(68,209,122,.1); }
    .status.offline .dot { background: #f08a58; }
    .btn { border: 1px solid #344055; background: #1a2130; color: #edf1f7; border-radius: 10px; padding: 9px 13px; }
    .btn:hover { background: #222c3f; }
    .btn.primary { background: #e8edf8; color: #11141a; border-color: #e8edf8; font-weight: 650; }
    .btn.danger { border-color: #5a3038; color: #ffb1bc; background: #241519; }
    .btn.small { padding: 6px 9px; font-size: 13px; }
    label { display: block; color: #9ca8b8; font-size: 12px; margin-bottom: 6px; }
    input, select, textarea { width: 100%; border: 1px solid #30394a; background: #0d1119; color: #f0f3f9; border-radius: 9px; padding: 9px 10px; outline: none; }
    input:focus, select:focus, textarea:focus { border-color: #65789d; box-shadow: 0 0 0 3px rgba(101,120,157,.12); }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
    .field.full { grid-column: 1 / -1; }
    .muted { color: #8793a5; font-size: 13px; line-height: 1.55; }
    code { color: #cfd8e8; background: #0d1119; border: 1px solid #282f3d; padding: 2px 5px; border-radius: 5px; }
    .device { border: 1px solid #2a3242; border-radius: 13px; padding: 14px; margin-top: 12px; background: #0f131c; }
    .device-title { font-weight: 650; }
    .device-meta { color: #8592a6; font-size: 12px; }
    .roots { margin-top: 12px; border-top: 1px solid #272e3c; padding-top: 12px; }
    .root-row { display: grid; grid-template-columns: .65fr .8fr 1.7fr .85fr auto; gap: 8px; align-items: end; margin-top: 8px; }
    .root-row label { margin-bottom: 4px; }
    .log { white-space: pre-wrap; overflow: auto; max-height: 420px; min-height: 160px; background: #090c11; border: 1px solid #242a37; border-radius: 10px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #b7c1d0; }
    .toast { position: fixed; right: 24px; bottom: 24px; max-width: 440px; background: #1b2432; border: 1px solid #3a485d; color: #f4f6fa; border-radius: 12px; padding: 12px 14px; box-shadow: 0 16px 50px rgba(0,0,0,.35); display: none; z-index: 10; }
    .toast.error { border-color: #76424b; background: #2a171c; color: #ffc0ca; }
    .token { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .section-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .test-result { margin-top: 10px; color: #9bc1a9; font-size: 12px; white-space: pre-wrap; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .fields { grid-template-columns: 1fr; } .root-row { grid-template-columns: 1fr 1fr; } .root-row .path { grid-column: 1/-1; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div>
        <h1>CodexPro Control Center</h1>
        <div class="subtitle">管理 Windows Hub、设备、SSH Agent、Root 权限和 ChatGPT MCP 连接。管理接口仅监听本机回环地址。</div>
      </div>
      <div id="hubStatus" class="status"><span class="dot"></span><span>加载中</span></div>
    </div>

    <div class="grid">
      <main>
        <section class="card">
          <div class="row between">
            <h2>Hub</h2>
            <div class="section-actions">
              <button class="btn primary" id="startHub">启动</button>
              <button class="btn" id="restartHub">重启</button>
              <button class="btn" id="stopHub">停止</button>
            </div>
          </div>
          <div class="fields">
            <div><label>监听地址</label><input id="hubHost" value="127.0.0.1"></div>
            <div><label>端口</label><input id="hubPort" type="number" min="1" max="65535" value="8790"></div>
            <div><label>最大 MCP 会话</label><input id="maxSessions" type="number" min="1" max="512" value="64"></div>
            <div><label>会话空闲超时（毫秒）</label><input id="sessionTtl" type="number" min="60000" value="1800000"></div>
            <div class="field full"><label>本地 MCP 地址</label><div class="token"><input id="localMcp" readonly><button class="btn" data-copy="localMcp">复制</button></div></div>
            <div class="field full"><label>Hub Token</label><div class="token"><input id="hubToken" type="password" readonly><button class="btn" id="toggleToken">显示</button><button class="btn" data-copy="hubToken">复制</button></div></div>
            <div class="field full"><label>公网 HTTPS 基础地址（可选，用于生成 ChatGPT URL）</label><input id="publicBase" placeholder="https://codexpro.example.com"></div>
            <div class="field full"><label>ChatGPT MCP URL</label><div class="token"><input id="chatgptUrl" readonly><button class="btn" data-copy="chatgptUrl">复制</button></div></div>
          </div>
          <p class="muted">推荐让 Hub 继续只监听 <code>127.0.0.1</code>，再通过 Cloudflare / Tailscale / ngrok 暴露 HTTPS。公网客户端支持 Bearer Header 时，不要把 Token 放进 URL。</p>
        </section>

        <section class="card">
          <div class="row between">
            <h2>设备与 Root</h2>
            <div class="section-actions">
              <button class="btn" id="addLocal">+ Windows 本机</button>
              <button class="btn" id="addSsh">+ SSH 服务器</button>
              <button class="btn primary" id="saveConfig">保存配置</button>
            </div>
          </div>
          <div id="devices"></div>
          <div id="emptyDevices" class="muted">还没有设备。先添加 Windows 本机或一台 SSH 服务器。</div>
        </section>
      </main>

      <aside>
        <section class="card">
          <h2>配置</h2>
          <div class="muted">Hub 配置文件</div>
          <div style="margin-top:8px; word-break:break-all"><code id="configPath">-</code></div>
          <p class="muted">本机 Agent policy 会随此客户端一起编辑；远程 SSH Agent 的 policy 仍保存在目标服务器，由服务器本地权限保护。</p>
        </section>
        <section class="card">
          <div class="row between"><h2>运行日志</h2><button class="btn small" id="refresh">刷新</button></div>
          <div class="log" id="logs">暂无日志</div>
        </section>
      </aside>
    </div>
  </div>
  <div class="toast" id="toast"></div>

<script>
const ADMIN_TOKEN = ${tokenLiteral};
let model = null;
let saving = false;

function $(id) { return document.getElementById(id); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(message, error=false) { const el=$('toast'); el.textContent=message; el.className='toast'+(error?' error':''); el.style.display='block'; clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>el.style.display='none',4200); }
async function api(path, options={}) {
  const headers = { 'x-codexpro-admin-token': ADMIN_TOKEN, ...(options.headers||{}) };
  if (options.body && !headers['content-type']) headers['content-type']='application/json';
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP '+res.status));
  return data;
}
function defaultConfig() { return { schemaVersion:1, host:'127.0.0.1', port:8790, maxSessions:64, sessionTtlMs:1800000, devices:[] }; }
function uniqueId(prefix) { const used=new Set((model.config.devices||[]).map(d=>d.id)); let n=1; let id=prefix; while(used.has(id)) id=prefix+'-'+(++n); return id; }
function syncTopFieldsToModel() {
  model.config.host=$('hubHost').value.trim()||'127.0.0.1';
  model.config.port=Number($('hubPort').value||8790);
  model.config.maxSessions=Number($('maxSessions').value||64);
  model.config.sessionTtlMs=Number($('sessionTtl').value||1800000);
}
function updateChatgptUrl() {
  const base=$('publicBase').value.trim().replace(/\/+$/,'');
  $('chatgptUrl').value=base ? base+'/mcp?codexpro_token='+encodeURIComponent(model?.hubToken||'') : '';
}
function renderHub() {
  $('configPath').textContent=model.configPath;
  $('hubHost').value=model.config.host ?? '127.0.0.1';
  $('hubPort').value=model.config.port ?? 8790;
  $('maxSessions').value=model.config.maxSessions ?? 64;
  $('sessionTtl').value=model.config.sessionTtlMs ?? 1800000;
  $('localMcp').value=model.hub.localMcpUrl || '';
  $('hubToken').value=model.hubToken || '';
  const status=$('hubStatus');
  status.className='status '+(model.hub.reachable?'online':'offline');
  status.querySelector('span:last-child').textContent=model.hub.reachable ? (model.hub.owned?'运行中 · 本客户端管理':'运行中 · 外部进程') : '未运行';
  updateChatgptUrl();
}
function localPolicyFor(device) {
  if (!model.localPolicies[device.id]) {
    model.localPolicies[device.id]={ schemaVersion:1, deviceId:device.id, label:device.label||device.id, roots:[] };
  }
  return model.localPolicies[device.id];
}
function renderDevices() {
  const root=$('devices'); root.innerHTML='';
  const devices=model.config.devices||[];
  $('emptyDevices').style.display=devices.length?'none':'block';
  devices.forEach((device,index)=>{
    const local=device.transport==='local';
    const policy=local ? localPolicyFor(device) : null;
    const card=document.createElement('div'); card.className='device';
    card.innerHTML=`
      <div class="row between">
        <div><div class="device-title">${esc(device.label||device.id)}</div><div class="device-meta">${esc(device.id)} · ${esc(device.transport)}</div></div>
        <div class="section-actions"><button class="btn small test">测试连接</button><button class="btn small danger remove">删除</button></div>
      </div>
      <div class="fields" style="margin-top:12px">
        <div><label>Device ID</label><input class="device-id" value="${esc(device.id)}"></div>
        <div><label>显示名称</label><input class="device-label" value="${esc(device.label||device.id)}"></div>
        <div><label>传输</label><select class="transport"><option value="local" ${local?'selected':''}>local</option><option value="ssh" ${!local?'selected':''}>ssh</option></select></div>
        <div><label>${local?'本机 Agent Policy':'远程 Agent Policy'}</label><input class="policy" value="${esc(device.policyPath||'')}"></div>
        ${local?'':`<div class="field full"><label>SSH Host Alias</label><input class="ssh-alias" value="${esc(device.sshHostAlias||'')}"></div>`}
      </div>
      <div class="test-result"></div>
      ${local?'<div class="roots"><div class="row between"><strong style="font-size:13px">批准 Root</strong><button class="btn small add-root">+ Root</button></div><div class="root-list"></div></div>':''}
    `;
    const updateDevice=()=>{
      const oldId=device.id;
      const nextId=card.querySelector('.device-id').value.trim();
      device.id=nextId;
      device.label=card.querySelector('.device-label').value.trim();
      device.policyPath=card.querySelector('.policy').value.trim();
      const nextTransport=card.querySelector('.transport').value;
      if(nextTransport!==device.transport){
        device.transport=nextTransport;
        if(nextTransport==='ssh') device.sshHostAlias=device.id;
        else delete device.sshHostAlias;
        renderDevices(); return;
      }
      if(device.transport==='ssh') device.sshHostAlias=card.querySelector('.ssh-alias')?.value.trim()||device.id;
      if(local && oldId!==nextId && model.localPolicies[oldId]){
        model.localPolicies[nextId]=model.localPolicies[oldId]; delete model.localPolicies[oldId]; model.localPolicies[nextId].deviceId=nextId;
      }
      if(local && model.localPolicies[nextId]) model.localPolicies[nextId].label=device.label||nextId;
    };
    card.querySelectorAll('input,select').forEach(el=>el.addEventListener('change',updateDevice));
    card.querySelector('.remove').onclick=()=>{ model.config.devices.splice(index,1); if(local) delete model.localPolicies[device.id]; renderDevices(); };
    card.querySelector('.test').onclick=async()=>{
      try { await save(false); const out=await api('/api/device/test',{method:'POST',body:JSON.stringify({device_id:device.id})}); card.querySelector('.test-result').textContent='✓ '+(out.device.platform||'connected')+' · '+((out.device.roots||[]).length)+' roots'; toast('设备 '+device.id+' 连接正常'); }
      catch(e){ card.querySelector('.test-result').textContent='✗ '+e.message; toast(e.message,true); }
    };
    if(local){
      const list=card.querySelector('.root-list');
      const drawRoots=()=>{
        list.innerHTML=''; const p=localPolicyFor(device); p.roots=p.roots||[];
        p.roots.forEach((r,ri)=>{
          const line=document.createElement('div'); line.className='root-row';
          line.innerHTML=`<div><label>ID</label><input class="rid" value="${esc(r.id||'root')}"></div><div><label>名称</label><input class="rlabel" value="${esc(r.label||r.id||'Root')}"></div><div class="path"><label>本机绝对路径</label><input class="rpath" value="${esc(r.path||'')}"></div><div><label>权限</label><select class="rmode"><option value="workspace-parent" ${r.mode==='workspace-parent'?'selected':''}>workspace-parent</option><option value="read-only" ${r.mode==='read-only'?'selected':''}>read-only</option></select></div><button class="btn small danger rremove">删</button>`;
          const update=()=>{ r.id=line.querySelector('.rid').value.trim(); r.label=line.querySelector('.rlabel').value.trim(); r.path=line.querySelector('.rpath').value.trim(); r.mode=line.querySelector('.rmode').value; };
          line.querySelectorAll('input,select').forEach(el=>el.addEventListener('change',update));
          line.querySelector('.rremove').onclick=()=>{p.roots.splice(ri,1);drawRoots();}; list.appendChild(line);
        });
      };
      card.querySelector('.add-root').onclick=()=>{ const p=localPolicyFor(device); p.roots=p.roots||[]; p.roots.push({id:'projects'+(p.roots.length?'-'+(p.roots.length+1):''),label:'Projects',path:'',mode:'workspace-parent'}); drawRoots(); };
      drawRoots();
    }
    root.appendChild(card);
  });
}
function renderLogs() { $('logs').textContent=(model.logs||[]).slice(-250).join('\n')||'暂无日志'; $('logs').scrollTop=$('logs').scrollHeight; }
function renderAll() { renderHub(); renderDevices(); renderLogs(); }
async function load() { const out=await api('/api/state'); model=out.state; if(!model.config) model.config=defaultConfig(); model.config.devices=model.config.devices||[]; model.localPolicies=model.localPolicies||{}; renderAll(); }
async function save(showToast=true) { if(saving)return; saving=true; try{syncTopFieldsToModel(); const out=await api('/api/state',{method:'PUT',body:JSON.stringify({config:model.config,localPolicies:model.localPolicies})}); model=out.state; renderAll(); if(showToast)toast('配置已保存');} finally{saving=false;} }
$('addLocal').onclick=()=>{ const id=uniqueId('windows-main'); model.config.devices.push({id,label:'Windows 总控机',transport:'local',policyPath:'./'+id+'-agent.json'}); model.localPolicies[id]={schemaVersion:1,deviceId:id,label:'Windows 总控机',roots:[{id:'projects',label:'Projects',path:'',mode:'workspace-parent'}]}; renderDevices(); };
$('addSsh').onclick=()=>{ const id=uniqueId('lab-server'); model.config.devices.push({id,label:'Linux 服务器',transport:'ssh',sshHostAlias:id,policyPath:'~/.config/codexpro/agent.json'}); renderDevices(); };
$('saveConfig').onclick=()=>save().catch(e=>toast(e.message,true));
$('startHub').onclick=async()=>{try{await save(false); const out=await api('/api/hub/start',{method:'POST'}); model.hub=out.hub; renderHub(); await refreshLogs(); toast('Hub 已启动');}catch(e){toast(e.message,true);}};
$('restartHub').onclick=async()=>{try{await save(false); const out=await api('/api/hub/restart',{method:'POST'}); model.hub=out.hub; renderHub(); await refreshLogs(); toast('Hub 已重启');}catch(e){toast(e.message,true);}};
$('stopHub').onclick=async()=>{try{const out=await api('/api/hub/stop',{method:'POST'}); model.hub=out.hub; renderHub(); await refreshLogs(); toast('Hub 已停止');}catch(e){toast(e.message,true);}};
$('refresh').onclick=()=>load().catch(e=>toast(e.message,true));
$('publicBase').addEventListener('input',updateChatgptUrl);
$('toggleToken').onclick=()=>{ const el=$('hubToken'); el.type=el.type==='password'?'text':'password'; $('toggleToken').textContent=el.type==='password'?'显示':'隐藏'; };
document.addEventListener('click',async e=>{ const id=e.target?.dataset?.copy; if(!id)return; try{await navigator.clipboard.writeText($(id).value); toast('已复制');}catch{toast('复制失败，请手动复制',true);} });
async function refreshLogs(){const out=await api('/api/logs');model.logs=out.logs;renderLogs();}
setInterval(async()=>{try{const out=await api('/api/status');model.hub=out.hub;renderHub();}catch{}},3000);
load().catch(e=>toast(e.message,true));
</script>
</body>
</html>`;
}

export async function startClientHttp(runtime: ClientRuntime, port = 8791): Promise<RunningClientHttp> {
  const adminToken = process.env.CODEXPRO_CLIENT_ADMIN_TOKEN?.trim() || randomBytes(32).toString("hex");
  if (Buffer.byteLength(adminToken, "utf8") < 24) throw new Error("CODEXPRO_CLIENT_ADMIN_TOKEN must contain at least 24 UTF-8 bytes when set.");
  const app = express();

  app.use((req, res, next) => {
    if (!loopbackHostHeader(req.headers.host)) {
      res.status(403).send("Forbidden host");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  app.get("/", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.type("html").send(page(adminToken));
  });

  app.use("/api", (req, res, next) => {
    if (!tokenMatches(adminToken, req.headers["x-codexpro-admin-token"])) {
      jsonError(res, 403, "Invalid local admin token.");
      return;
    }
    next();
  });

  app.get("/api/state", async (_req, res) => {
    try { res.json({ ok: true, state: await runtime.state() }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });
  app.put("/api/state", express.json({ limit: "2mb" }), async (req, res) => {
    try { res.json({ ok: true, state: await runtime.saveState(req.body ?? {}) }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });
  app.get("/api/status", async (_req, res) => {
    try { res.json({ ok: true, hub: await runtime.hubStatus() }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });
  app.get("/api/logs", (_req, res) => res.json({ ok: true, logs: runtime.logLines() }));
  app.post("/api/device/test", express.json({ limit: "16kb" }), async (req, res) => {
    try { res.json({ ok: true, device: await runtime.testDevice(req.body?.device_id) }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });
  app.post("/api/hub/start", async (_req, res) => {
    try { res.json({ ok: true, hub: await runtime.startHub() }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });
  app.post("/api/hub/stop", async (_req, res) => {
    try { res.json({ ok: true, hub: await runtime.stopHub() }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });
  app.post("/api/hub/restart", async (_req, res) => {
    try { res.json({ ok: true, hub: await runtime.restartHub() }); }
    catch (error) { jsonError(res, 400, publicError(error)); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = error && typeof error === "object" && "type" in error ? String((error as any).type ?? "") : "";
    if (type === "entity.parse.failed" || type === "entity.too.large") {
      jsonError(res, type === "entity.too.large" ? 413 : 400, type === "entity.too.large" ? "Request body is too large." : "Request body must be valid JSON.");
      return;
    }
    jsonError(res, 500, publicError(error));
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const created = app.listen(port, "127.0.0.1", () => resolve(created));
    created.once("error", reject);
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
