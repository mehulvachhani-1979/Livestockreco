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
  --bg:#f0f2f5;--card:#fff;--card2:#f8f9fb;
  --border:rgba(0,0,0,0.08);--border2:rgba(0,0,0,0.14);
  --txt:#1a1a2e;--muted:#6b7280;--hint:#9ca3af;
  --green:#10b981;--red:#e24b4a;--amber:#d97706;
  --acc:#1D9E75;--font:system-ui,-apple-system,'Segoe UI',sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--txt);font-size:14px;min-height:100vh}
.header{background:var(--card);border-bottom:1px solid var(--border2);padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;box-shadow:0 1px 8px rgba(0,0,0,.06)}
.logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;letter-spacing:-.3px}
.logo-dot{width:9px;height:9px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 3px rgba(29,158,117,.2)}
.logo span{color:var(--acc)}
.hdr-right{display:flex;align-items:center;gap:10px}
.free-pill{font-size:10px;font-weight:700;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:20px;padding:3px 10px}
.status-pill{display:flex;align-items:center;gap:5px;font-size:11px;border-radius:20px;padding:3px 10px;font-weight:600;transition:all .3s}
.status-pill.ok{color:var(--acc);background:#e8f5f0;border:1px solid #9FE1CB}
.status-pill.error{color:#991b1b;background:#fee2e2;border:1px solid #fca5a5}
.status-pill.checking{color:var(--amber);background:#fef3c7;border:1px solid #fcd34d}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:blink 1.2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.last-upd{font-size:11px;color:var(--hint);display:flex;align-items:center;gap:4px}
.layout{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 56px)}
.sidebar{background:var(--card);border-right:1px solid var(--border2);padding:14px;position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto}
.slabel{font-size:10px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 7px}
.slabel:first-of-type{margin-top:0}
.tbtn{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--muted);font-size:12px;cursor:pointer;font-family:var(--font);transition:all .15s;text-align:left;margin-bottom:3px}
.tbtn:hover{background:var(--card2);color:var(--txt)}
.tbtn.active{background:#e8f5f0;color:#0f6e56;border-color:#9FE1CB}
.tbtn i{font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px}
.chip{padding:3px 9px;border-radius:20px;font-size:11px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;font-family:var(--font);transition:all .15s}
.chip:hover{color:var(--txt)}
.chip.active{background:#dbeafe;color:#1e40af;border-color:#93c5fd}
.src-toggle{display:flex;align-items:center;justify-content:space-between;padding:6px 4px;border-radius:7px;cursor:pointer;transition:background .15s;margin-bottom:2px}
.src-toggle:hover{background:var(--card2)}
.src-name{font-size:12px;color:var(--txt);display:flex;align-items:center;gap:7px}
.src-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.tog{width:30px;height:17px;border-radius:9px;border:1px solid var(--border2);background:var(--card2);position:relative;transition:background .2s;cursor:pointer;flex-shrink:0}
.tog.on{background:#d1fae5;border-color:#6ee7b7}
.knob{position:absolute;width:11px;height:11px;border-radius:50%;background:var(--hint);top:2px;left:2px;transition:all .2s}
.tog.on .knob{left:15px;background:var(--green)}
.main{padding:16px;overflow-y:auto}
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.page-title{font-size:15px;font-weight:700;letter-spacing:-.3px}
.top-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cnt-badge{font-size:11px;color:var(--muted);background:var(--card);padding:3px 10px;border-radius:20px;border:1px solid var(--border)}
.fetch-btn{display:flex;align-items:center;gap:6px;padding:8px 14px;background:#e8f5f0;border:1px solid #9FE1CB;border-radius:8px;color:#0f6e56;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}
.fetch-btn:hover{background:#d1ede4}
.fetch-btn:disabled{opacity:.5;cursor:not-allowed}
.add-btn{display:flex;align-items:center;gap:5px;padding:8px 12px;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;color:#1e40af;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}
.add-btn:hover{background:#dbeafe}
/* SERVER STATUS BOX */
.server-warn{background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:14px 16px;margin-bottom:14px;display:none}
.server-warn h3{font-size:13px;font-weight:600;color:var(--amber);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.server-warn p{font-size:12px;color:var(--muted);line-height:1.7;margin-bottom:8px}
.server-warn code{background:#fef3c7;padding:2px 7px;border-radius:4px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#92400e;display:inline-block;margin:2px 0}
/* PROGRESS */
.prog-wrap{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:14px;display:none}
.prog-label{font-size:11px;color:var(--muted);margin-bottom:7px;display:flex;justify-content:space-between}
.prog-bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.prog-fill{height:100%;background:var(--acc);border-radius:2px;transition:width .4s ease;width:0%}
.prog-steps{margin-top:10px;display:flex;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto}
.pstep{font-size:11px;display:flex;align-items:flex-start;gap:6px;padding:2px 0}
.pstep.done{color:#166534}.pstep.done i{color:var(--green)}
.pstep.fail{color:#991b1b}.pstep.fail i{color:var(--red)}
.pstep.load{color:var(--muted)}.pstep.load i{color:var(--amber)}
.pstep.info{color:var(--muted)}.pstep.info i{color:var(--acc)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{animation:spin .7s linear infinite;display:inline-block}
/* GRID */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:12px}
.rcard{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:15px;display:flex;flex-direction:column;gap:9px;transition:all .2s;border-top:3px solid transparent;animation:cardin .22s ease}
@keyframes cardin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.rcard.buy{border-top-color:var(--green)}
.rcard.sell{border-top-color:var(--red)}
.rcard.watch{border-top-color:var(--amber)}
.rcard:hover{border-color:var(--border2);box-shadow:0 2px 14px rgba(0,0,0,.07)}
.rcard-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.ticker-big{font-family:'SF Mono',Consolas,monospace;font-size:19px;font-weight:700;line-height:1}
.cname{font-size:11px;color:var(--muted);margin-top:3px}
.right-top{display:flex;align-items:center;gap:6px}
.action-badge{font-size:11px;font-weight:700;padding:4px 11px;border-radius:20px;letter-spacing:.4px}
.action-badge.buy{background:#dcfce7;color:#166534}
.action-badge.sell{background:#fee2e2;color:#991b1b}
.action-badge.watch{background:#fef3c7;color:#92400e}
.del-btn{width:22px;height:22px;border-radius:50%;background:transparent;border:none;color:var(--hint);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;transition:all .15s}
.del-btn:hover{background:#fee2e2;color:#991b1b}
.price-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.pbox{background:var(--card2);border-radius:8px;padding:8px;text-align:center;border:1px solid var(--border)}
.pbox-label{font-size:9px;color:var(--hint);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;font-weight:600}
.pbox-val{font-size:13px;font-weight:700;font-family:'SF Mono',Consolas,monospace}
.pbox-val.entry{color:var(--txt)}.pbox-val.sl{color:var(--red)}.pbox-val.tgt{color:var(--green)}
.pbox-na{font-size:10px;color:var(--hint);font-style:italic;font-weight:400;font-family:var(--font)}
.rr-row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)}
.rr-bar{flex:1;height:5px;background:var(--card2);border-radius:3px;overflow:hidden;display:flex}
.rr-loss{height:100%;background:var(--red);opacity:.7}
.rr-gain{height:100%;background:var(--green);opacity:.8}
.rr-val{font-size:11px;font-weight:700;color:var(--txt);font-family:'SF Mono',Consolas,monospace;min-width:40px;text-align:right}
.snippet{font-size:11px;color:var(--muted);line-height:1.6;background:var(--card2);border-radius:7px;padding:8px 10px;border-left:3px solid var(--border2)}
.src-footer{display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)}
.src-logo{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;border:1px solid transparent}
.src-info{flex:1;min-width:0}
.src-channel{font-size:11px;font-weight:600;color:var(--txt)}
.src-anchor{font-size:10px;color:var(--muted);display:flex;align-items:center;gap:3px}
.src-time{font-size:10px;color:var(--hint);flex-shrink:0;display:flex;align-items:center;gap:3px}
.auto-tag{font-size:9px;font-weight:600;background:#e0f2fe;color:#0369a1;border-radius:4px;padding:1px 6px;border:1px solid #bae6fd;letter-spacing:.3px;flex-shrink:0}
.read-link{font-size:10px;color:var(--acc);text-decoration:none;display:flex;align-items:center;gap:3px;flex-shrink:0}
.read-link:hover{text-decoration:underline}
.empty-state{text-align:center;padding:3rem 1rem;color:var(--muted);grid-column:1/-1}
.empty-state i{font-size:36px;display:block;margin-bottom:10px;opacity:.2}
.empty-state p{font-size:13px;line-height:1.8;max-width:380px;margin:0 auto}
.empty-state .fetch-btn{display:inline-flex;margin-top:14px}
/* MODAL */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(2px)}
.modal{background:var(--card);border:1px solid var(--border2);border-radius:14px;padding:22px;width:400px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.15)}
.modal-title{font-size:15px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.modal-title button{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0}
.frow{margin-bottom:11px}
.frow label{display:block;font-size:10px;font-weight:600;color:var(--muted);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px}
.frow input,.frow select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border2);background:var(--card2);color:var(--txt);font-size:13px;font-family:var(--font);outline:none;transition:border-color .15s}
.frow input:focus,.frow select:focus{border-color:#9FE1CB}
.fgrid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px}
.fgrid-2{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.save-btn{width:100%;padding:10px;background:#e8f5f0;border:1px solid #9FE1CB;border-radius:8px;color:#0f6e56;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);margin-top:6px;transition:all .15s}
.save-btn:hover{background:#d1ede4}
.ferr{font-size:11px;color:var(--red);margin-top:6px;display:none}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:10px}
@media(max-width:680px){.layout{grid-template-columns:1fr}.sidebar{height:auto;position:static;border-right:none;border-bottom:1px solid var(--border)}}
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
// ── SOURCES (must match server.js) ────────────────────────────────────────────
const SOURCES = [
  { id:'mc',   name:'MoneyControl',      color:'#e65c00', initials:'MC', enabled:true },
  { id:'et',   name:'ET Markets',         color:'#ff6600', initials:'ET', enabled:true },
  { id:'zee',  name:'Zee Business',       color:'#7b2fff', initials:'ZB', enabled:true },
  { id:'bs',   name:'Business Standard',  color:'#cc0000', initials:'BS', enabled:true },
  { id:'lm',   name:'LiveMint',           color:'#0080ff', initials:'LM', enabled:true },
  { id:'ndtv', name:'NDTV Profit',        color:'#e00000', initials:'NP', enabled:true },
  { id:'mc2',  name:'MC Technicals',      color:'#e65c00', initials:'M2', enabled:true },
  { id:'et2',  name:'ET Stocks',          color:'#ff6600', initials:'E2', enabled:true },
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
  const pill=document.getElementById('srv-pill');
  const txt=document.getElementById('srv-txt');
  const warn=document.getElementById('srv-warn');
  try{
    const r = await fetch(\`\${SERVER}/api/feeds\`, {method:'GET', signal: (() => { const c=new AbortController(); setTimeout(()=>c.abort(),3000); return c.signal; })()});
    if(r.ok){
      serverOk=true;
      pill.className='status-pill ok'; txt.textContent='Server connected';
      warn.style.display='none';
      // Auto-fetch on load if server is running
      fetchAll();
      return;
    }
  }catch(e){}
  serverOk=false;
  pill.className='status-pill error'; txt.textContent='Server not running';
  warn.style.display='block';
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

// ── RECOMMENDATION PARSER — multi-stock, full extraction ─────────────────────

// Returns ARRAY of reco objects (one article can have 2-3 stocks)
function parseRecos(full, title, desc, ts, src) {
  const results = [];

  // ── Step 1: Split article into per-stock segments ──────────────────────────
  // Articles often say "Buy A with target X, SL Y; Buy B with target P, SL Q"
  // Split on sentence boundaries or semicolons or stock transitions
  const segments = splitIntoSegments(full);

  // ── Step 2: Extract from each segment ──────────────────────────────────────
  for (const seg of segments) {
    const rec = extractOneReco(seg, title, ts, src);
    if (rec) {
      // Avoid duplicate tickers in same article
      if (!results.find(r => r.ticker === rec.ticker)) {
        results.push(rec);
      }
    }
  }

  // If segmented extraction got nothing, try whole article
  if (results.length === 0) {
    const rec = extractOneReco(full, title, ts, src);
    if (rec) results.push(rec);
  }

  return results;
}

function splitIntoSegments(text) {
  const segs = [];

  // Strategy 1: PRIMARY — split on "Buy TICKER in Cash @..." pattern (LiveMint exact format)
  // Each line like "Buy DABUR in Cash @467 SL @ 444 TGT @ 505" becomes its own segment
  const buyAtParts = text.split(/(?=\\bBuy\\s+[A-Z]+\\s+(?:in\\s+Cash\\s+)?@)/i);
  segs.push(...buyAtParts);

  // Strategy 2: Split on stock heading lines — "Dabur\\nBuy DABUR..."  or "Sun Pharma\\nBuy..."
  const headingParts = text.split(/(?=\\n[A-Z][a-zA-Z\\s]{3,25}\\n(?:Buy|Sell))/);
  segs.push(...headingParts);

  // Strategy 3: Split on numbered stock patterns
  const numbered = text.split(/(?=\\b\\d+[.)\\s]+(?:[A-Z][a-z]+|buy|sell))|(?=(?:first|second|third|fourth|fifth)\\s+(?:stock|pick|recommendation)\\s*:)/i);
  segs.push(...numbered);

  // Strategy 4: Split on "Stock Name: Buy at..."
  const colonPattern = text.split(/(?=\\b[A-Z][A-Za-z\\s]{2,20}:\\s*(?:buy|sell|accumulate|target))/i);
  segs.push(...colonPattern);

  // Strategy 5: Split after TGT line ends (signals end of one stock rec)
  const tgtSplit = text.split(/(?<=TGT\\s*@\\s*[\\d.]+)\\s*/i);
  segs.push(...tgtSplit);

  // Strategy 6: Semicolon and pipe
  segs.push(...text.split(/;\\s*/));
  segs.push(...text.split(/\\s*[|]\\s*/));

  // Always include full text
  segs.unshift(text);

  return [...new Set(segs)].map(s => s.trim()).filter(s => s.length > 15);
}

function extractOneReco(text, title, ts, src) {
  const t = text.toLowerCase();

  // ── Action detection ────────────────────────────────────────────────────────
  const isBuy  = /\\b(buy|buying|accumulate|add|bullish|long|go long|initiat(e|es|ing) buy|upgrade.*buy|maintain.*buy|strong buy|top pick|best buy|recommended buy|trading buy|invest)\\b/.test(text);
  const isSell = /\\b(sell|selling|short|exit|reduce|bearish|avoid|downgrade.*sell|initiat(e|es|ing) sell|book profit|book loss)\\b/.test(text);
  const isWatch= /\\b(watch|watchlist|neutral|hold|tracking|monitor|top pick|hot stock|trade setup|trading idea|stock idea|analyst pick)\\b/.test(text);

  if (!isBuy && !isSell && !isWatch) return null;
  const action = isBuy ? 'BUY' : isSell ? 'SELL' : 'WATCH';

  // ── Ticker extraction ───────────────────────────────────────────────────────
  let ticker = null, cname = null;

  // 1. Try known ticker map
  for (const [re, sym, cn] of TICKER_MAP) {
    if (re.test(text)) { ticker = sym; cname = cn; break; }
  }

  // 2. Pattern: "Buy XYZ" / "Sell XYZ" / "XYZ: Buy"
  if (!ticker) {
    const patterns = [
      /\\b(?:buy|sell|accumulate|add)\\s+([A-Z][A-Za-z&]{2,15})\\b/,
      /\\b([A-Z][A-Za-z&]{2,15})\\s*[:|]\\s*(?:buy|sell|target)/i,
      /\\b([A-Z][A-Za-z&]{2,15})\\s+(?:shares?|stock|scrip|futures?)\\b/i,
      /\\b([A-Z]{3,10})\\s+(?:at|@|around|near)\\s*(?:₹|rs\\.?)?\\s*[\\d,]+/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1] && m[1].length >= 3 && !/^(buy|sell|the|and|for|with|stop|loss|target|price|near|above|below)$/i.test(m[1])) {
        ticker = m[1].toUpperCase();
        cname  = m[1];
        break;
      }
    }
  }

  if (!ticker) return null;

  // ── Price extraction ─────────────────────────────────────────────────────────
  // Clean text: remove HTML, normalise ₹ and Rs
  const clean = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/Rs\\.?\\s*/gi, '₹')
    .replace(/INR\\s*/gi,   '₹')
    .replace(/rupees?\\s*/gi,'₹');

  // Helper: extract number after a keyword
  function extractAfter(patterns, str) {
    for (const re of patterns) {
      const m = str.match(re);
      if (m) {
        // grab first capture group that is a number
        const raw = m[1] || m[2] || m[3] || '0';
        const v = parseFloat(raw.replace(/,/g, ''));
        if (v > 1 && v < 2000000) return v;
      }
    }
    return null;
  }

  // Price prefix pattern handles both ₹ and Rs. and Rs
  const P = '(?:₹|Rs\\\\.?\\\\s*)';

  // PRIMARY: Match exact LiveMint/ET format: "Buy TICKER in Cash @467 SL @ 444 TGT @ 505"
  const inlinePat = /buy\\s+\\w+\\s+(?:in\\s+cash\\s+)?@\\s*([\\d.]+)\\s+sl\\s*@\\s*([\\d.]+)\\s+tgt\\s*@\\s*([\\d.]+)/i;
  const inlineM = clean.match(inlinePat);
  let entry  = inlineM ? parseFloat(inlineM[1]) : null;
  let sl     = inlineM ? parseFloat(inlineM[2]) : null;
  let target = inlineM ? parseFloat(inlineM[3]) : null;

  // SECONDARY: if inline pattern didn't match, try keyword patterns
  if (!entry || !target || !sl) {
    let target2 = extractAfter([
      /tgt\\s*[@:]?\\s*([\\d,]+(?:\\.\\d{1,2})?)/i,
      /target\\s*(?:price|of|at|:|@)?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /(?:tp|tgt)\\s*[:\\-@]\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /price\\s+target\\s+(?:of\\s+)?(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /(?:₹|Rs\\.?)\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:as\\s+)?target/i,
      /target[:\\s]+(?:Rs\\.?\\s*)?(\\d[\\d,.]+)/i,
    ], clean);
    let sl2 = extractAfter([
      /sl\\s*@\\s*([\\d,]+(?:\\.\\d{1,2})?)/i,
      /stop\\s*[-\\s]?loss\\s*(?:at|of|:|@)?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /stoploss\\s*(?:at|of|:|@)?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /\\bsl\\b\\s*(?:at|of|:|@|-|@)?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /stop\\s*loss[:\\s]+(?:Rs\\.?\\s*)?(\\d[\\d,.]+)/i,
    ], clean);
    let entry2 = extractAfter([
      /buy\\s+(?:\\w+\\s+)?(?:in\\s+cash\\s+)?@\\s*([\\d,]+(?:\\.\\d{1,2})?)/i,
      /buy\\s*(?:at|@|around|near|above|below)?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /entry\\s*(?:at|@|:)?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /\\bcmp\\b\\s*[:\\-@]?\\s*(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
      /buy\\s+at\\s+(?:Rs\\.?\\s*)?(\\d[\\d,.]+)/i,
      /trading\\s+(?:at|around|near)\\s+(?:₹|Rs\\.?\\s*)?([\\d,]+(?:\\.\\d{1,2})?)/i,
    ], clean);
    if (!target && target2) target = target2;
    if (!sl && sl2) sl = sl2;
    if (!entry && entry2) entry = entry2;
  }

  // TERTIARY: collect all @ prices and assign by position
  if (!entry || !target || !sl) {
    const atPrices = [];
    const atRe = /@\\s*([\\d,]+(?:\\.\\d{1,2})?)/g;
    let atm;
    while ((atm = atRe.exec(clean)) !== null) {
      const v = parseFloat(atm[1].replace(/,/g,''));
      if (v > 1 && v < 2000000) atPrices.push(v);
    }
    // Format: @entry @sl @target  (3 @ signs in order)
    if (atPrices.length >= 3) {
      if (!entry)  entry  = atPrices[0];
      if (!sl)     sl     = atPrices[1];
      if (!target) target = atPrices[2];
    } else if (atPrices.length === 2) {
      if (!entry)  entry  = atPrices[0];
      if (!target) target = atPrices[1];
    }
  }

  // QUATERNARY: collect all ₹/Rs amounts
  if (!entry || !target) {
    const allPrices = [];
    const priceRe = /(?:₹|Rs\\.?)\\s*([\\d,]+(?:\\.\\d{1,2})?)/gi;
    let pm;
    while ((pm = priceRe.exec(clean)) !== null) {
      const v = parseFloat(pm[1].replace(/,/g,''));
      if (v > 1 && v < 2000000) allPrices.push(v);
    }
    const unique = [...new Set(allPrices)].sort((a,b)=>a-b);
    if (action === 'BUY')  { if (!entry) entry=unique[0]; if (!target) target=unique[unique.length-1]; }
    if (action === 'SELL') { if (!entry) entry=unique[unique.length-1]; if (!target) target=unique[0]; }
  }

  // Last resort: collect all ₹ amounts and assign by position/logic
  if (!entry || !target) {
    const allPrices = [];
    const priceRe = /(?:₹|@\\s*)([\\d,]+(?:\\.\\d{1,2})?)/g;
    let pm;
    while ((pm = priceRe.exec(clean)) !== null) {
      const v = parseFloat(pm[1].replace(/,/g,''));
      if (v > 1 && v < 2000000) allPrices.push(v);
    }
    const unique = [...new Set(allPrices)].sort((a,b)=>a-b);
    if (unique.length >= 2) {
      if (action === 'BUY')  { if (!entry) entry = unique[0]; if (!target) target = unique[unique.length-1]; }
      if (action === 'SELL') { if (!entry) entry = unique[unique.length-1]; if (!target) target = unique[0]; }
    } else if (unique.length === 1) {
      if (!target) target = unique[0];
    }
  }

  // ── Anchor extraction ────────────────────────────────────────────────────────
  let anchor = 'Market Desk';
  const tl = text.toLowerCase();
  for (const name of KNOWN_ANCHORS) {
    if (tl.includes(name.toLowerCase())) { anchor = name; break; }
  }
  if (anchor === 'Market Desk') {
    // "Rahul Shah of Motilal recommends" / "said Kunal Shah"
    const am = text.match(/([A-Z][a-z]+(?: [A-Z][a-z]+){1,3})\\s+(?:of\\s+[\\w\\s]+?\\s+)?(?:recommends?|suggests?|says?|advises?|told|picks?)/);
    if (am) anchor = am[1];
  }

  const snippet = (title && title.length > 10 ? title : text).substring(0, 180);
  return { ticker, cname, action, entry: entry||null, sl: sl||null, target: target||null, anchor, snippet, ts };
}

// Legacy single-call wrapper (for backward compat)
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
  g.innerHTML=arts.map(r=>{
    const c=srcInfo(r.source);
    const rr=rrCalc(r);
    const ep=fmtP(r.entry),sp=fmtP(r.sl),tp=fmtP(r.target);
    const hasPrice=ep||sp||tp;
    let rrHtml='';
    if(rr){const tot=rr.risk+rr.reward||1,lw=Math.round(rr.risk/tot*100),gw=Math.round(rr.reward/tot*100);
      rrHtml=\`<div class="rr-row"><span>R:R</span><div class="rr-bar"><div class="rr-loss" style="width:\${lw}%"></div><div class="rr-gain" style="width:\${gw}%"></div></div><span class="rr-val">1:\${rr.ratio}</span></div>\`;}
    return \`<div class="rcard \${r.action.toLowerCase()}">
      <div class="rcard-top">
        <div><div class="ticker-big">\${r.ticker}</div><div class="cname">\${r.cname}</div></div>
        <div class="right-top">
          <span class="action-badge \${r.action.toLowerCase()}">\${r.action}</span>
          <button class="del-btn" onclick="del(\${r.id})"><i class="ti ti-x"></i></button>
        </div>
      </div>
      \${hasPrice?\`<div class="price-row">
        <div class="pbox"><div class="pbox-label">Entry</div><div class="pbox-val entry">\${ep||'<span class="pbox-na">—</span>'}</div></div>
        <div class="pbox"><div class="pbox-label">Stop Loss</div><div class="pbox-val sl">\${sp||'<span class="pbox-na">—</span>'}</div></div>
        <div class="pbox"><div class="pbox-label">Target</div><div class="pbox-val tgt">\${tp||'<span class="pbox-na">—</span>'}</div></div>
      </div>\`:''}
      \${rrHtml}
      \${r.snippet?\`<div class="snippet">\${r.snippet.substring(0,160)}\${r.snippet.length>160?'…':''}</div>\`:''}
      <div class="src-footer">
        <div class="src-logo" style="background:\${c.color}20;color:\${c.color};border-color:\${c.color}50">\${c.initials}</div>
        <div class="src-info">
          <div class="src-channel">\${r.sourceName||c.name}</div>
          <div class="src-anchor"><i class="ti ti-microphone" style="font-size:10px"></i>\${r.anchor}</div>
        </div>
        <span class="src-time"><i class="ti ti-clock" style="font-size:10px"></i>\${ta(r.ts)}</span>
        \${r.auto?'<span class="auto-tag">Auto</span>':''}
        \${r.link?\`<a class="read-link" href="\${r.link}" target="_blank" rel="noopener"><i class="ti ti-external-link" style="font-size:10px"></i>Read</a>\`:''}
      </div>
    </div>\`;
  }).join('');
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
