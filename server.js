// StockPulse India — Self-contained (HTML embedded)
// Deploy to Render.com: Start Command = node server.js
// Local: node server.js → open http://localhost:3000

const http  = require('http');
const https = require('https');
const url   = require('url');
const PORT  = process.env.PORT || 3000;

const RSS_FEEDS = [
  { id:'et',   name:'ET Markets',        color:'#ff6600', initials:'ET', url:'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { id:'et2',  name:'ET Stocks',         color:'#ff6600', initials:'E2', url:'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { id:'et3',  name:'ET Hot Stocks',     color:'#ff6600', initials:'E3', url:'https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/1977022822.cms' },
  { id:'lm',   name:'LiveMint',          color:'#0080ff', initials:'LM', url:'https://www.livemint.com/rss/markets' },
  { id:'lm2',  name:'LiveMint Companies',color:'#0080ff', initials:'L2', url:'https://www.livemint.com/rss/companies' },
  { id:'ndtv', name:'NDTV Profit',       color:'#e00000', initials:'NP', url:'https://feeds.feedburner.com/ndtvprofit-latest' },
  { id:'fe',   name:'Financial Express', color:'#006400', initials:'FE', url:'https://www.financialexpress.com/market/feed/' },
  { id:'inv',  name:'Investing.com IN',  color:'#e84141', initials:'IV', url:'https://in.investing.com/rss/news.rss' },
];

function fetchUrl(targetUrl, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const req = https.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const cache = { data: null, ts: 0, TTL: 10 * 60 * 1000 };

// Fetch full article HTML and extract text content
async function fetchArticleText(articleUrl) {
  try {
    const { status, body } = await fetchUrl(articleUrl);
    if (status !== 200) return '';
    // Strip scripts, styles, nav, footer
    let text = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#[\d]+;/g,' ')
      .replace(/\s+/g, ' ').trim();
    return text.substring(0, 8000); // cap at 8KB per article
  } catch(e) {
    return '';
  }
}

// Parse XML and return items with link
function parseRSSItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let im;
  while ((im = itemRe.exec(xml)) !== null) {
    const chunk = im[1];
    const getTag = (tag) => {
      const m = chunk.match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'i'));
      return m ? m[1].trim() : '';
    };
    const title   = getTag('title');
    const desc    = chunk.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0, 500);
    const link    = getTag('link') || getTag('guid');
    const pubDate = getTag('pubDate') || getTag('published');
    const ts      = pubDate ? new Date(pubDate).getTime() : Date.now();
    if (title) items.push({ title, desc, link, ts: isNaN(ts) ? Date.now() : ts });
  }
  return items;
}

// Keywords that indicate this article likely has full stock details inside
function likelyHasDetailedCalls(title, desc) {
  const text = (title + ' ' + desc).toLowerCase();
  return /recommends?\s+(\d+|two|three|four|five|six)\s+stock|stocks?\s+to\s+buy|buy\s+or\s+sell|trading\s+(ideas?|calls?|picks?)|top\s+(picks?|stocks?)|stock\s+picks?\s+today|breakout\s+stocks?/.test(text);
}

