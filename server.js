const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3399);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 60000);
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 10000);
const ALERT_GAP_THRESHOLD_PCT = Number(process.env.ALERT_GAP_THRESHOLD_PCT || 5);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_TARGET = String(process.env.TELEGRAM_TARGET || '@plm2000').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_ALERT_COOLDOWN_MS = Number(process.env.TELEGRAM_ALERT_COOLDOWN_MS || 900000);
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SEARCH_QUERIES = [
  'USDC/USDT', 'USDT/USDC', 'USDC/DAI', 'USDT/DAI', 'USDC/USDE', 'USDC/USDS',
  'ETH/USDC', 'WETH/USDC', 'WBTC/USDC', 'SOL/USDC', 'CRO/USDC', 'ARB/USDC',
  'OP/USDC', 'AVAX/USDC', 'SUI/USDC', 'APT/USDC'
];
const WATCHLIST = [
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'solana',
  'fantom', 'gnosis', 'linea', 'zksync', 'sonic', 'unichain', 'cronos', 'celo',
  'mantle', 'blast', 'scroll', 'manta', 'mode', 'opbnb', 'aurora', 'metis', 'moonbeam',
  'taiko', 'core', 'pulsechain', 'abstract', 'near', 'aptos', 'sui'
];
const CHAIN_NAMES = {
  ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', avalanche: 'Avalanche', solana: 'Solana', fantom: 'Fantom', gnosis: 'Gnosis', linea: 'Linea', zksync: 'zkSync Era', sonic: 'Sonic', unichain: 'Unichain', cronos: 'Cronos', celo: 'Celo', mantle: 'Mantle', blast: 'Blast', scroll: 'Scroll', manta: 'Manta', mode: 'Mode', opbnb: 'opBNB', aurora: 'Aurora', metis: 'Metis', moonbeam: 'Moonbeam', taiko: 'Taiko', core: 'Core', pulsechain: 'PulseChain', abstract: 'Abstract', near: 'NEAR', aptos: 'Aptos', sui: 'Sui'
};
const state = {
  scanner: { running: true, intervalMs: SCAN_INTERVAL_MS, lastScan: null, nextScan: null, durationMs: 0, source: 'DEX Screener public API', sourceStatus: 'starting', queries: SEARCH_QUERIES.length, errors: [] },
  networks: WATCHLIST.map(id => ({ id, name: CHAIN_NAMES[id] || id, status: 'waiting', pairs: 0, lastSeen: null })),
  opportunities: [],
  history: []
};
let previousPairs = new Map();
const sentTelegramAlerts = new Map();
const telegramStatus = { configured: Boolean(TELEGRAM_BOT_TOKEN), target: TELEGRAM_TARGET || null, resolved: Boolean(TELEGRAM_CHAT_ID), lastSentAt: null, alertsSent: 0, lastError: null };

