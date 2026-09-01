import http from 'node:http';
import type { Store } from '../sql/store.ts';

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Graph Explorer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;overflow:hidden;height:100vh}
#toolbar{position:fixed;top:0;left:0;right:0;height:48px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 16px;gap:12px;z-index:10}
#toolbar label{font-size:13px;color:#8b949e}
#toolbar select,#toolbar input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 8px;font-size:13px}
#toolbar input{width:200px}
#legend{position:fixed;top:56px;left:8px;background:#161b22ee;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:12px;z-index:10;max-height:calc(100vh - 80px);overflow-y:auto}
#legend h3{font-size:11px;color:#8b949e;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px}
.leg-item{display:flex;align-items:center;gap:6px;margin:3px 0}
.leg-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
#tooltip{position:fixed;background:#1c2128;border:1px solid #30363d;border-radius:6px;padding:8px 12px;font-size:12px;pointer-events:none;display:none;z-index:20;max-width:320px;box-shadow:0 4px 12px #0004}
#tooltip .tname{font-weight:600;color:#f0f6fc;margin-bottom:2px}
#tooltip .tdetail{color:#8b949e;font-size:11px}
#stats{position:fixed;bottom:8px;right:8px;background:#161b22ee;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-size:11px;color:#8b949e;z-index:10}
canvas{display:block}
</style>
</head>
<body>
<div id="toolbar">
  <label>Project:</label>
  <select id="projectSel"><option>Loading...</option></select>
  <label>Search:</label>
  <input id="searchBox" type="text" placeholder="Filter by name...">