async function getAllFeeds() {
  if (cache.data && (Date.now() - cache.ts) < cache.TTL) {
    console.log('Serving cached feeds');
    return cache.data;
  }
  console.log('Fetching RSS feeds...');
  const results = [];

  for (const feed of RSS_FEEDS) {
    process.stdout.write('  ' + feed.name + '... ');
    try {
      const { status, body } = await fetchUrl(feed.url);
      console.log('HTTP', status, body.length + 'b');
      if (status !== 200) {
        results.push({ id: feed.id, name: feed.name, color: feed.color, initials: feed.initials, status, xml: '', error: 'HTTP ' + status });
        continue;
      }

      // Parse RSS items
      const rssItems = parseRSSItems(body);
      console.log('    ' + rssItems.length + ' items in RSS');

      // For articles likely containing multiple stock calls, fetch full page
      const enrichedItems = [];
      for (const item of rssItems.slice(0, 20)) {
        let fullText = item.title + ' ' + item.desc;
        if (likelyHasDetailedCalls(item.title, item.desc) && item.link && item.link.startsWith('http')) {
          process.stdout.write('      Fetching full article: ' + item.title.substring(0,50) + '...');
          const articleText = await fetchArticleText(item.link);
          if (articleText.length > 200) {
            fullText = item.title + ' ' + articleText;
            process.stdout.write(' (' + articleText.length + 'b)\n');
          } else {
            process.stdout.write(' FAILED\n');
          }
          // Small delay to be respectful
          await new Promise(r => setTimeout(r, 300));
        }
        enrichedItems.push({ ...item, fullText });
      }

      // Build synthetic XML from enriched items so client parser gets full text
      const syntheticXml = '<rss><channel>' +
        enrichedItems.map(item =>
          '<item>' +
          '<title><![CDATA[' + item.title + ']]></title>' +
          '<description><![CDATA[' + item.fullText + ']]></description>' +
          '<link>' + (item.link||'') + '</link>' +
          '<pubDate>' + new Date(item.ts).toUTCString() + '</pubDate>' +
          '</item>'
        ).join('') +
        '</channel></rss>';

      results.push({ id: feed.id, name: feed.name, color: feed.color, initials: feed.initials, status: 200, xml: syntheticXml });
    } catch(e) {
      console.log('ERROR:', e.message);
      results.push({ id: feed.id, name: feed.name, color: feed.color, initials: feed.initials, status: 0, xml: '', error: e.message });
    }
  }
  cache.data = results;
  cache.ts = Date.now();
  return results;
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StockPulse India — Live Analyst Calls</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f5f6fa;--card:#fff;--card2:#f8f9fb;
  --border:#e8eaed;--border2:#d1d5db;
  --txt:#111827;--muted:#6b7280;--hint:#9ca3af;
  --green:#059669;--green-bg:#ecfdf5;--green-border:#a7f3d0;
  --red:#dc2626;--red-bg:#fef2f2;--red-border:#fca5a5;
  --amber:#d97706;--amber-bg:#fffbeb;--amber-border:#fcd34d;
  --blue:#2563eb;--blue-bg:#eff6ff;--blue-border:#bfdbfe;
  --acc:#1D9E75;--font:system-ui,-apple-system,'Segoe UI',sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--txt);font-size:14px;min-height:100vh}

/* HEADER */
.header{background:#fff;border-bottom:1px solid var(--border);padding:0 16px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;letter-spacing:-.3px}
.logo-dot{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 3px rgba(29,158,117,.15)}
.logo span{color:var(--acc)}
.hdr-right{display:flex;align-items:center;gap:8px}
.status-pill{display:flex;align-items:center;gap:5px;font-size:11px;border-radius:20px;padding:3px 10px;font-weight:600}
.status-pill.ok{color:#065f46;background:#d1fae5;border:1px solid #6ee7b7}
.status-pill.error{color:#991b1b;background:#fee2e2;border:1px solid #fca5a5}
.status-pill.checking{color:#92400e;background:#fef3c7;border:1px solid #fcd34d}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:blink 1.2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

/* LAYOUT */
.layout{display:grid;grid-template-columns:200px 1fr;min-height:calc(100vh - 52px)}

/* SIDEBAR */
.sidebar{background:#fff;border-right:1px solid var(--border);padding:14px;position:sticky;top:52px;height:calc(100vh - 52px);overflow-y:auto}
.slabel{font-size:10px;font-weight:700;color:var(--hint);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 7px;display:flex;align-items:center;gap:5px}
.slabel:first-of-type{margin-top:0}
.tbtn{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;border-radius:7px;border:none;background:transparent;color:var(--muted);font-size:12px;cursor:pointer;font-family:var(--font);transition:all .15s;text-align:left;margin-bottom:2px}
.tbtn:hover{background:var(--bg);color:var(--txt)}
.tbtn.active{background:#ecfdf5;color:#065f46;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{padding:3px 9px;border-radius:20px;font-size:11px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;font-family:var(--font);transition:all .15s}
.chip.active{background:var(--blue-bg);color:var(--blue);border-color:var(--blue-border);font-weight:600}
.src-row{display:flex;align-items:center;justify-content:space-between;padding:5px 4px;border-radius:6px;cursor:pointer;transition:background .15s;margin-bottom:1px}
.src-row:hover{background:var(--bg)}
.src-name{font-size:11px;color:var(--txt);display:flex;align-items:center;gap:6px}
.src-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.tog{width:28px;height:16px;border-radius:8px;border:1px solid var(--border2);background:var(--bg);position:relative;transition:background .2s;cursor:pointer;flex-shrink:0}
.tog.on{background:#d1fae5;border-color:#6ee7b7}
.knob{position:absolute;width:10px;height:10px;border-radius:50%;background:var(--hint);top:2px;left:2px;transition:all .2s}
.tog.on .knob{left:14px;background:var(--green)}

/* MAIN */
.main{padding:14px;overflow-y:auto;max-width:900px}

/* TOP BAR */
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.page-title{font-size:15px;font-weight:700}
.top-right{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.cnt-badge{font-size:11px;color:var(--muted);background:#fff;padding:3px 10px;border-radius:20px;border:1px solid var(--border)}
.fetch-btn{display:flex;align-items:center;gap:5px;padding:7px 14px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:7px;color:#065f46;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}
.fetch-btn:hover{background:#d1fae5}
.fetch-btn:disabled{opacity:.5;cursor:not-allowed}
.add-btn{display:flex;align-items:center;gap:5px;padding:7px 12px;background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:7px;color:var(--blue);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}

/* MARKET SUMMARY BOX */
.summary-box{background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.summary-title{font-size:12px;font-weight:700;color:var(--txt);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.summary-title span{font-size:10px;font-weight:500;color:var(--muted)}

/* TABLE VIEW */
.table-wrap{background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px}
.table-header{display:grid;grid-template-columns:110px 60px 90px 90px 90px 1fr;gap:0;background:#f9fafb;border-bottom:1px solid var(--border);padding:8px 12px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px}
.table-row{display:grid;grid-template-columns:110px 60px 90px 90px 90px 1fr;gap:0;padding:10px 12px;border-bottom:1px solid var(--border);align-items:start;transition:background .15s;cursor:pointer}
.table-row:last-child{border-bottom:none}
.table-row:hover{background:#f9fafb}
.t-stock{display:flex;flex-direction:column;gap:2px}
.t-ticker{font-family:monospace;font-size:13px;font-weight:700;color:var(--txt)}
.t-cname{font-size:10px;color:var(--muted);line-height:1.3}
.t-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;display:inline-block;width:fit-content;letter-spacing:.3px}
.t-badge.buy{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.t-badge.sell{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.t-badge.watch{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.t-price{font-family:monospace;font-size:12px;font-weight:600;color:var(--txt)}
.t-price.target{color:var(--green)}
.t-price.sl{color:var(--red)}
.t-price.na{color:var(--hint);font-size:11px;font-weight:400;font-family:var(--font)}
.t-note{font-size:11px;color:var(--muted);line-height:1.5}
.t-src{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:3px}
.t-src-logo{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;border:1px solid var(--border)}
.t-src-anchor{font-size:10px;color:var(--acc)}
.t-src-time{font-size:10px;color:var(--hint)}
.t-del{background:none;border:none;color:var(--hint);cursor:pointer;font-size:14px;padding:0;line-height:1;margin-left:auto}
.t-del:hover{color:var(--red)}

/* SECTION LABEL */
.section-label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;padding:8px 12px;background:#f9fafb;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px}

/* PROGRESS */
.prog-wrap{background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:12px;display:none}
.prog-label{font-size:11px;color:var(--muted);margin-bottom:6px;display:flex;justify-content:space-between}
.prog-bar{height:3px;background:var(--border);border-radius:2px;overflow:hidden}
.prog-fill{height:100%;background:var(--acc);border-radius:2px;transition:width .4s ease;width:0%}
.prog-steps{margin-top:8px;display:flex;flex-direction:column;gap:3px;max-height:120px;overflow-y:auto}
.pstep{font-size:11px;display:flex;align-items:flex-start;gap:5px;padding:1px 0}
.pstep.done{color:#065f46}.pstep.done i{color:var(--green)}
.pstep.fail{color:#991b1b}.pstep.fail i{color:var(--red)}
.pstep.load{color:var(--muted)}.pstep.load i{color:var(--amber)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{animation:spin .7s linear infinite;display:inline-block}

/* EMPTY */
.empty-state{text-align:center;padding:3rem 1rem;color:var(--muted)}
.empty-state i{font-size:32px;display:block;margin-bottom:8px;opacity:.2}
.empty-state p{font-size:13px;line-height:1.7;max-width:340px;margin:0 auto}

/* SERVER WARN */
.server-warn{background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:10px;padding:12px 14px;margin-bottom:12px;display:none}
.server-warn h3{font-size:12px;font-weight:700;color:var(--amber);margin-bottom:6px}
.server-warn p{font-size:11px;color:var(--muted);line-height:1.7;margin-bottom:5px}
.server-warn code{background:#fef3c7;padding:1px 6px;border-radius:3px;font-family:monospace;font-size:11px;color:#92400e}

/* MODAL */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(2px)}
.modal{background:#fff;border:1px solid var(--border2);border-radius:12px;padding:20px;width:380px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.12)}
.modal-title{font-size:14px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between}
.modal-title button{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:18px}
.frow{margin-bottom:10px}
.frow label{display:block;font-size:10px;font-weight:700;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.frow input,.frow select{width:100%;padding:7px 10px;border-radius:7px;border:1px solid var(--border2);background:var(--bg);color:var(--txt);font-size:13px;font-family:var(--font);outline:none}
.frow input:focus,.frow select:focus{border-color:var(--acc)}
.fgrid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.fgrid-2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.save-btn{width:100%;padding:9px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:7px;color:#065f46;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);margin-top:5px}
.ferr{font-size:11px;color:var(--red);margin-top:5px;display:none}

::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:10px}
@media(max-width:640px){
  .layout{grid-template-columns:1fr}
  .sidebar{height:auto;position:static;border-right:none;border-bottom:1px solid var(--border)}
  .table-header{display:none}
  .table-row{grid-template-columns:1fr 1fr;gap:6px;padding:10px 12px}
  .t-note{grid-column:1/-1}
}
</style>
</head>
<body>

<div class="header">
  <div class="logo"><div class="logo-dot"></div>Stock<span>Pulse</span> India</div>
  <div class="hdr-right">
    <span class="free-pill">NO API KEY</span>
    <div class="status-pill checking" id="srv-pill"><div class="dot"></div><span id="srv-txt">Checking server…</span></div>
    <div class="last-upd" id="last-upd"><i class="ti ti-clock" style="font-size:12px"></i>Not fetched yet</div>
  </div>
</div>

<div class="layout">
  <div class="sidebar">
    <div class="slabel">Time Filter</div>
    <button class="tbtn active" onclick="setTime(this,24)"><i class="ti ti-bolt"></i>Today</button>
    <button class="tbtn" onclick="setTime(this,72)"><i class="ti ti-calendar-week"></i>Past 3 Days</button>
    <button class="tbtn" onclick="setTime(this,168)"><i class="ti ti-calendar"></i>Past 1 Week</button>
    <button class="tbtn" onclick="setTime(this,99999)"><i class="ti ti-infinity"></i>All Time</button>

    <div class="slabel">Action</div>
    <div class="chips" id="act-chips">
      <button class="chip active" onclick="setAct('All',this)">All</button>
      <button class="chip" onclick="setAct('BUY',this)">Buy</button>
      <button class="chip" onclick="setAct('SELL',this)">Sell</button>
      <button class="chip" onclick="setAct('WATCH',this)">Watch</button>
    </div>

    <div class="slabel">Sources</div>
    <div id="src-list"></div>
  </div>

  <div class="main">
    <!-- SERVER NOT RUNNING WARNING -->
    <div class="server-warn" id="srv-warn">
      <h3><i class="ti ti-alert-triangle" style="font-size:14px"></i>Local server not running</h3>
      <p>This app needs a tiny local server to fetch RSS feeds from Indian news sites (browsers block direct requests for security). It takes 30 seconds to set up — <strong>one time only</strong>:</p>
      <p><strong>Step 1:</strong> Make sure Node.js is installed → <a href="https://nodejs.org" target="_blank" style="color:var(--acc)">nodejs.org</a> (free)</p>
      <p><strong>Step 2:</strong> Open Terminal / Command Prompt in the folder where you saved these files and run:</p>
      <p><code>node server.js</code></p>
      <p><strong>Step 3:</strong> Open <code>http://localhost:3000</code> in your browser instead of the HTML file directly.</p>
      <p style="color:var(--amber);font-size:11px"><i class="ti ti-info-circle" style="font-size:12px;vertical-align:-1px"></i> Keep the terminal window open while using the app.</p>
    </div>

    <div class="top-bar">
      <span class="page-title">Analyst Recommendations</span>
      <div class="top-right">
        <span class="cnt-badge" id="cnt">0 calls</span>
        <button class="fetch-btn" id="fetch-btn" onclick="fetchAll()">
          <i class="ti ti-antenna-bars-5"></i>Auto Fetch Now
        </button>
        <button class="add-btn" onclick="openModal()"><i class="ti ti-plus"></i>Add Manual</button>
      </div>
    </div>

    <div class="prog-wrap" id="prog-wrap">
      <div class="prog-label"><span id="prog-text">Starting…</span><span id="prog-pct">0%</span></div>
      <div class="prog-bar"><div class="prog-fill" id="prog-fill"></div></div>
      <div class="prog-steps" id="prog-steps"></div>
    </div>

    <div class="grid" id="grid"></div>
  </div>
</div>

<script>
// ── SOURCES (must match server.js) ──────────────────────────────────────────
const SOURCES = [
  { id:'et',   name:'ET Markets',          color:'#ff6600', initials:'ET', enabled:true },
  { id:'et2',  name:'ET Stocks',           color:'#ff6600', initials:'E2', enabled:true },
  { id:'et3',  name:'ET Hot Stocks',       color:'#ff6600', initials:'E3', enabled:true },
  { id:'lm',   name:'LiveMint',            color:'#0080ff', initials:'LM', enabled:true },
  { id:'lm2',  name:'LiveMint Companies',  color:'#0080ff', initials:'L2', enabled:true },
  { id:'ndtv', name:'NDTV Profit',         color:'#e00000', initials:'NP', enabled:true },
  { id:'fe',   name:'Financial Express',   color:'#006400', initials:'FE', enabled:true },
  { id:'inv',  name:'Investing.com IN',    color:'#e84141', initials:'IV', enabled:true },
];

// ── TICKER MAP ────────────────────────────────────────────────────────────────
const TICKER_MAP = [
  [/reliance\\s*(industries)?/i,'RELIANCE','Reliance Industries'],
  [/hdfc\\s*bank/i,'HDFCBANK','HDFC Bank'],
  [/\\bhdfc\\b(?!\\s*(bank|amc|life))/i,'HDFC','HDFC Ltd'],
  [/icici\\s*bank/i,'ICICIBANK','ICICI Bank'],
  [/infosys|\\binfy\\b/i,'INFY','Infosys'],
  [/\\btcs\\b|tata\\s*consultancy/i,'TCS','TCS'],
  [/wipro/i,'WIPRO','Wipro'],
  [/hcl\\s*(tech|technologies)/i,'HCLTECH','HCL Tech'],
  [/tech\\s*mahindra/i,'TECHM','Tech Mahindra'],
  [/\\bitc\\b/i,'ITC','ITC'],
  [/tata\\s*motors/i,'TATAMOTORS','Tata Motors'],
  [/tata\\s*steel/i,'TATASTEEL','Tata Steel'],
  [/tata\\s*power/i,'TATAPOWER','Tata Power'],
  [/maruti(\\s*suzuki)?/i,'MARUTI','Maruti Suzuki'],
  [/mahindra\\s*(and|\\&)\\s*mahindra|\\bm\\s*&\\s*m\\b/i,'M&M','M&M'],
  [/bajaj\\s*finance\\b(?!\\s*serv)/i,'BAJFINANCE','Bajaj Finance'],
  [/bajaj\\s*finserv/i,'BAJAJFINSV','Bajaj Finserv'],
  [/bajaj\\s*auto/i,'BAJAJ-AUTO','Bajaj Auto'],
  [/hero\\s*(motocorp|moto)/i,'HEROMOTOCO','Hero MotoCorp'],
  [/sun\\s*pharma/i,'SUNPHARMA','Sun Pharma'],
  [/\\bcipla\\b/i,'CIPLA','Cipla'],
  [/dr[\\.\\s]*reddy/i,'DRREDDY',"Dr Reddy's"],
  [/divis\\s*lab/i,'DIVISLAB',"Divi's Lab"],
  [/apollo\\s*hosp/i,'APOLLOHOSP','Apollo Hospitals'],
  [/coal\\s*india/i,'COALINDIA','Coal India'],
  [/\\bntpc\\b/i,'NTPC','NTPC'],
  [/power\\s*grid/i,'POWERGRID','Power Grid'],
  [/adani\\s*ports/i,'ADANIPORTS','Adani Ports'],
  [/adani\\s*green/i,'ADANIGREEN','Adani Green'],
  [/adani\\s*ent/i,'ADANIENT','Adani Enterprises'],
  [/adani\\s*power/i,'ADANIPOWER','Adani Power'],
  [/jsw\\s*steel/i,'JSWSTEEL','JSW Steel'],
  [/hindalco/i,'HINDALCO','Hindalco'],
  [/\\bvedanta\\b/i,'VEDL','Vedanta'],
  [/\\bsbi\\b|state\\s*bank/i,'SBIN','SBI'],
  [/bank\\s*of\\s*baroda/i,'BANKBARODA','Bank of Baroda'],
  [/axis\\s*bank/i,'AXISBANK','Axis Bank'],
  [/kotak(\\s*mahindra)?\\s*bank/i,'KOTAKBANK','Kotak Bank'],
  [/indusind\\s*bank/i,'INDUSINDBK','IndusInd Bank'],
  [/yes\\s*bank/i,'YESBANK','Yes Bank'],
  [/hindustan\\s*unilever|\\bhul\\b/i,'HINDUNILEVER','HUL'],
  [/\\bnestle\\b/i,'NESTLEIND','Nestle India'],
  [/\\bbritannia\\b/i,'BRITANNIA','Britannia'],
  [/\\bdabur\\b/i,'DABUR','Dabur'],
  [/\\bmarico\\b/i,'MARICO','Marico'],
  [/asian\\s*paints/i,'ASIANPAINT','Asian Paints'],
  [/l\\s*&\\s*t\\b|larsen\\s*(and|\\&)\\s*toubro/i,'LT','L&T'],
  [/ultratech/i,'ULTRACEMCO','UltraTech Cement'],
  [/shree\\s*cement/i,'SHREECEM','Shree Cement'],
  [/\\bacc\\b(?!\\s*limit)/i,'ACC','ACC'],
  [/ambuja/i,'AMBUJACEM','Ambuja Cement'],
  [/bharti\\s*airtel|airtel/i,'BHARTIARTL','Bharti Airtel'],
  [/\\bdmart\\b|avenue\\s*supermarts/i,'DMART','DMart'],
  [/\\bzomato\\b/i,'ZOMATO','Zomato'],
  [/\\bpaytm\\b/i,'PAYTM','Paytm'],
  [/\\bdlf\\b/i,'DLF','DLF'],
  [/godrej\\s*prop/i,'GODREJPROP','Godrej Properties'],
  [/\\bongc\\b/i,'ONGC','ONGC'],
  [/\\bbpcl\\b/i,'BPCL','BPCL'],
  [/\\bgail\\b/i,'GAIL','GAIL'],
  [/\\bmrf\\b/i,'MRF','MRF'],
  [/apollo\\s*tyre/i,'APOLLOTYRE','Apollo Tyres'],
  [/\\bpidilite\\b/i,'PIDILITIND','Pidilite'],
  [/\\bsiemens\\b/i,'SIEMENS','Siemens'],
  [/\\bbiocon\\b/i,'BIOCON','Biocon'],
  [/\\bhavells\\b/i,'HAVELLS','Havells'],
  [/\\bvoltas\\b/i,'VOLTAS','Voltas'],
  [/persistent\\s*sys/i,'PERSISTENT','Persistent Systems'],
  [/\\bmphasis\\b/i,'MPHASIS','Mphasis'],
  [/ltimindtree|lti\\s*mindtree/i,'LTIM','LTIMindtree'],
  [/\\bcoforge\\b/i,'COFORGE','Coforge'],
  [/\\bkpit\\b/i,'KPIT','KPIT Tech'],
  [/\\bmanappuram\\b/i,'MANAPPURAM','Manappuram'],
  [/muthoot\\s*fin/i,'MUTHOOTFIN','Muthoot Finance'],
  [/\\babb\\b/i,'ABB','ABB India'],
  [/lnt\\s*fin|l&t\\s*fin/i,'LTFH','L&T Finance'],
  [/\\bnifty\\s*50|\\bnifty\\b(?!\\s*(bank|it|auto|pharma|metal|realty|fin|mid))/i,'NIFTY','Nifty 50'],
  [/bank\\s*nifty|banknifty/i,'BANKNIFTY','Bank Nifty'],
  [/\\bsensex\\b/i,'SENSEX','Sensex'],
  [/nifty\\s*it\\b/i,'NIFTYIT','Nifty IT'],
  [/nifty\\s*auto\\b/i,'NIFTYAUTO','Nifty Auto'],
  [/nifty\\s*pharma\\b/i,'NIFTYPHARMA','Nifty Pharma'],
  [/nifty\\s*metal\\b/i,'NIFTYMETAL','Nifty Metal'],
  [/nifty\\s*realty\\b/i,'NIFTYREALTY','Nifty Realty'],
  [/godrej\\s*cons/i,'GODREJCP','Godrej Consumer'],
  [/\\bberger\\b/i,'BERGEPAINT','Berger Paints'],
  [/sun\\s*tv/i,'SUNTV','Sun TV'],
  [/zee\\s*ent/i,'ZEEL','Zee Entertainment'],
  [/\\bsrf\\b/i,'SRF','SRF'],
  [/balkrishna|bkt\\b/i,'BALKRISIND','Balkrishna Ind'],
  [/\\bexide\\b/i,'EXIDEIND','Exide Industries'],
  [/\\bceat\\b/i,'CEATLTD','CEAT'],
  [/\\btorrent\\s*pharma/i,'TORNTPHARM','Torrent Pharma'],
  [/\\baurobindo/i,'AUROPHARMA','Aurobindo Pharma'],
  [/\\blupine?\\b/i,'LUPIN','Lupin'],
  [/\\bglaxo\\b|\\bgsk\\b/i,'GLAXO','GSK Pharma'],
  [/\\bpfc\\b|power\\s*fin/i,'PFC','Power Finance'],
  [/\\brec\\b(?!\\s*ltd)/i,'RECLTD','REC Ltd'],
  [/\\birfc\\b/i,'IRFC','IRFC'],
  [/\\btata\\s*comm/i,'TATACOMM','Tata Communications'],
  [/\\bindiamart\\b/i,'INDIAMART','IndiaMART'],
  [/\\binfo\\s*edge|naukri/i,'NAUKRI','Info Edge'],
  [/\\bjubilant\\s*food|dominos/i,'JUBLFOOD','Jubilant FoodWorks'],
  [/\\bdevyani/i,'DEVYANI','Devyani International'],
];

const KNOWN_ANCHORS = [
  'Anil Singhvi','Udayan Mukherjee','Nikunj Dalmia','Sumaira Abidi','Latha Venkatesh',
  'Alex Mathews','Madan Sabnavis','Prakash Gaba','Mitesh Thakkar','Ashwani Gujral',
  'Sudarshan Sukhani','Kunal Bothra','Sanjiv Bhasin','SP Tulsian','Rajat Bose',
  'Gaurang Shah','Hemang Jani','Santosh Singh','Vivek Mahajan','Jatin Gedia',
  'Mazhar Mohammad','Shrikant Chouhan','Manish Hathiramani','Ravi Dharamshi',
  'Deepak Shenoy','Shankar Sharma','Rupal Bhansali','Aamar Deo Singh',
  'Vinod Nair','Sameet Chavan','Rohit Srivastava','Anand James',
];

// ── STATE ─────────────────────────────────────────────────────────────────────
let recos=[], nextId=1, timeH=99999, actFilter='All', fetchBusy=false, serverOk=false;

// ── INIT ──────────────────────────────────────────────────────────────────────
function init(){ renderSources(); render(); checkServer(); }

// ── SERVER URL — auto-detects local vs cloud ─────────────────────────────────
// If opened from a server (localhost or deployed), use same origin.
// This makes it work on mobile when deployed to Render/Railway etc.
function getServerBase() {
  const h = window.location.hostname;
  const p = window.location.port;
  const proto = window.location.protocol;
  // If opened as a file:// — use localhost fallback
  if (proto === 'file:') return 'http://localhost:3000';
  // If running on a server (local or cloud), use same origin
  return \`\${proto}//\${window.location.host}\`;
}
const SERVER = getServerBase();

// ── SERVER CHECK ──────────────────────────────────────────────────────────────
async function checkServer(){
  const pill = document.getElementById('srv-pill');
  const txt  = document.getElementById('srv-txt');
  const warn = document.getElementById('srv-warn');

  // Try up to 12 times (60 seconds total) — handles Render cold start
  for(let i = 1; i <= 12; i++){
    pill.className = 'status-pill checking';
    txt.textContent = i === 1 ? 'Connecting…' : 'Waking up… (' + i + '/12)';
    try {
      // Plain fetch — no AbortController, no signal (avoids cloning errors)
      const res = await fetch(SERVER + '/health');
      if(res.ok){
        serverOk = true;
        pill.className = 'status-pill ok';
        txt.textContent = 'Server connected';
        warn.style.display = 'none';
        fetchAll();
        return;
      }
    } catch(e) {
      // Network error — server still waking, keep trying
      console.log('Check attempt', i, 'failed:', e.message);
    }
    // Wait 5s before next attempt
    await new Promise(ok => setTimeout(ok, 5000));
  }
  // All attempts failed
  serverOk = false;
  pill.className = 'status-pill error';
  txt.textContent = 'Server not running';
  warn.style.display = 'block';
}

// ── SIDEBAR ───────────────────────────────────────────────────────────────────
function renderSources(){
  document.getElementById('src-list').innerHTML=SOURCES.map(s=>\`
    <div class="src-toggle" onclick="toggleSrc('\${s.id}')">
      <span class="src-name"><span class="src-dot" style="background:\${s.color}"></span>\${s.name}</span>
      <div class="tog \${s.enabled?'on':''}" id="sw-\${s.id}"><div class="knob"></div></div>
    </div>\`).join('');
}
function toggleSrc(id){
  const s=SOURCES.find(x=>x.id===id); if(!s) return;
  s.enabled=!s.enabled;
  const sw=document.getElementById('sw-'+id);
  sw.classList.toggle('on',s.enabled);
  sw.querySelector('.knob').style.left=s.enabled?'15px':'2px';
  render();
}
function setTime(btn,h){ timeH=h; document.querySelectorAll('.tbtn').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); render(); }
function setAct(v,btn){ actFilter=v; document.querySelectorAll('#act-chips .chip').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); render(); }

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function fetchAll(){
  if(fetchBusy) return;
  if(!serverOk){ checkServer(); return; }
  fetchBusy=true;
  const btn=document.getElementById('fetch-btn');
  btn.disabled=true; btn.innerHTML=\`<i class="ti ti-refresh spin"></i> Fetching…\`;
  const pw=document.getElementById('prog-wrap'); pw.style.display='block';
  clearSteps(); setProgress(0,'Connecting to local server…');

  try{
    addStep('load','Fetching all RSS feeds via local server…');
    setProgress(10,'Downloading feeds…');
    const res = await fetch(\`\${SERVER}/api/feeds\`);
    if(!res.ok) throw new Error('Server returned '+res.status);
    const feeds = await res.json();
    setProgress(40,'Parsing articles…');
    updateLastStep('done',\`Got \${feeds.length} feed responses\`);

    let totalAdded=0;
    const enabled = new Set(SOURCES.filter(s=>s.enabled).map(s=>s.id));

    for(let i=0;i<feeds.length;i++){
      const feed=feeds[i];
      if(!enabled.has(feed.id)) continue;
      const srcObj=SOURCES.find(s=>s.id===feed.id);
      addStep(feed.error?'fail':'load', \`Parsing \${feed.name}… (HTTP \${feed.status})\`);

      if(!feed.xml || feed.status < 200 || feed.status >= 300){
        updateLastStep('fail', \`\${feed.name} — \${feed.error||'HTTP '+feed.status}\`);
        continue;
      }

      const items = parseXML(feed.xml, feed.id);
      let srcAdded=0;
      for(const item of items.slice(0,30)){
        const full = item.title+' '+item.desc;
        // parseRecos returns array — one article can yield multiple stock calls
        const parsed = parseRecos(full, item.title, item.desc, item.ts, feed);
        for(const p of parsed){
          const dup=recos.find(x=>x.ticker===p.ticker&&x.source===feed.id&&Math.abs(x.ts-item.ts)<12*3600000);
          if(!dup){ recos.unshift({...p,id:nextId++,source:feed.id,sourceName:feed.name,link:item.link,auto:true}); srcAdded++; totalAdded++; }
        }
      }
      updateLastStep(srcAdded>0?'done':'info',
        \`\${feed.name} — \${items.length} articles → \${srcAdded} call\${srcAdded!==1?'s':''}\`);
      setProgress(40+Math.round((i+1)/feeds.length*55), \`\${i+1}/\${feeds.length} feeds parsed\`);
    }

    setProgress(100, totalAdded>0
      ? \`✓ Done — \${totalAdded} new call\${totalAdded!==1?'s':''} added\`
      : 'Done — 0 calls detected. Try "All Time" filter.');
    document.getElementById('last-upd').innerHTML=
      \`<i class="ti ti-clock" style="font-size:12px"></i> \${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})} IST\`;
    setTimeout(()=>{ pw.style.display='none'; },4000);
    render();
  }catch(e){
    updateLastStep('fail','Error: '+e.message);
    setProgress(100,'Failed — is server.js running?');
    serverOk=false;
    document.getElementById('srv-pill').className='status-pill error';
    document.getElementById('srv-txt').textContent='Server not running';
    document.getElementById('srv-warn').style.display='block';
  }
  fetchBusy=false;
  btn.disabled=false; btn.innerHTML=\`<i class="ti ti-antenna-bars-5"></i>Auto Fetch Now\`;
}

// ── XML PARSER ────────────────────────────────────────────────────────────────
function parseXML(xmlText, srcId){
  try{
    const parser=new DOMParser();
    const doc=parser.parseFromString(xmlText,'text/xml');
    const items=Array.from(doc.querySelectorAll('item'));
    return items.map(item=>{
      const g = s => item.querySelector(s)?.textContent?.trim()||'';
      const title = g('title');
      const raw   = g('description')||g('content')||g('summary');
      const desc  = stripHtml(raw);
      const pubDate = g('pubDate')||g('published')||g('updated');
      const link  = g('link')||g('guid');
      const ts    = pubDate ? new Date(pubDate).getTime() : Date.now();
      return { title, desc, ts: isNaN(ts)?Date.now():ts, link };
    });
  }catch(e){ return []; }
}

// ── RECOMMENDATION PARSER ─────────────────────────────────────────────────────

// Blacklist — words that look like tickers but aren't
const NOT_TICKERS = new Set([
  'BUY','SELL','THE','AND','FOR','WITH','STOP','LOSS','TARGET','PRICE',
  'NEAR','ABOVE','BELOW','CASH','ALSO','READ','THIS','THAT','FROM','HAVE',
  'BEEN','WILL','ONLY','INTO','OVER','SOME','EACH','BOTH','THEY','WERE',
  'SAID','SAYS','SUCH','THEN','THAN','WHEN','YOUR','THEIR','ABOUT','AFTER',
  'WHICH','WHILE','WHERE','WOULD','COULD','SHOULD','STOCKS','SHARES','STOCK',
  'MARKET','NIFTY','SENSEX','INDEX','TODAY','WEEK','MONTH','YEAR','NEXT',
  'LAST','HIGH','LOWS','RISE','FALL','GAIN','LOSS','PROFIT','BOOK','CALL',
  'PICK','VIEW','RATE','FUND','BANK','DATA','NEWS','LIVE','GOLD','CRUDE',
  'RUPEE','DOLLAR','INDIA','GLOBAL','TRADE','UNDER','SHORT','LONG','TERM',
  'FRESH','RALLY','TREND','LEVEL','RANGE','ZONE','BAND','ZONE','MOVE',
  'HOLD','EXIT','AVOID','WATCH','TRACK','NOTE','TIPS','IDEA','IDEAS',
  'SUGARS','ENERGY','MOTORS','PHARMA','TECH','INFRA','REALTY','METALS',
  'SUGAR','CEMENT','STEEL','POWER','MEDIA','FOODS','FIBER','CHEM','LABS',
  'CORP','INDS','READ','CLICK','HERE','MORE','ALSO','LIKE','JUST','EVEN',
  'WERE','DAYS','WEEK','GETS','HITS','SETS','SEES','CUTS','WINS','ADDS',
]);

// Extract ONLY the specific recommendation line/sentence for a stock
function extractQuoteForStock(ticker, cname, fullText) {
  const lines = fullText.split(/
|(?<=\\.)\\s+(?=[A-Z])/);
  
  // Priority 1: Find line with exact ticker + buy/sell + price
  // e.g. "Buy DABUR in Cash @467 SL @ 444 TGT @ 505"
  for (const line of lines) {
    const l = line.trim();
    if (l.length < 10) continue;
    const hasStock = new RegExp('\\\\b(' + ticker + '|' + cname.split(' ')[0] + ')\\\\b', 'i').test(l);
    const hasAction = /\\b(buy|sell|accumulate|exit|reduce|target|sl|tgt|stop.?loss)\\b/i.test(l);
    const hasPrice = /[@₹]\\s*[\\d]|Rs\\.?\\s*[\\d]|\\d+\\s*(?:tgt|sl|target)/i.test(l);
    if (hasStock && hasAction && hasPrice) return l.trim();
  }
  
  // Priority 2: Line with stock name + action (no price required)
  for (const line of lines) {
    const l = line.trim();
    if (l.length < 10 || l.length > 300) continue;
    const hasStock = new RegExp('\\\\b(' + ticker + '|' + cname.split(' ')[0] + ')\\\\b', 'i').test(l);
    const hasAction = /\\b(buy|sell|accumulate|exit|reduce|bullish|bearish|target|stop.?loss)\\b/i.test(l);
    if (hasStock && hasAction) return l.trim();
  }

  // Priority 3: Numbered rec line "1] Stock : Buy near ₹24, Target ₹27, SL ₹22"
  const numRe = new RegExp('\\\\d+[\\\\].)\\\\s]+' + cname.split(' ')[0] + '[^.]{0,200}', 'i');
  const numM = fullText.match(numRe);
  if (numM) return numM[0].trim().substring(0, 200);

  return null; // no clean quote found
}

// Extract ALL stock recommendations from an article — returns array
function parseRecos(full, title, desc, ts, src) {
  const results = [];
  const seen = new Set();

  // Split into candidate sentences/lines
  const lines = full
    .replace(/\\r/g, '')
    .split(/\\n+/)
    .flatMap(l => l.split(/(?<=\\.\\s)(?=[A-Z])/))
    .map(l => l.trim())
    .filter(l => l.length > 10);

  for (const line of lines) {
    // Must have an action signal
    const isBuy  = /\\b(buy|accumulate|add|bullish|go long|initiate buy|upgrade.*buy|strong buy)\\b/i.test(line);
    const isSell = /\\b(sell|exit|reduce|bearish|short|initiate sell|downgrade.*sell|book profit)\\b/i.test(line);
    if (!isBuy && !isSell) continue;

    // Must have a price signal
    const hasPrice = /[@₹]\\s*[\\d]|Rs\\.?\\s*[\\d]|\\btarget\\b|\\bsl\\b|\\btgt\\b|stop.?loss/i.test(line);
    if (!hasPrice) continue;

    // Must mention a known ticker or company
    let ticker = null, cname = null;
    for (const [re, sym, cn] of TICKER_MAP) {
      if (re.test(line)) { ticker = sym; cname = cn; break; }
    }

    // Fallback: "Buy XXXX in Cash" — XXXX is the ticker
    if (!ticker) {
      const m = line.match(/\\b(?:buy|sell)\\s+([A-Z]{3,12})\\s+(?:in\\s+cash|futures?|@|at)/i);
      if (m && !NOT_TICKERS.has(m[1].toUpperCase())) {
        ticker = m[1].toUpperCase();
        cname  = ticker;
      }
    }

    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);

    const action = isBuy ? 'BUY' : 'SELL';

    // Extract the cleanest possible quote — just the rec sentence
    const quote = extractQuoteForStock(ticker, cname, full) || line.trim();

    // Extract prices from the quote line
    const clean = quote.replace(/Rs\\.?\\s*/gi,'₹');
    
    const inlineM = clean.match(/buy\\s+\\w+\\s+(?:in\\s+cash\\s+)?@\\s*([\\d.]+)\\s+sl\\s*@\\s*([\\d.]+)\\s+tgt\\s*@\\s*([\\d.]+)/i);
    let entry  = inlineM ? parseFloat(inlineM[1]) : null;
    let sl     = inlineM ? parseFloat(inlineM[2]) : null;
    let target = inlineM ? parseFloat(inlineM[3]) : null;

    if (!entry || !target || !sl) {
      const getNum = (patterns, text) => {
        for (const re of patterns) {
          const m = text.match(re);
          if (m) { const v = parseFloat((m[1]||'').replace(/,/g,'')); if (v>1&&v<2000000) return v; }
        }
        return null;
      };
      if (!target) target = getNum([/tgt\\s*[@:]?\\s*(?:₹)?\\s*([\\d,]+)/i, /target\\s*(?:price|of|at|:)?\\s*(?:₹)?\\s*([\\d,]+)/i, /(?:₹)\\s*([\\d,]+)\\s*(?:as\\s+)?target/i, /Target\\s+(?:₹)?([\\d,]+)/i], clean);
      if (!sl)     sl     = getNum([/sl\\s*[@:]?\\s*(?:₹)?\\s*([\\d,]+)/i, /stop.?loss\\s*(?:at|of|:)?\\s*(?:₹)?\\s*([\\d,]+)/i, /Stop\\s+Loss\\s+(?:₹)?([\\d,]+)/i], clean);
      if (!entry)  entry  = getNum([/buy\\s+(?:\\w+\\s+)?(?:in\\s+cash\\s+)?@\\s*([\\d,]+)/i, /buy\\s*(?:near|at|@|around)?\\s*(?:₹)?\\s*([\\d,]+)/i, /buy\\s+only\\s+above\\s+(?:₹)?([\\d,]+)/i], clean);
      // @ signs in order: entry, sl, target
      if (!entry||!sl||!target) {
        const ats=[]; const atRe=/@\\s*([\\d,]+(?:\\.[\\d]+)?)/g; let atm;
        while((atm=atRe.exec(clean))!==null){ const v=parseFloat(atm[1].replace(/,/g,'')); if(v>1&&v<2000000) ats.push(v); }
        if(ats.length>=3){if(!entry)entry=ats[0];if(!sl)sl=ats[1];if(!target)target=ats[2];}
        else if(ats.length===2){if(!entry)entry=ats[0];if(!target)target=ats[1];}
        else if(ats.length===1){if(!entry)entry=ats[0];}
      }
    }

    // Anchor from full article
    let anchor = 'Market Desk';
    const fl = full.toLowerCase();
    for (const name of KNOWN_ANCHORS) {
      if (fl.includes(name.toLowerCase())) { anchor = name; break; }
    }

    results.push({
      ticker, cname, action,
      entry: entry||null, sl: sl||null, target: target||null,
      anchor,
      rawText: quote.substring(0, 300), // ONLY the specific rec sentence
      snippet: title || quote.substring(0, 120),
      ts
    });
  }

  // If line-based found nothing, try full text with known tickers only
  if (results.length === 0) {
    for (const [re, sym, cn] of TICKER_MAP) {
      if (!re.test(full)) continue;
      if (seen.has(sym)) continue;
      const isBuy  = /\\b(buy|accumulate|bullish|target)\\b/i.test(full);
      const isSell = /\\b(sell|bearish|exit|reduce)\\b/i.test(full);
      if (!isBuy && !isSell) continue;
      const quote = extractQuoteForStock(sym, cn, full);
      if (!quote) continue;
      seen.add(sym);
      results.push({ ticker:sym, cname:cn, action:isBuy?'BUY':'SELL', entry:null, sl:null, target:null, anchor:'Market Desk', rawText:quote, snippet:title||quote.substring(0,120), ts });
      if (results.length >= 5) break;
    }
  }

  return results;
}

// Legacy wrapper
function parseReco(full, title, desc, ts, src) {
  const arr = parseRecos(full, title, desc, ts, src);
  return arr.length > 0 ? arr[0] : null;
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function filtered(){
  const cut=Date.now()-timeH*3600000;
  const en=new Set(SOURCES.filter(s=>s.enabled).map(s=>s.id));
  return recos.filter(r=>r.ts>=cut&&en.has(r.source)&&(actFilter==='All'||r.action===actFilter));
}
function rrCalc(r){
  if(!r.entry||!r.sl||!r.target) return null;
  const risk=r.action==='BUY'?Math.abs(r.entry-r.sl):Math.abs(r.sl-r.entry);
  const reward=r.action==='BUY'?Math.abs(r.target-r.entry):Math.abs(r.entry-r.target);
  return{risk,reward,ratio:risk>0?(reward/risk).toFixed(1):'—'};
}
function ta(ts){ const d=Date.now()-ts,m=Math.floor(d/60000); if(m<60)return m+'m ago'; const h=Math.floor(d/3600000); if(h<24)return h+'h ago'; return Math.floor(h/24)+'d ago'; }
function fmtP(v){ return v!=null?'₹'+Number(v).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:2}):null; }
function srcInfo(id){ return SOURCES.find(s=>s.id===id)||{color:'#888',initials:'?'}; }

function render(){
  const arts=filtered();
  document.getElementById('cnt').textContent=arts.length+' call'+(arts.length!==1?'s':'');
  const g=document.getElementById('grid');
  if(!arts.length){
    g.innerHTML=\`<div class="empty-state"><i class="ti ti-speakerphone"></i>
      <p>No recommendations yet.<br><br>
      \${serverOk
        ? 'Click <strong>Auto Fetch Now</strong> to pull live calls from Indian news sources.'
        : 'Start the local server first: open Terminal, run <strong>node server.js</strong>, then open <strong>http://localhost:3000</strong>'
      }</p>
      <button class="fetch-btn" onclick="fetchAll()"><i class="ti ti-antenna-bars-5"></i>Auto Fetch Now</button></div>\`;
    return;
  }
  // Group by source for section headers
  const bySource = {};
  arts.forEach(r => {
    const key = r.sourceName || r.source;
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(r);
  });

  let tableHTML = '';
  Object.entries(bySource).forEach(([srcName, rows]) => {
    const c = srcInfo(rows[0].source);
    tableHTML += \`<div class="table-wrap">
      <div class="section-label">
        <span style="background:\${c.color}20;color:\${c.color};border:1px solid \${c.color}40;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700">\${c.initials}</span>
        \${srcName}
        <span style="margin-left:auto;font-weight:400;font-size:10px">\${rows.length} call\${rows.length!==1?'s':''}</span>
      </div>
      <div class="table-header">
        <div>Stock</div><div>Call</div><div>Entry/CMP</div><div>Target</div><div>Stop Loss</div><div>Notes</div>
      </div>\`;
    rows.forEach(r => {
      const ep = r.entry  ? '₹'+Number(r.entry).toLocaleString('en-IN')  : null;
      const tp = r.target ? '₹'+Number(r.target).toLocaleString('en-IN') : null;
      const sp = r.sl     ? '₹'+Number(r.sl).toLocaleString('en-IN')     : null;
      tableHTML += \`<div class="table-row" onclick="void(0)">
        <div class="t-stock">
          <div class="t-ticker">\${r.ticker}</div>
          <div class="t-cname">\${r.cname}</div>
          <div class="t-src" style="margin-top:4px">
            <span class="t-src-time">\${ta(r.ts)}</span>
            \${r.link?\`<a href="\${r.link}" target="_blank" rel="noopener" style="color:var(--acc);font-size:10px;text-decoration:none">↗</a>\`:''}
          </div>
        </div>
        <div><span class="t-badge \${r.action.toLowerCase()}">\${r.action}</span></div>
        <div class="t-price">\${ep||'<span class="t-price na">—</span>'}</div>
        <div class="t-price target">\${tp||'<span class="t-price na">—</span>'}</div>
        <div class="t-price sl">\${sp||'<span class="t-price na">—</span>'}</div>
        <div>
          <div class="t-note">\${(r.rawText||r.snippet||'').substring(0,120)}\${(r.rawText||r.snippet||'').length>120?'…':''}</div>
          <div class="t-src" style="margin-top:4px">
            <span class="t-src-anchor">🎙 \${r.anchor}</span>
          </div>
        </div>
        <button class="t-del" onclick="event.stopPropagation();del(\${r.id})" title="Remove">×</button>
      </div>\`;
    });
    tableHTML += '</div>';
  });

  g.innerHTML = tableHTML;
}

function del(id){ if(confirm('Remove?')){ recos=recos.filter(r=>r.id!==id); render(); } }

// ── PROGRESS ──────────────────────────────────────────────────────────────────
function setProgress(pct,label){ document.getElementById('prog-fill').style.width=pct+'%'; document.getElementById('prog-text').textContent=label; document.getElementById('prog-pct').textContent=pct+'%'; }
function clearSteps(){ document.getElementById('prog-steps').innerHTML=''; }
function addStep(type,text){
  const icons={done:'ti-check',fail:'ti-x',load:'ti-refresh spin',info:'ti-info-circle'};
  const el=document.createElement('div'); el.className=\`pstep \${type}\`; el.id='slast';
  el.innerHTML=\`<i class="ti \${icons[type]||'ti-circle'}" style="flex-shrink:0;margin-top:1px"></i><span>\${text}</span>\`;
  document.getElementById('prog-steps').appendChild(el);
}
function updateLastStep(type,text){
  const el=document.getElementById('slast'); if(!el){addStep(type,text);return;}
  const icons={done:'ti-check',fail:'ti-x',load:'ti-refresh spin',info:'ti-info-circle'};
  el.className=\`pstep \${type}\`; el.id='';
  el.innerHTML=\`<i class="ti \${icons[type]}" style="flex-shrink:0;margin-top:1px"></i><span>\${text}</span>\`;
}
function stripHtml(h){ return h.replace(/<!\\[CDATA\\[/gi,'').replace(/\\]\\]>/g,'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#\\d+;/g,' ').replace(/\\s+/g,' ').trim(); }

// ── MANUAL ADD ────────────────────────────────────────────────────────────────
function openModal(){
  const bg=document.createElement('div'); bg.className='modal-bg'; bg.id='mbg';
  bg.onclick=e=>{if(e.target===bg)closeModal();};
  bg.innerHTML=\`<div class="modal">
    <div class="modal-title">Add Manual Call <button onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="fgrid-2">
      <div class="frow"><label>NSE Ticker *</label><input id="f-ticker" placeholder="RELIANCE" oninput="this.value=this.value.toUpperCase()"></div>
      <div class="frow"><label>Company Name</label><input id="f-cname" placeholder="Reliance Industries"></div>
    </div>
    <div class="frow"><label>Action *</label><select id="f-action"><option>BUY</option><option>SELL</option><option>WATCH</option></select></div>
    <div class="fgrid-3">
      <div class="frow"><label>Entry ₹</label><input id="f-entry" type="number" placeholder="0" min="0"></div>
      <div class="frow"><label>Stop Loss ₹</label><input id="f-sl" type="number" placeholder="0" min="0"></div>
      <div class="frow"><label>Target ₹</label><input id="f-tgt" type="number" placeholder="0" min="0"></div>
    </div>
    <div class="frow"><label>Channel *</label><select id="f-channel">\${SOURCES.map(s=>\`<option value="\${s.id}">\${s.name}</option>\`).join('')}<option value="other">Other</option></select></div>
    <div class="frow"><label>Analyst / Anchor *</label><input id="f-anchor" placeholder="e.g. Anil Singhvi"></div>
    <div class="ferr" id="ferr">Please fill Ticker and Anchor name.</div>
    <button class="save-btn" onclick="saveReco()"><i class="ti ti-check" style="font-size:13px;vertical-align:-1px;margin-right:4px"></i>Add Recommendation</button>
  </div>\`;
  document.body.appendChild(bg);
  document.getElementById('f-ticker').focus();
}
function closeModal(){ const m=document.getElementById('mbg'); if(m) m.remove(); }
function saveReco(){
  const ticker=(document.getElementById('f-ticker').value||'').trim().toUpperCase();
  const anchor=(document.getElementById('f-anchor').value||'').trim();
  if(!ticker||!anchor){ document.getElementById('ferr').style.display='block'; return; }
  const sid=document.getElementById('f-channel').value;
  const so=SOURCES.find(s=>s.id===sid);
  recos.unshift({id:nextId++,ticker,cname:(document.getElementById('f-cname').value||ticker).trim(),
    action:document.getElementById('f-action').value,
    entry:parseFloat(document.getElementById('f-entry').value)||null,
    sl:parseFloat(document.getElementById('f-sl').value)||null,
    target:parseFloat(document.getElementById('f-tgt').value)||null,
    source:sid,sourceName:so?so.name:'Other',anchor,ts:Date.now(),snippet:'',auto:false,link:''});
  closeModal(); render();
}

init();
</script>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (parsed.pathname === '/api/feeds') {
    try {
      const data = await getAllFeeds();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nStockPulse India running → http://localhost:' + PORT + '\n');
});