function round(value, digits = 2) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function stableSymbol(value) { return String(value || '').trim().toUpperCase(); }
function isTrackablePair(pair) {
  const allowed = new Set(['USDC', 'USDC.E', 'USDT', 'USDT.E', 'DAI', 'USDE', 'USDS', 'FDUSD', 'USDD', 'USD0', 'PYUSD', 'ETH', 'WETH', 'WBTC', 'BTC', 'SOL', 'CRO', 'WCR0', 'ARB', 'OP', 'AVAX', 'WAVAX', 'SUI', 'APT', 'NEAR', 'BNB', 'WBNB', 'POL', 'MATIC', 'WMATIC', 'FTM', 'WFTM']);
  const base = stableSymbol(pair?.baseToken?.symbol); const quote = stableSymbol(pair?.quoteToken?.symbol);
  return allowed.has(base) && allowed.has(quote) && base !== quote;
}
function chainName(id) { return CHAIN_NAMES[id] || String(id || 'Unknown'); }
function bridgeEstimate(source, destination) {
  if (source === destination) return { minutes: 0, feeBps: 0, mode: 'same-chain' };
  const fastChains = new Set(['base', 'arbitrum', 'optimism', 'polygon', 'zksync', 'linea', 'sonic']);
  return { minutes: fastChains.has(source) && fastChains.has(destination) ? 4 : 12, feeBps: 12, mode: 'cross-chain estimate' };
}
function normalizePair(pair) {
  if (!pair || !pair.chainId || !pair.dexId || !isTrackablePair(pair)) return null;
  const price = Number(pair.priceUsd); const liquidity = Number(pair.liquidity?.usd);
  // Symbol-only discovery can include spoofed or badly indexed tokens. Keep the
  // live feed conservative until a chain-specific token registry is configured.
  if (!Number.isFinite(price) || price < 0.8 || price > 1.2 || !Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) return null;
  return { chainId: String(pair.chainId), chain: chainName(pair.chainId), dex: String(pair.dexId), pairAddress: String(pair.pairAddress || ''), url: pair.url || null, base: stableSymbol(pair.baseToken.symbol), quote: stableSymbol(pair.quoteToken.symbol), price, liquidity, volume24h: Number(pair.volume?.h24 || 0), txns24h: Number(pair.txns?.h24?.buys || 0) + Number(pair.txns?.h24?.sells || 0), fetchedAt: new Date().toISOString() };
}
function enrichMarketSignals(pairs) {
  const enriched = pairs.map(pair => {
    const previous = previousPairs.get(`${pair.chainId}:${pair.pairAddress}`);
    const priceChangePct = previous?.price ? (pair.price - previous.price) / previous.price * 100 : null;
    const liquidityChangePct = previous?.liquidity ? (pair.liquidity - previous.liquidity) / previous.liquidity * 100 : null;
    return { ...pair, priceChangePct: Number.isFinite(priceChangePct) ? round(priceChangePct, 2) : null, liquidityChangePct: Number.isFinite(liquidityChangePct) ? round(liquidityChangePct, 2) : null };
  });
  previousPairs = new Map(enriched.map(pair => [`${pair.chainId}:${pair.pairAddress}`, pair]));
  return enriched;
}
function classifyGap(buy, sell, gapPct) {
  const priceShock = Math.max(Math.abs(buy.priceChangePct || 0), Math.abs(sell.priceChangePct || 0));
  const liquidityDrop = Math.min(buy.liquidityChangePct ?? 0, sell.liquidityChangePct ?? 0);
  if (liquidityDrop <= -35 || priceShock >= 15) return { type: 'Potential pool / incident dislocation', confidence: 'heuristic', risk: 'Sharp price or liquidity movement detected. Investigate for exploit, reorg, oracle failure, or stale indexing before trading.' };
  if (buy.chainId !== sell.chainId) return { type: 'Cross-chain DEX gap', confidence: gapPct >= 5 ? 'review required' : 'monitoring', risk: 'Bridge settlement, inventory, finality, and quote freshness must be verified.' };
  return { type: 'DEX pool price gap', confidence: gapPct >= 5 ? 'review required' : 'monitoring', risk: 'Re-quote both pools and verify liquidity before assuming execution.' };
}
function escapeTelegram(value) { return String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])); }
function opportunityLinks(opportunity) {
  return [
    opportunity.buy.url ? `<a href="${escapeTelegram(opportunity.buy.url)}">Buy pool</a>` : null,
    opportunity.sell.url ? `<a href="${escapeTelegram(opportunity.sell.url)}">Sell pool</a>` : null
  ].filter(Boolean).join(' · ');
}
function opportunityProcedure(opportunity) {
  const crossChain = opportunity.buy.chainId !== opportunity.sell.chainId;
  return [
    '1. Re-quote both pools and verify token contract addresses, liquidity, and block freshness.',
    opportunity.classification.type.includes('incident') ? '2. Pause and investigate rollback, exploit, oracle, or stale-indexing evidence before moving funds.' : '2. Confirm the spread survives conservative slippage, fees, gas, and price impact.',
    crossChain ? '3. Confirm bridge/CCTP message state, destination finality, and available inventory on both chains.' : '3. Keep inventory on the same chain and check both swap routes can settle atomically enough for the risk budget.',
    crossChain ? '4. Execute only with pre-funded inventory or a tested settlement path; never assume a bridge message is final.' : '4. Simulate buy → sell → settlement, then enforce a max loss and minimum net-profit threshold.',
    '5. Save transaction hashes and compare realized P&L against this alert; this monitor does not sign or submit transactions.'
  ];
}
async function telegramRequest(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Telegram bot token is not configured');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`); return result.result;
}
async function resolveTelegramChatId() {
  if (TELEGRAM_CHAT_ID) return TELEGRAM_CHAT_ID;
  if (!TELEGRAM_TARGET) return null;
  try { const chat = await telegramRequest('getChat', { chat_id: TELEGRAM_TARGET }); if (chat?.id) { telegramStatus.resolved = true; return String(chat.id); } } catch (error) { telegramStatus.lastError = error.message; }
  try { const updates = await telegramRequest('getUpdates', { allowed_updates: ['message'], limit: 100 }); const match = updates.find(update => update.message?.from?.username?.toLowerCase() === TELEGRAM_TARGET.replace(/^@/, '').toLowerCase() || update.message?.chat?.username?.toLowerCase() === TELEGRAM_TARGET.replace(/^@/, '').toLowerCase()); if (match?.message?.chat?.id) { telegramStatus.resolved = true; return String(match.message.chat.id); } } catch (error) { telegramStatus.lastError = error.message; }
  return null;
}
async function notifyTelegram(opportunities) {
  const candidates = opportunities.filter(item => item.gapPct >= ALERT_GAP_THRESHOLD_PCT).filter(item => { const previous = sentTelegramAlerts.get(item.id); const changed = !previous || Date.now() - previous.sentAt >= TELEGRAM_ALERT_COOLDOWN_MS || Math.abs(item.gapPct - previous.gapPct) >= 1; if (changed) sentTelegramAlerts.set(item.id, { sentAt: Date.now(), gapPct: item.gapPct }); return changed; }).slice(0, 8);
  if (!candidates.length) return;
  if (!TELEGRAM_BOT_TOKEN) { telegramStatus.lastError = 'Bot token is not configured'; return; }
  const chatId = await resolveTelegramChatId(); if (!chatId) { telegramStatus.lastError = 'Target chat is not resolved. The target user must start the bot or TELEGRAM_CHAT_ID must be configured.'; return; }
  const lines = ['<b>ARBI ALERT · GAP ≥ 5%</b>', `Detected ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} from the live DEX scan.`, ''];
  candidates.forEach((item, index) => { lines.push(`<b>${index + 1}. ${escapeTelegram(item.pair)} · ${item.gapPct.toFixed(3)}%</b>`); lines.push(`${escapeTelegram(item.classification.type)} · ${escapeTelegram(item.buy.chain)} / ${escapeTelegram(item.buy.dex)} → ${escapeTelegram(item.sell.chain)} / ${escapeTelegram(item.sell.dex)}`); lines.push(`<b>Model:</b> gross ${item.grossUsd.toFixed(0)} USD · estimated net ${item.estimatedNetUsd.toFixed(0)} USD`); lines.push(`<b>Why it may exist:</b> ${escapeTelegram(item.classification.risk)}`); lines.push('<b>Procedure</b>'); opportunityProcedure(item).forEach(step => lines.push(escapeTelegram(step))); const links = opportunityLinks(item); if (links) lines.push(`<b>Links:</b> ${links}`); lines.push(''); });
  try { await telegramRequest('sendMessage', { chat_id: chatId, text: lines.join('\n').slice(0, 4090), parse_mode: 'HTML', disable_web_page_preview: true }); telegramStatus.lastSentAt = new Date().toISOString(); telegramStatus.alertsSent += candidates.length; telegramStatus.lastError = null; } catch (error) { telegramStatus.lastError = error.message; }
}
async function fetchJson(url) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  try { const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); }
  finally { clearTimeout(timeout); }
}
function buildOpportunity(low, high) {
  if (!low || !high || low.pairAddress === high.pairAddress || low.base !== high.base) return null;
  const lowPrice = Math.min(low.price, high.price); const highPrice = Math.max(low.price, high.price); const buy = low.price <= high.price ? low : high; const sell = buy === low ? high : low;
  const gapPct = (highPrice - lowPrice) / lowPrice * 100; if (gapPct <= 0.05 || gapPct > 50) return null;
  const bridge = bridgeEstimate(buy.chainId, sell.chainId); const classification = classifyGap(buy, sell, gapPct); const capital = Math.min(25000, buy.liquidity * 0.04, sell.liquidity * 0.04);
  const tradingFee = capital * 0.0025 * 2; const slippage = capital * Math.min(0.012, capital / Math.min(buy.liquidity, sell.liquidity) * 0.6); const bridgeFee = capital * bridge.feeBps / 10000; const gas = buy.chainId === 'ethereum' || sell.chainId === 'ethereum' ? 35 : 4; const gross = capital * gapPct / 100; const net = gross - tradingFee - slippage - bridgeFee - gas;
  return { id: `${buy.chainId}:${buy.dex}:${buy.pairAddress}:${sell.chainId}:${sell.dex}:${sell.pairAddress}`, detectedAt: new Date().toISOString(), pair: `${buy.base} / ${buy.quote}`, asset: buy.base, buy: { chainId: buy.chainId, chain: buy.chain, dex: buy.dex, price: buy.price, liquidity: buy.liquidity, pairAddress: buy.pairAddress, url: buy.url, priceChangePct: buy.priceChangePct, liquidityChangePct: buy.liquidityChangePct }, sell: { chainId: sell.chainId, chain: sell.chain, dex: sell.dex, price: sell.price, liquidity: sell.liquidity, pairAddress: sell.pairAddress, url: sell.url, priceChangePct: sell.priceChangePct, liquidityChangePct: sell.liquidityChangePct }, gapPct: round(gapPct, 3), grossUsd: round(gross), estimatedNetUsd: round(net), estimatedNetPct: round(net / capital * 100, 3), liquidityUsd: round(Math.min(buy.liquidity, sell.liquidity)), bridgeMinutes: bridge.minutes, bridgeMode: bridge.mode, freshnessSeconds: 0, costs: { tradingFeeUsd: round(tradingFee), slippageUsd: round(slippage), bridgeFeeUsd: round(bridgeFee), gasUsd: round(gas) }, classification, status: net / capital * 100 >= 0.35 && net > 0 ? 'qualified' : 'observed', source: 'DEX Screener snapshot', simulated: false };
}
function findOpportunities(pairs) {
  const groups = new Map(); for (const pair of pairs) { const key = `${pair.base}|${pair.quote}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(pair); }
  const opportunities = []; for (const group of groups.values()) { group.sort((a, b) => a.price - b.price); const opportunity = buildOpportunity(group[0], group[group.length - 1]); if (opportunity) opportunities.push(opportunity); }
  return opportunities.sort((a, b) => b.estimatedNetPct - a.estimatedNetPct).slice(0, 100);
}
function simulateOpportunity(opportunity) {
  const capital = Math.min(25000, opportunity.liquidityUsd * 0.04); const gross = capital * opportunity.gapPct / 100; const costs = { buyFee: capital * 0.0025, bridge: capital * (opportunity.bridgeMinutes ? 0.0012 : 0), sellFee: capital * 0.0025, slippage: capital * Math.min(0.012, capital / Math.max(opportunity.liquidityUsd, 1) * 0.6), gas: opportunity.costs.gasUsd }; const totalCosts = Object.values(costs).reduce((sum, value) => sum + value, 0);
  return { id: opportunity.id, createdAt: new Date().toISOString(), capitalUsd: round(capital), grossUsd: round(gross), costs: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, round(value)])), totalCostsUsd: round(totalCosts), netUsd: round(gross - totalCosts), netPct: round((gross - totalCosts) / capital * 100, 3), timeline: [{ key: 'detect', label: 'Detect', detail: `Observed ${opportunity.gapPct.toFixed(3)}% price gap between ${opportunity.buy.dex} and ${opportunity.sell.dex}.` }, { key: 'quote', label: 'Re-quote', detail: 'Re-checking pool liquidity, price impact, and quote freshness.' }, { key: 'fund', label: 'Allocate', detail: `Allocating $${Math.round(capital).toLocaleString('en-US')} of simulated inventory.` }, { key: 'bridge', label: opportunity.bridgeMinutes ? 'Bridge' : 'Route', detail: opportunity.bridgeMinutes ? `Estimated ${opportunity.bridgeMinutes} minute cross-chain settlement.` : 'Keeping inventory on the same chain.' }, { key: 'swap', label: 'Swap', detail: `Buy on ${opportunity.buy.dex}, then sell on ${opportunity.sell.dex}.` }, { key: 'settle', label: 'Settle', detail: `Estimated net result: $${Math.round(gross - totalCosts).toLocaleString('en-US')} after costs.` }] };
}
async function scan() {
  const started = Date.now(); state.scanner.sourceStatus = 'scanning'; state.scanner.errors = [];
  const results = await Promise.allSettled(SEARCH_QUERIES.map(query => fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`))); const allPairs = [];
  results.forEach((result, index) => { if (result.status === 'fulfilled') (result.value.pairs || []).forEach(pair => { const normalized = normalizePair(pair); if (normalized) allPairs.push(normalized); }); else state.scanner.errors.push(`${SEARCH_QUERIES[index]}: ${result.reason?.message || 'request failed'}`); });
  const unique = enrichMarketSignals([...new Map(allPairs.map(pair => [`${pair.chainId}:${pair.pairAddress}`, pair])).values()]); const byChain = new Map(); unique.forEach(pair => byChain.set(pair.chainId, (byChain.get(pair.chainId) || 0) + 1));
  state.networks = WATCHLIST.map(id => ({ id, name: CHAIN_NAMES[id] || id, status: byChain.get(id) ? 'online' : 'quiet', pairs: byChain.get(id) || 0, lastSeen: byChain.get(id) ? new Date().toISOString() : null })); state.opportunities = findOpportunities(unique); state.scanner.durationMs = Date.now() - started; state.scanner.lastScan = new Date().toISOString(); state.scanner.nextScan = new Date(Date.now() + SCAN_INTERVAL_MS).toISOString(); state.scanner.sourceStatus = results.some(result => result.status === 'fulfilled') ? 'live' : 'error';
  for (const opportunity of state.opportunities.slice(0, 20)) {
    const recent = state.history.find(item => item.status === 'detected' && item.opportunityId === opportunity.id && Date.now() - Date.parse(item.detectedAt) < 300000);
    if (!recent) state.history.unshift({ opportunityId: opportunity.id, detectedAt: opportunity.detectedAt, pair: opportunity.pair, route: `${opportunity.buy.chain} / ${opportunity.buy.dex} → ${opportunity.sell.chain} / ${opportunity.sell.dex}`, gapPct: opportunity.gapPct, estimatedNetPct: opportunity.estimatedNetPct, qualification: opportunity.status, status: 'detected' });
  }
  state.history = state.history.slice(0, 60); await notifyTelegram(state.opportunities); return state;
}
function snapshot() { return JSON.parse(JSON.stringify({ scanner: state.scanner, networks: state.networks, opportunities: state.opportunities, history: state.history, telegram: { configured: telegramStatus.configured, target: telegramStatus.target, resolved: telegramStatus.resolved, thresholdPct: ALERT_GAP_THRESHOLD_PCT, lastSentAt: telegramStatus.lastSentAt, alertsSent: telegramStatus.alertsSent, lastError: telegramStatus.lastError }, summary: { networksMonitored: state.networks.length, networksWithData: state.networks.filter(network => network.status === 'online').length, dexPairs: state.networks.reduce((sum, network) => sum + network.pairs, 0), liveGaps: state.opportunities.length, qualified: state.opportunities.filter(item => item.status === 'qualified').length, simulatedPnl: state.history.filter(item => item.simulation).reduce((sum, item) => sum + Number(item.simulation.netUsd || 0), 0) } })); }
function sendJson(response, statusCode, payload) { const body = JSON.stringify(payload); response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) }); response.end(body); }
function serveStatic(response, pathname) { const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(PUBLIC_DIR, requested); if (!file.startsWith(path.resolve(PUBLIC_DIR)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found'); return; } const type = path.extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream'; response.writeHead(200, { 'content-type': type, 'cache-control': path.extname(file) === '.html' ? 'no-store' : 'public, max-age=3600' }); fs.createReadStream(file).pipe(response); }
async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return sendJson(response, 200, { ok: true, scanner: state.scanner.sourceStatus, lastScan: state.scanner.lastScan });
  if (url.pathname === '/api/telegram/status' && request.method === 'GET') { if (TELEGRAM_BOT_TOKEN && !telegramStatus.resolved) await resolveTelegramChatId(); return sendJson(response, 200, { configured: telegramStatus.configured, target: telegramStatus.target, resolved: telegramStatus.resolved, thresholdPct: ALERT_GAP_THRESHOLD_PCT, alertsSent: telegramStatus.alertsSent, lastSentAt: telegramStatus.lastSentAt, lastError: telegramStatus.lastError }); }
  if (url.pathname === '/api/state' && request.method === 'GET') return sendJson(response, 200, snapshot());
  if (url.pathname === '/api/scan' && request.method === 'POST') {
    await scan();
    return sendJson(response, 200, snapshot());
  }
  const simulationMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/simulate$/);
  if (simulationMatch && request.method === 'POST') { const id = decodeURIComponent(simulationMatch[1]); const opportunity = state.opportunities.find(item => item.id === id); if (!opportunity) return sendJson(response, 404, { error: 'Opportunity is no longer in the live snapshot.' }); const simulation = simulateOpportunity(opportunity); state.history.unshift({ opportunityId: opportunity.id, detectedAt: opportunity.detectedAt, pair: opportunity.pair, route: `${opportunity.buy.chain} / ${opportunity.buy.dex} → ${opportunity.sell.chain} / ${opportunity.sell.dex}`, gapPct: opportunity.gapPct, estimatedNetPct: opportunity.estimatedNetPct, status: 'simulated', simulation }); state.history = state.history.slice(0, 60); return sendJson(response, 200, { opportunity, simulation, state: snapshot() }); }
  return serveStatic(response, url.pathname);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const server = http.createServer((request, response) => { handle(request, response).catch(error => { console.error(error); sendJson(response, 500, { error: 'Internal scanner error' }); }); });
server.listen(PORT, '127.0.0.1', () => { console.log(`ARBI monitor listening on 127.0.0.1:${PORT}`); scan().catch(error => console.error('Initial scan failed:', error)); });
setInterval(() => scan().catch(error => console.error('Scheduled scan failed:', error)), SCAN_INTERVAL_MS);
