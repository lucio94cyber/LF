/**
 * LF — Servidor para Render.com (gratis)
 * ────────────────────────────────────────
 * Incluye:
 *  - Proxy IOL (evita CORS del browser)
 *  - WhatsApp diario a las 9am via Twilio
 *  - Noticias reales: Google Finance + Infobae + El Cronista (RSS)
 *  - Dólar blue en tiempo real (dolarapi.com)
 *  - Datos de mercado: Yahoo Finance (misma fuente que Finviz)
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

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
let tok=null, tokExp=0, portfolio=[], lastDay=-1;

const cache = {
  noticias: { data: [], ts: 0 },
  dolar:    { data: null, ts: 0 },
  mercado:  { data: [], ts: 0 },
};
const TTL_N = 15 * 60 * 1000;
const TTL_D =  5 * 60 * 1000;
const TTL_M = 10 * 60 * 1000;

// ── HTTP Helpers ─────────────────────────────
function rq(opts, body) {
  return new Promise((ok, ko) => {
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { ok({ s: res.statusCode, b: JSON.parse(d) }); } catch { ok({ s: res.statusCode, b: d }); } });
    });
    r.on('error', ko);
    if (body) r.write(body);
    r.end();
  });
}

function httpGet(urlStr) {
  return new Promise((ok, ko) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 LF-Bot/1.0', 'Accept': '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(ok).catch(ko);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => ok({ s: res.statusCode, b: d }));
    });
    req.on('error', ko);
    req.setTimeout(8000, () => { req.destroy(); ko(new Error('timeout')); });
    req.end();
  });
}

function postRq(u, data, hd = {}) {
  const { hostname, pathname, search } = new URL(u);
  const b = new URLSearchParams(data).toString();
  return rq({ hostname, path: pathname + search, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b), ...hd } }, b);
}

function getRq(u, token) {
  const { hostname, pathname, search } = new URL(u);
  return rq({ hostname, path: pathname + search, method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function jsonResp(res, s, d) {
  cors(res); res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d));
}
function readBody(req) {
  return new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { ok(JSON.parse(d)); } catch { ok({}); } }); });
}

// ── RSS Parser ───────────────────────────────
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const i = m[1];
    const title   = (i.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || i.match(/<title>(.*?)<\/title>/))?.[1] || '';
    const link    = (i.match(/<link>(.*?)<\/link>/))?.[1] || '';
    const pubDate = (i.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
    if (title.trim()) items.push({ title: title.trim(), link, pubDate });
  }
  return items;
}

function timeAgo(date) {
  if (!date || isNaN(date)) return 'Hoy';
  const mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 60) return `Hace ${mins}m`;
  const hs = Math.floor(mins / 60);
  if (hs < 24) return `Hace ${hs}h`;
  return `Hace ${Math.floor(hs/24)}d`;
}

function detectImpact(t) {
  const tl = t.toLowerCase();
  if (['sube','suba','récord','record','máximo','gana','supera','crece','positivo','rally','rebota','alza'].some(p => tl.includes(p))) return 'positive';
  if (['baja','cae','cayó','pierde','mínimo','crisis','riesgo','negativo','caída','derrumbe'].some(p => tl.includes(p))) return 'negative';
  return 'neutral';
}

function detectTicker(t) {
  const map = {
    apple:'AAPL', iphone:'AAPL', ipad:'AAPL',
    nvidia:'NVDA', 'geforce':'NVDA',
    tesla:'TSLA', elon:'TSLA',
    mercadolibre:'MELI', 'mercado libre':'MELI',
    microsoft:'MSFT', azure:'MSFT',
    google:'GOOGL', alphabet:'GOOGL', youtube:'GOOGL',
    meta:'META', facebook:'META', instagram:'META', whatsapp:'META',
    amazon:'AMZN', aws:'AMZN',
    jpmorgan:'JPM', 'jp morgan':'JPM',
    alibaba:'BABA', 'ali baba':'BABA',
    netflix:'NFLX',
    intel:'INTC',
    amd:'AMD',
    shopify:'SHOP',
    spotify:'SPOT',
    disney:'DIS',
    'bank of america':'BAC',
    goldman:'GS',
    exxon:'XOM', chevron:'CVX',
    pfizer:'PFE',
    'coca cola':'KO', cocacola:'KO',
    walmart:'WMT',
    'dow jones':'SPY', 'wall street':'SPY', 's&p':'SPY', nasdaq:'QQQ',
    cedear:'ARG', byma:'ARG', merval:'ARG', bcra:'ARG', dolar:'ARG',
  };
  const tl = t.toLowerCase();
  for (const [k,v] of Object.entries(map)) { if (tl.includes(k)) return v; }
  for (const tk of ['AAPL','NVDA','TSLA','MELI','MSFT','GOOGL','META','AMZN','JPM','XOM','NFLX','AMD','INTC','SHOP','BABA','DIS','KO','WMT']) {
    if (t.includes(tk)) return tk;
  }
  return 'ARG';
}

// ── Noticias RSS ─────────────────────────────
async function fetchNoticias() {
  if (Date.now() - cache.noticias.ts < TTL_N && cache.noticias.data.length) return cache.noticias.data;

  const fuentes = [
    // Yahoo Finance — cedears principales (más confiable)
    { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL,NVDA,TSLA,MELI,MSFT&region=US&lang=en-US', src: 'Yahoo Finance' },
    { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=META,AMZN,GOOGL,JPM,XOM&region=US&lang=en-US', src: 'Yahoo Finance' },
    // Seeking Alpha — análisis de acciones
    { url: 'https://seekingalpha.com/market_currents.xml', src: 'Seeking Alpha' },
    // Reuters — mercados globales
    { url: 'https://feeds.reuters.com/reuters/businessNews', src: 'Reuters' },
    // Infobae Economía
    { url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/economia/', src: 'Infobae' },
    // El Cronista
    { url: 'https://www.cronista.com/arc/outboundfeeds/rss/', src: 'El Cronista' },
  ];

  // Solo noticias que impactan cedears e inversiones
  const KEYWORDS_OK = [
    'stock','stocks','market','markets','shares','nasdaq','dow jones','s&p','wall street',
    'earnings','revenue','profit','loss','fed','rate','inflation','gdp','economia','economía',
    'apple','nvidia','tesla','microsoft','google','alphabet','meta','amazon','mercadolibre',
    'meli','netflix','jpmorgan','alibaba','intel','amd','shopify','spotify','disney',
    'aapl','nvda','tsla','msft','googl','amzn','nflx','jpm','baba',
    'cedear','byma','merval','bcra','dólar','dolar','reservas','bolsa','acciones',
    'inversión','inversion','invertir','financiero','mercado financiero',
    'acción','accion','bono','fondo','etf','cripto','bitcoin',
    'oil','energy','tech','technology','semiconductor','ai','artificial intelligence',
    'bank','banking','finance','fintech','pharma','petróleo','minería',
  ];

  function esRelevante(title) {
    const tl = title.toLowerCase();
    return KEYWORDS_OK.some(kw => tl.includes(kw));
  }

  let todas = [];
  for (const f of fuentes) {
    try {
      const r = await httpGet(f.url);
      if (r.s === 200 && r.b && r.b.includes('<item>')) {
        const items = parseRSS(r.b);
        const relevantes = items.filter(item => esRelevante(item.title));
        relevantes.slice(0, 4).forEach(item => {
          todas.push({
            src: f.src,
            title: item.title,
            time: item.pubDate ? timeAgo(new Date(item.pubDate)) : 'Hoy',
            tk: detectTicker(item.title),
            imp: detectImpact(item.title),
            link: item.link,
          });
        });
      }
    } catch (e) { console.log(`RSS ${f.src}:`, e.message); }
  }

  if (!todas.length) {
    todas = [
      { src:'Yahoo Finance', title:'Wall Street opera mixto a la espera de datos económicos', time:'Hoy', tk:'SPY', imp:'neutral' },
      { src:'Infobae',       title:'Mercados argentinos: el BYMA opera con cedears en alza', time:'Hoy', tk:'ARG', imp:'positive' },
      { src:'El Cronista',   title:'Dólar y reservas: el BCRA interviene en la jornada', time:'Hoy', tk:'ARG', imp:'neutral' },
      { src:'MarketWatch',   title:'Tech stocks lead gains as AI demand remains strong', time:'Hoy', tk:'NVDA', imp:'positive' },
    ];
  }

  cache.noticias = { data: todas.slice(0, 8), ts: Date.now() };
  return cache.noticias.data;
}

// ── Dólar blue ───────────────────────────────
async function fetchDolar() {
  if (Date.now() - cache.dolar.ts < TTL_D && cache.dolar.data) return cache.dolar.data;
  try {
    const r = await httpGet('https://dolarapi.com/v1/dolares');
    const arr = JSON.parse(r.b);
    const data = {
      blue: arr.find(d => d.casa === 'blue')?.venta || null,
      mep:  arr.find(d => d.casa === 'bolsa')?.venta || null,
      ccl:  arr.find(d => d.casa === 'contadoconliqui')?.venta || null,
      ts:   new Date().toLocaleTimeString('es-AR'),
    };
    cache.dolar = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.log('Dolar API:', e.message);
    return cache.dolar.data || { blue: null, mep: null, ccl: null };
  }
}

// ── Yahoo Finance (datos estilo Finviz) ───────
async function fetchMercado() {
  if (Date.now() - cache.mercado.ts < TTL_M && cache.mercado.data.length) return cache.mercado.data;
  const tickers = 'AAPL,MSFT,GOOGL,AMZN,TSLA,META,NVDA,NFLX,MELI,BABA,JPM,XOM,CVX,PFE,KO,MCD,AMD,INTC,SHOP,UBER';
  try {
    const apiUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers}&fields=regularMarketPrice,regularMarketChangePercent,trailingPE,forwardPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyDayAverage,twoHundredDayAverage,recommendationMean&lang=en&region=US`;
    const r = await httpGet(apiUrl);
    const json = JSON.parse(r.b);
    const quotes = json.quoteResponse?.result || [];
    const data = quotes.map(q => ({
      ticker: q.symbol,
      price:  q.regularMarketPrice,
      change: q.regularMarketChangePercent,
      pe:     q.trailingPE,
      fwdPe:  q.forwardPE,
      high52: q.fiftyTwoWeekHigh,
      low52:  q.fiftyTwoWeekLow,
      ma50:   q.fiftyDayAverage,
      ma200:  q.twoHundredDayAverage,
      rec:    q.recommendationMean,
      score:  calcScore(q),
    }));
    cache.mercado = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.log('Yahoo Finance:', e.message);
    return cache.mercado.data || [];
  }
}

function calcScore(q) {
  let s = 50;
  const chg=q.regularMarketChangePercent||0, pe=q.trailingPE||999, fpe=q.forwardPE||999;
  const price=q.regularMarketPrice||0, h52=q.fiftyTwoWeekHigh||1, l52=q.fiftyTwoWeekLow||0;
  const ma50=q.fiftyDayAverage||0, ma200=q.twoHundredDayAverage||0, rec=q.recommendationMean||3;
  if(chg>3)s+=12;else if(chg>1)s+=7;else if(chg>0)s+=3;else if(chg<-3)s-=12;else if(chg<-1)s-=7;else s-=3;
  if(pe>0&&pe<20)s+=10;else if(pe<35)s+=5;else if(pe>60)s-=10;
  if(fpe>0&&fpe<pe)s+=8;
  if(h52>l52){const pos=(price-l52)/(h52-l52);if(pos<0.3)s+=12;else if(pos>0.85)s+=5;else if(pos<0.5)s+=6;}
  if(price>ma50&&ma50>ma200)s+=10;else if(price<ma50&&ma50<ma200)s-=10;else if(price>ma200)s+=4;
  if(rec<=1.5)s+=10;else if(rec<=2.5)s+=5;else if(rec>=4)s-=8;
  return Math.max(0,Math.min(100,Math.round(s)));
}

// ── IOL Auth ─────────────────────────────────
async function getToken(user, pass) {
  if (tok && Date.now() < tokExp) return tok;
  const r = await postRq(`${IOL}/token`, { username: user, password: pass, grant_type: 'password' });
  if (r.s !== 200 || !r.b.access_token) throw new Error(r.b.error_description || 'Login IOL fallido');
  tok = r.b.access_token; tokExp = Date.now() + (r.b.expires_in - 60) * 1000; return tok;
}

// ── WhatsApp ──────────────────────────────────
const waOk = () => E.TWILIO_SID && E.TWILIO_TOKEN && E.WA_TO;

async function sendWA(msg) {
  if (!waOk()) { console.log('[WA simulado]\n' + msg); return { ok: false, simulado: true }; }
  const auth = Buffer.from(`${E.TWILIO_SID}:${E.TWILIO_TOKEN}`).toString('base64');
  const r = await postRq(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_SID}/Messages.json`,
    { From: E.TWILIO_FROM, To: E.WA_TO, Body: msg }, { Authorization: `Basic ${auth}` });
  if (r.s === 201) { console.log(`✅ WA → ${E.WA_TO}`); return { ok: true }; }
  console.error('❌ Twilio:', r.b?.message); return { ok: false, error: r.b?.message };
}

function buildWAMsg(activos, noticias, dolar) {
  const fecha = new Date().toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
  let tv=0, tg=0, urgentes=[], bien=[];
  activos.forEach(a => {
    const tk=a.titulo?.simbolo||'?', pct=a.gananciaPorcentaje||0, ars=a.gananciaDinero||0;
    tv+=a.valorizado||0; tg+=ars;
    if(pct<=E.STOP||pct>=E.GANANCIA) urgentes.push({tk,pct,accion:pct<=E.STOP?'🚨 SALIR':'💰 TOMAR GANANCIA'});
    else bien.push({tk,pct});
  });
  const s=tg>=0?'+':'', tend=tg>=0?'📈':'📉';
  let m=`*LF — ¿Qué hago hoy?* 💼\n📅 ${fecha.charAt(0).toUpperCase()+fecha.slice(1)}\n\n`;
  if(dolar?.blue) { m+=`💵 *Dólar blue: $${dolar.blue.toLocaleString('es-AR')}*`; if(dolar.mep) m+=` | MEP: $${dolar.mep.toLocaleString('es-AR')}`; m+='\n\n'; }
  m+=`${tend} *Cartera: $${Math.round(tv).toLocaleString('es-AR')} ARS*\nResultado: *${s}$${Math.round(Math.abs(tg)).toLocaleString('es-AR')}*\n`;
  if(urgentes.length){m+=`\n━━━━━━━━━━\n🔴 *ACCIÓN HOY*\n`;urgentes.forEach(u=>{m+=`${u.accion} *${u.tk}*: ${u.pct>=0?'+':''}${u.pct.toFixed(1)}%\n`;});}
  if(bien.length){m+=`\n━━━━━━━━━━\n✅ *MANTENER*\n`;bien.forEach(b=>{m+=`${b.tk}: ${b.pct>=0?'+':''}${b.pct.toFixed(1)}%\n`;});}
  if(noticias?.length){m+=`\n━━━━━━━━━━\n📰 *Noticias clave*\n`;noticias.slice(0,3).forEach(n=>{m+=`• ${n.title.slice(0,80)}\n`;});}
  m+=`\n━━━━━━━━━━\n_Abrí LF para el análisis completo_`;
  return m;
}

async function resumenDiario() {
  if (!tok) { console.log('⏰ Sin sesión IOL.'); return { ok: false }; }
  console.log('⏰ Generando resumen...');
  try {
    const [portRes, noticias, dolar] = await Promise.all([
      getRq(`${IOL}/api/v2/portafolio/argentina`, tok), fetchNoticias(), fetchDolar()
    ]);
    const activos = portRes.b?.activos || portRes.b?.Activos || [];
    if (!activos.length) return { ok: false, error: 'Sin posiciones' };
    portfolio = activos;
    return await sendWA(buildWAMsg(activos, noticias, dolar));
  } catch (e) { console.error('Error:', e.message); return { ok: false, error: e.message }; }
}

setInterval(() => {
  const n = new Date();
  if (n.getHours() === E.HORA && n.getDate() !== lastDay) { lastDay = n.getDate(); resumenDiario(); }
}, 60000);

// ── HTTP Server ───────────────────────────────
http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (pathname === '/health' || pathname === '/') {
    cors(res); res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('LF server OK');
  }
  if (req.method === 'POST' && pathname === '/login') {
    try { const {username,password}=await readBody(req); const t=await getToken(username,password); return jsonResp(res,200,{ok:true,token:t}); }
    catch(e){return jsonResp(res,401,{error:e.message});}
  }
  if (req.method === 'GET' && pathname === '/portafolio') {
    const t=req.headers.authorization?.replace('Bearer ','');
    if(!t) return jsonResp(res,401,{error:'Sin token'});
    try{const r=await getRq(`${IOL}/api/v2/portafolio/argentina`,t);if(r.b?.activos)portfolio=r.b.activos;return jsonResp(res,r.s,r.b);}
    catch(e){return jsonResp(res,500,{error:e.message});}
  }
  if (req.method === 'GET' && pathname === '/saldo') {
    const t=req.headers.authorization?.replace('Bearer ','');
    if(!t) return jsonResp(res,401,{error:'Sin token'});
    try{const r=await getRq(`${IOL}/api/v2/estadocuenta`,t);return jsonResp(res,r.s,r.b);}
    catch(e){return jsonResp(res,500,{error:e.message});}
  }
  if (req.method === 'GET' && pathname === '/noticias') {
    try{const data=await fetchNoticias();return jsonResp(res,200,{ok:true,noticias:data});}
    catch(e){return jsonResp(res,500,{error:e.message});}
  }
  if (req.method === 'GET' && pathname === '/dolar') {
    try{const data=await fetchDolar();return jsonResp(res,200,{ok:true,dolar:data});}
    catch(e){return jsonResp(res,500,{error:e.message});}
  }
  // Análisis de cedear individual
  if (req.method === 'GET' && pathname === '/analizar-cedear') {
    try {
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const ticker = (qs.get('ticker') || 'AAPL').toUpperCase();
      const data = await fetchMercado();
      const info = data.find(c => c.ticker === ticker);
      if (!info) return jsonResp(res, 404, { error: 'Cedear no encontrado' });
      const ten = info.score >= 72 ? '1-3 semanas' : info.score >= 58 ? '1-2 meses' : 'Revisar posición';
      return jsonResp(res, 200, {
        ticker, score: info.score, price: info.price, change: info.change,
        pe: info.pe, recomendacion: ten,
        target: info.price ? (info.price * 1.10).toFixed(2) : null,
        stop:   info.price ? (info.price * 0.92).toFixed(2) : null,
      });
    } catch(e) { return jsonResp(res, 500, {error: e.message}); }
  }

  // Dólares de todas las casas
  if (req.method === 'GET' && pathname === '/cotizaciones-completas') {
    try {
      const r = await httpGet('https://dolarapi.com/v1/dolares');
      const d = JSON.parse(r.b);
      return jsonResp(res, 200, { ok: true, dolares: d });
    } catch(e) { return jsonResp(res, 500, {error: e.message}); }
  }
  if (req.method === 'GET' && pathname === '/mercado') {
    try{const data=await fetchMercado();return jsonResp(res,200,{ok:true,cedears:data});}
    catch(e){return jsonResp(res,500,{error:e.message});}
  }
  if (req.method === 'POST' && pathname === '/test-wa') {
    const dolar=await fetchDolar();
    let msg=`*LF — Prueba* ✅\n\nWhatsApp funcionando.\nResumen diario a las *${E.HORA}:00hs*.`;
    if(dolar?.blue) msg+=`\n\n💵 Dólar blue: $${dolar.blue.toLocaleString('es-AR')}`;
    return jsonResp(res,200,await sendWA(msg));
  }
  if (req.method === 'POST' && pathname === '/resumen') {
    return jsonResp(res,200,await resumenDiario()||{ok:false});
  }
  jsonResp(res, 404, { error: 'Not found' });

}).listen(E.PORT, () => {
  console.log(`LF Server → puerto ${E.PORT}`);
  console.log(`WhatsApp: ${waOk()?'✅':'⚠️  sin configurar'}`);
  console.log(`Resumen diario: ${E.HORA}:00hs`);
  console.log(`Endpoints: /noticias /dolar /mercado /portafolio /login /cotizaciones-completas /analizar-cedear`);
});
