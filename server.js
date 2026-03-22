/**
 * LF — Servidor para Render.com (gratis)
 * ────────────────────────────────────────
 * Corre en la nube 24/7 sin necesidad de
 * tener la computadora prendida.
 *
 * Incluye:
 *  - Proxy IOL (evita CORS del browser)
 *  - WhatsApp diario a las 9am via Twilio
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

// ══════════════════════════════════════════════
//  Variables de entorno (se configuran en Render)
//  NO pongas credenciales reales acá
// ══════════════════════════════════════════════
const E = {
  TWILIO_SID:   process.env.TWILIO_SID   || '',
  TWILIO_TOKEN: process.env.TWILIO_TOKEN || '',
  TWILIO_FROM:  process.env.TWILIO_FROM  || 'whatsapp:+14155238886',
  WA_TO:        process.env.WA_TO        || '',
  HORA:         parseInt(process.env.HORA||'9'),
  STOP:         parseFloat(process.env.STOP||'-8'),
  GANANCIA:     parseFloat(process.env.GANANCIA||'15'),
  PORT:         parseInt(process.env.PORT||'3001'),
};

const IOL = 'https://api.invertironline.com';
let tok=null, tokExp=0, port=[], lastDay=-1;

// ── Helpers ─────────────────────────────────
const P = d => new URLSearchParams(d).toString();

function rq(opts, body) {
  return new Promise((ok,ko) => {
    const r = https.request(opts, res => {
      let d='';
      res.on('data', c => d+=c);
      res.on('end', () => { try{ok({s:res.statusCode,b:JSON.parse(d)})}catch{ok({s:res.statusCode,b:d})} });
    });
    r.on('error', ko);
    if(body) r.write(body);
    r.end();
  });
}

function post(u, data, hd={}) {
  const {hostname,pathname,search}=new URL(u), b=P(data);
  return rq({hostname,path:pathname+search,method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b),...hd}},b);
}

function get(u, token) {
  const {hostname,pathname,search}=new URL(u);
  return rq({hostname,path:pathname+search,method:'GET',
    headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
}

function json(res,s,d) {
  cors(res);
  res.writeHead(s,{'Content-Type':'application/json'});
  res.end(JSON.stringify(d));
}

function rbody(req) {
  return new Promise(ok => {
    let d='';
    req.on('data',c=>d+=c);
    req.on('end',()=>{ try{ok(JSON.parse(d))}catch{ok({})} });
  });
}

// ── IOL Auth ─────────────────────────────────
async function getToken(user, pass) {
  if(tok && Date.now()<tokExp) return tok;
  const r = await post(`${IOL}/token`,{username:user,password:pass,grant_type:'password'});
  if(r.s!==200||!r.b.access_token) throw new Error(r.b.error_description||'Login IOL fallido');
  tok=r.b.access_token;
  tokExp=Date.now()+(r.b.expires_in-60)*1000;
  return tok;
}

// ── WhatsApp ──────────────────────────────────
const waOk = () => E.TWILIO_SID && E.TWILIO_TOKEN && E.WA_TO;

async function sendWA(msg) {
  if(!waOk()) {
    console.log('[WA simulado]\n'+msg);
    return {ok:false,simulado:true};
  }
  const auth = Buffer.from(`${E.TWILIO_SID}:${E.TWILIO_TOKEN}`).toString('base64');
  const r = await post(
    `https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_SID}/Messages.json`,
    {From:E.TWILIO_FROM,To:E.WA_TO,Body:msg},
    {Authorization:`Basic ${auth}`}
  );
  if(r.s===201) { console.log(`✅ WA enviado → ${E.WA_TO}`); return {ok:true}; }
  console.error('❌ Twilio error:',r.b?.message);
  return {ok:false,error:r.b?.message};
}

function buildMsg(activos) {
  const fecha = new Date().toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
  let tv=0,tg=0,urgentes=[],bien=[];
  activos.forEach(a=>{
    const tk=a.titulo?.simbolo||'?', pct=a.gananciaPorcentaje||0, ars=a.gananciaDinero||0;
    tv+=a.valorizado||0; tg+=ars;
    if(pct<=E.STOP||pct>=E.GANANCIA) urgentes.push({tk,pct,accion:pct<=E.STOP?'🚨 SALIR':'💰 TOMAR GANANCIA'});
    else bien.push({tk,pct});
  });
  const s=tg>=0?'+':'', tend=tg>=0?'📈':'📉';
  let m=`*LF — ¿Qué hago hoy?* 💼\n`;
  m+=`📅 ${fecha.charAt(0).toUpperCase()+fecha.slice(1)}\n\n`;
  m+=`${tend} *$${Math.round(tv).toLocaleString('es-AR')} ARS*\n`;
  m+=`Resultado: *${s}$${Math.round(Math.abs(tg)).toLocaleString('es-AR')}*\n`;
  if(urgentes.length){
    m+=`\n━━━━━━━━━━\n🔴 *ACCIÓN HOY*\n`;
    urgentes.forEach(u=>{m+=`${u.accion} *${u.tk}*: ${u.pct>=0?'+':''}${u.pct.toFixed(1)}%\n`;});
  }
  if(bien.length){
    m+=`\n━━━━━━━━━━\n✅ *MANTENER*\n`;
    bien.forEach(b=>{m+=`${b.tk}: ${b.pct>=0?'+':''}${b.pct.toFixed(1)}%\n`;});
  }
  m+=`\n━━━━━━━━━━\n_Abrí LF para el análisis completo_`;
  return m;
}

async function resumen() {
  if(!tok) { console.log('⏰ Sin sesión IOL.'); return {ok:false}; }
  console.log('⏰ Generando resumen diario...');
  try {
    const r = await get(`${IOL}/api/v2/portafolio/argentina`,tok);
    const ac = r.b?.activos||r.b?.Activos||[];
    if(!ac.length) return {ok:false,error:'Sin posiciones'};
    port=ac;
    return await sendWA(buildMsg(ac));
  } catch(e) { console.error('Error:',e.message); return {ok:false,error:e.message}; }
}

// ── Scheduler 9am ────────────────────────────
setInterval(()=>{
  const n=new Date();
  if(n.getHours()===E.HORA && n.getDate()!==lastDay){
    lastDay=n.getDate(); resumen();
  }
},60000);

// ── HTTP Server ───────────────────────────────
const server = http.createServer(async (req,res)=>{
  const {pathname}=url.parse(req.url);
  if(req.method==='OPTIONS'){cors(res);res.writeHead(204);res.end();return;}

  // Health check para Render
  if(pathname==='/health'||pathname==='/'){
    cors(res); res.writeHead(200,{'Content-Type':'text/plain'});
    return res.end('LF server OK');
  }

  if(req.method==='POST'&&pathname==='/login'){
    try{
      const{username,password}=await rbody(req);
      const t=await getToken(username,password);
      return json(res,200,{ok:true,token:t});
    }catch(e){return json(res,401,{error:e.message});}
  }

  if(req.method==='GET'&&pathname==='/portafolio'){
    const t=req.headers.authorization?.replace('Bearer ','');
    if(!t) return json(res,401,{error:'Sin token'});
    try{
      const r=await get(`${IOL}/api/v2/portafolio/argentina`,t);
      if(r.b?.activos) port=r.b.activos;
      return json(res,r.s,r.b);
    }catch(e){return json(res,500,{error:e.message});}
  }

  if(req.method==='GET'&&pathname==='/saldo'){
    const t=req.headers.authorization?.replace('Bearer ','');
    if(!t) return json(res,401,{error:'Sin token'});
    try{const r=await get(`${IOL}/api/v2/estadocuenta`,t);return json(res,r.s,r.b);}
    catch(e){return json(res,500,{error:e.message});}
  }

  if(req.method==='POST'&&pathname==='/test-wa'){
    const r=await sendWA(`*LF — Prueba* ✅\n\nWhatsApp funcionando.\nResumen diario a las *${E.HORA}:00hs*.`);
    return json(res,200,r);
  }

  if(req.method==='POST'&&pathname==='/resumen'){
    const r=await resumen(); return json(res,200,r||{ok:false});
  }

  json(res,404,{error:'Not found'});
});

server.listen(E.PORT,()=>{
  console.log(`LF Server → puerto ${E.PORT}`);
  console.log(`WhatsApp: ${waOk()?'✅':'⚠️  sin configurar'}`);
  console.log(`Resumen diario: ${E.HORA}:00hs`);
});