</div>
<div id="legend"></div>
<div id="tooltip"><div class="tname"></div><div class="tdetail"></div></div>
<div id="stats"></div>
<canvas id="c"></canvas>
<script>
(function(){
const LABEL_COLORS={
  Function:'#58a6ff',Class:'#f0883e',Method:'#a371f7',Interface:'#3fb950',
  Enum:'#f778ba',File:'#8b949e',Route:'#da3633',Type:'#d2a8ff',
  Module:'#79c0ff',Package:'#ffa657',Resource:'#56d364',Project:'#e3b341',
  Folder:'#6e7681'
};
const canvas=document.getElementById('c');
const ctx=canvas.getContext('2d');
const tooltip=document.getElementById('tooltip');
const statsEl=document.getElementById('stats');
const projectSel=document.getElementById('projectSel');
const searchBox=document.getElementById('searchBox');
let nodes=[],edges=[],nodeMap={};
let simNodes=[],searchHits=new Set();
let camX=0,camY=0,camZoom=1;
let dragNode=null,isPanning=false,panStart={x:0,y:0};
let hoveredNode=null;
let W,H;
function resize(){W=window.innerWidth;H=window.innerHeight;canvas.width=W;canvas.height=H}
window.addEventListener('resize',resize);resize();

const legendEl=document.getElementById('legend');
function buildLegend(labels){
  let h='<h3>Labels</h3>';
  labels.forEach(l=>{
    h+='<div class="leg-item"><div class="leg-dot" style="background:'+LABEL_COLORS[l]+'"></div>'+l+'</div>';
  });
  legendEl.innerHTML=h;
}

function initSimulation(rawNodes,rawEdges){
  nodes=rawNodes;edges=rawEdges;nodeMap={};
  const idSet=new Set();
  nodes.forEach(n=>idSet.add(n.id));
  edges=edges.filter(e=>idSet.has(e.src)&&idSet.has(e.dst));
  if(nodes.length===0)return;
  simNodes=nodes.map((n,i)=>{
    const angle=(i/nodes.length)*Math.PI*2;
    const r=Math.min(W,H)*0.3*Math.sqrt(nodes.length/100);
    return{id:n.id,name:n.name,label:n.label,file:n.file||'',qualified:n.qualified||'',
      x:Math.cos(angle)*r+(Math.random()-0.5)*60,
      y:Math.sin(angle)*r+(Math.random()-0.5)*60,
      vx:0,vy:0,r:n.label==='File'?7:n.label==='Class'?6:4.5};
  });
  simNodes.forEach(n=>nodeMap[n.id]=n);
  const labels=[...new Set(nodes.map(n=>n.label))].sort();
  buildLegend(labels);
  camX=0;camY=0;camZoom=1;
  statsEl.textContent=nodes.length+' nodes, '+edges.length+' edges';
}

function simulate(){
  if(simNodes.length===0)return;
  const N=simNodes.length;
  const k=Math.sqrt((W*H)/(N+1))*0.08;
  for(let i=0;i<N;i++){simNodes[i].vx*=0.85;simNodes[i].vy*=0.85}
  for(let i=0;i<N;i++){
    for(let j=i+1;j<N;j++){
      let dx=simNodes[j].x-simNodes[i].x;
      let dy=simNodes[j].y-simNodes[i].y;
      let d=Math.sqrt(dx*dx+dy*dy)||1;
      let f=k*k/d*0.5;
      simNodes[i].vx-=dx/d*f;simNodes[i].vy-=dy/d*f;
      simNodes[j].vx+=dx/d*f;simNodes[j].vy+=dy/d*f;
    }
  }
  const adjMap={};
  edges.forEach(e=>{
    if(!adjMap[e.src])adjMap[e.src]=[];
    if(!adjMap[e.dst])adjMap[e.dst]=[];
    adjMap[e.src].push(e.dst);adjMap[e.dst].push(e.src);
  });
  for(let i=0;i<N;i++){
    const n=simNodes[i];
    const nbrs=adjMap[n.id]||[];
    if(nbrs.length>0){
      let cx=0,cy=0;
      nbrs.forEach(nid=>{const nb=nodeMap[nid];if(nb){cx+=nb.x;cy+=nb.y}});
      cx/=nbrs.length;cy/=nbrs.length;
      n.vx+=(cx-n.x)*0.006;n.vy+=(cy-n.y)*0.006;
    }
  }
  for(let i=0;i<N;i++){
    const n=simNodes[i];
    n.x+=n.vx;n.y+=n.vy;
    n.x=Math.max(-2000,Math.min(2000,n.x));n.y=Math.max(-2000,Math.min(2000,n.y));
  }
}

function screenToWorld(sx,sy){return{x:(sx-W/2)/camZoom+camX,y:(sy-H/2)/camZoom+camY}}
function worldToScreen(wx,wy){return{x:(wx-camX)*camZoom+W/2,y:(wy-camY)*camZoom+H/2}}

function render(){
  ctx.fillStyle='#0d1117';ctx.fillRect(0,0,W,H);
  if(simNodes.length===0){
    ctx.fillStyle='#484f58';ctx.font='14px sans-serif';ctx.textAlign='center';
    ctx.fillText('Select a project to visualize',W/2,H/2);return;
  }
  ctx.save();
  edges.forEach(e=>{
    const a=nodeMap[e.src],b=nodeMap[e.dst];
    if(!a||!b)return;
    const sa=worldToScreen(a.x,a.y),sb=worldToScreen(b.x,b.y);
    ctx.beginPath();ctx.moveTo(sa.x,sa.y);ctx.lineTo(sb.x,sb.y);
    const highlighted=hoveredNode&&(e.src===hoveredNode.id||e.dst===hoveredNode.id);
    ctx.strokeStyle=highlighted?'#58a6ff33':'#30363d';ctx.lineWidth=highlighted?1.2:0.5;ctx.stroke();
  });
  simNodes.forEach(n=>{
    const s=worldToScreen(n.x,n.y);
    if(s.x<-50||s.x>W+50||s.y<-50||s.y>H+50)return;
    const isHovered=hoveredNode&&hoveredNode.id===n.id;
    const isSearch=searchHits.has(n.id);
    const r=n.r*camZoom;
    if(isSearch){ctx.beginPath();ctx.arc(s.x,s.y,r+4,0,Math.PI*2);ctx.fillStyle='#e3b34144';ctx.fill()}
    ctx.beginPath();ctx.arc(s.x,s.y,r,0,Math.PI*2);
    ctx.fillStyle=isHovered?'#f0f6fc':LABEL_COLORS[n.label]||'#8b949e';
    ctx.fill();
    if(camZoom>0.35&&r>2){
      const fontSize=Math.max(9,Math.min(12,10*camZoom));
      ctx.font=fontSize+'px sans-serif';ctx.fillStyle=isHovered?'#f0f6fc':'#c9d1d9';
      ctx.textAlign='center';ctx.fillText(n.name,s.x,s.y-r-4);
    }
  });
  ctx.restore();
  requestAnimationFrame(render);
}

setInterval(simulate,16);
render();

function fetchAndLoad(project){
  if(!project)return;
  Promise.all([
    fetch('/api/nodes?project='+encodeURIComponent(project)).then(r=>r.json()),
    fetch('/api/edges?project='+encodeURIComponent(project)).then(r=>r.json())
  ]).then(([n,e])=>initSimulation(n,e)).catch(err=>console.error(err));
}

fetch('/api/projects').then(r=>r.json()).then(projects=>{
  projectSel.innerHTML='';
  if(projects.length===0){projectSel.innerHTML='<option>No projects found</option>';return}
  projects.forEach(p=>{
    const opt=document.createElement('option');opt.value=p.name;opt.textContent=p.name+' ('+p.node_count+' nodes)';
    projectSel.appendChild(opt);
  });
  fetchAndLoad(projects[0].name);
});
projectSel.addEventListener('change',()=>fetchAndLoad(projectSel.value));

searchBox.addEventListener('input',()=>{
  const q=searchBox.value.toLowerCase().trim();
  searchHits.clear();
  if(!q)return;
  simNodes.forEach(n=>{if(n.name.toLowerCase().includes(q))searchHits.add(n.id)});
});

canvas.addEventListener('mousedown',e=>{
  const w=screenToWorld(e.clientX,e.clientY);
  let closest=null,minDist=20/camZoom;
  simNodes.forEach(n=>{
    const d=Math.sqrt((n.x-w.x)**2+(n.y-w.y)**2);
    if(d<minDist){minDist=d;closest=n}
  });
  if(closest){dragNode=closest}
  else{isPanning=true;panStart={x:e.clientX,y:e.clientY}}
});
canvas.addEventListener('mousemove',e=>{
  if(dragNode){
    const w=screenToWorld(e.clientX,e.clientY);
    dragNode.x=w.x;dragNode.y=w.y;dragNode.vx=0;dragNode.vy=0;return;
  }
  if(isPanning){
    camX-=(e.clientX-panStart.x)/camZoom;camY-=(e.clientY-panStart.y)/camZoom;
    panStart={x:e.clientX,y:e.clientY};return;
  }
  const w=screenToWorld(e.clientX,e.clientY);
  hoveredNode=null;
  simNodes.forEach(n=>{
    const d=Math.sqrt((n.x-w.x)**2+(n.y-w.y)**2);
    if(d<12/camZoom)hoveredNode=n;
  });
  if(hoveredNode){
    tooltip.style.display='block';tooltip.style.left=(e.clientX+12)+'px';tooltip.style.top=(e.clientY+12)+'px';
    tooltip.querySelector('.tname').textContent=hoveredNode.name;
    tooltip.querySelector('.tdetail').textContent=hoveredNode.label+' | '+hoveredNode.file;
    canvas.style.cursor='pointer';
  }else{tooltip.style.display='none';canvas.style.cursor='grab'}
});
canvas.addEventListener('mouseup',()=>{dragNode=null;isPanning=false});
canvas.addEventListener('mouseleave',()=>{tooltip.style.display='none'});
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  const factor=e.deltaY<0?1.1:0.9;
  camZoom*=factor;camZoom=Math.max(0.05,Math.min(10,camZoom));
},{passive:false});
canvas.style.cursor='grab';
})();
</script>
</body>
</html>`;

function parseUrl(url: string): { pathname: string; params: URLSearchParams } {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, params: u.searchParams };
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function htmlResponse(res: http.ServerResponse): void {
  const body = Buffer.from(HTML_PAGE, 'utf-8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function notFound(res: http.ServerResponse, msg: string): void {
  jsonResponse(res, { error: msg }, 404);
}

export function createGraphServer(store: Store): http.Server {
  return http.createServer((req, res) => {
    try {
      const url = req.url ?? '/';
      const { pathname, params } = parseUrl(url);

      if (req.method === 'GET' && pathname === '/') {
        return htmlResponse(res);
      }

      if (req.method === 'GET' && pathname === '/api/projects') {
        return jsonResponse(res, store.listProjects());
      }

      if (req.method === 'GET' && pathname === '/api/nodes') {
        const project = params.get('project');
        if (!project) return notFound(res, '?project= is required');
        const raw = store.getNodesByProject(project);
        const nodes = raw.map((r) => ({
          id: r.id,
          label: r.label,
          name: r.name,
          qualified: r.qualified,
          file: r.file,
          start_line: r.start_line,
        }));
        return jsonResponse(res, nodes);
      }

      if (req.method === 'GET' && pathname === '/api/edges') {
        const project = params.get('project');
        if (!project) return notFound(res, '?project= is required');
        const nodeIds = new Set(
          store.getNodesByProject(project).map((r) => r.id),
        );
        const raw = store.getEdgesByProject(project);
        const edges = raw
          .filter(
            (e) =>
              e.src != null &&
              e.dst != null &&
              nodeIds.has(e.src) &&
              nodeIds.has(e.dst),
          )
          .map((e) => ({
            src: e.src,
            dst: e.dst,
            type: e.type,
            confidence: e.confidence,
            site_line: e.site_line,
          }));
        return jsonResponse(res, edges);
      }

      const nodeMatch = pathname.match(/^\/api\/node\/(\d+)$/);
      if (req.method === 'GET' && nodeMatch) {
        const id = Number(nodeMatch[1]);
        const node = store.getNodeById(id);
        if (!node) return notFound(res, 'node not found');
        return jsonResponse(res, node);
      }

      notFound(res, 'Not found');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, { error: msg }, 500);
    }
  });
}

export function startGraphServer(
  store: Store,
  port: number,
): Promise<{ server: http.Server; url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createGraphServer(store);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort =
        typeof addr === 'object' && addr !== null ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        server,
        url,
        close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
    server.on('error', reject);
  });
}
