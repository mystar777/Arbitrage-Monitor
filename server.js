const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3399);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 60000);
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 10000);
const MIN_QUOTE_RESERVE_USD = Number(process.env.MIN_QUOTE_RESERVE_USD || 1000);
const ALERT_GAP_THRESHOLD_PCT = Number(process.env.ALERT_GAP_THRESHOLD_PCT || 5);
const DEFAULT_PNL_PERIOD_HOURS = Number(process.env.DEFAULT_PNL_PERIOD_HOURS || 24);
const DEFAULT_PNL_CAPITAL_USD = Number(process.env.DEFAULT_PNL_CAPITAL_USD || 10000);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_TARGET = String(process.env.TELEGRAM_TARGET || '@plm2000').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_ALERT_COOLDOWN_MS = Number(process.env.TELEGRAM_ALERT_COOLDOWN_MS || 900000);
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SOLANA_RPC_URL = String(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const STABLE_SYMBOLS = new Set(['USDC', 'USDC.E', 'USDT', 'USDT.E', 'DAI', 'USDE', 'USDS', 'FDUSD', 'USDD', 'USD0', 'PYUSD']);

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
const tokenRiskCache = new Map();
const sentTelegramAlerts = new Map();
const telegramStatus = { configured: Boolean(TELEGRAM_BOT_TOKEN), target: TELEGRAM_TARGET || null, resolved: Boolean(TELEGRAM_CHAT_ID), lastSentAt: null, alertsSent: 0, lastError: null };

function round(value, digits = 2) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
function pnlCapital(value) { return clamp(Number(value) || DEFAULT_PNL_CAPITAL_USD, 1, 100000000); }
function executionModel(opportunity) {
  const observations = Math.max(1, Number(opportunity.observationCount) || 1);
  let persistence = 0.35 + Math.min(0.3, (observations - 1) * 0.15);
  if (opportunity.identityVerified) persistence += 0.1; else persistence -= 0.1;
  if (opportunity.buy?.chainId === opportunity.sell?.chainId) persistence += 0.08; else persistence -= 0.08;
  if (Number(opportunity.gapPct) > 5) persistence -= 0.12;
  if (String(opportunity.classification?.type || '').toLowerCase().includes('incident')) persistence -= 0.15;
  if (Math.max(Math.abs(opportunity.buy?.priceChangePct || 0), Math.abs(opportunity.sell?.priceChangePct || 0)) >= 10) persistence -= 0.1;
  persistence = clamp(persistence, 0.1, 0.8);
  return { persistenceProbability: round(persistence, 3), reversionProbability: round(1 - persistence, 3) };
}
function simulationCosts(opportunity, requestedCapital = DEFAULT_PNL_CAPITAL_USD) {
  const capital = Math.min(25000, pnlCapital(requestedCapital), Math.max(1, Number(opportunity.liquidityUsd) || 1) * 0.04);
  const gross = capital * Number(opportunity.gapPct || 0) / 100;
  const costs = { buyFee: capital * 0.0025, bridge: capital * (opportunity.bridgeMinutes ? 0.0012 : 0), sellFee: capital * 0.0025, slippage: capital * Math.min(0.012, capital / Math.max(Number(opportunity.liquidityUsd) || 1, 1) * 0.6), gas: Number(opportunity.costs?.gasUsd) || 0 };
  const totalCosts = Object.values(costs).reduce((sum, value) => sum + value, 0);
  return { capital, gross, costs, totalCosts };
}
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
  const baseAddress = String(pair.baseToken?.address || '').trim(); const quoteAddress = String(pair.quoteToken?.address || '').trim();
  const price = Number(pair.priceUsd); const liquidity = Number(pair.liquidity?.usd); const quoteReserve = Number(pair.liquidity?.quote);
  // Symbol-only discovery can include spoofed or badly indexed tokens. Keep the
  // live feed conservative until a chain-specific token registry is configured.
  if (!baseAddress || !quoteAddress || !Number.isFinite(price) || price < 0.8 || price > 1.2 || !Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) return null;
  if (STABLE_SYMBOLS.has(stableSymbol(pair.quoteToken.symbol)) && (!Number.isFinite(quoteReserve) || quoteReserve < MIN_QUOTE_RESERVE_USD)) return null;
  return { chainId: String(pair.chainId), chain: chainName(pair.chainId), dex: String(pair.dexId), pairAddress: String(pair.pairAddress || ''), url: pair.url || null, base: stableSymbol(pair.baseToken.symbol), quote: stableSymbol(pair.quoteToken.symbol), baseAddress, quoteAddress, baseFreezable: null, quoteFreezable: null, price, liquidity, quoteReserve, volume24h: Number(pair.volume?.h24 || 0), txns24h: Number(pair.txns?.h24?.buys || 0) + Number(pair.txns?.h24?.sells || 0), fetchedAt: new Date().toISOString() };
}
async function fetchSolanaMintRisk(address) {
  const cached = tokenRiskCache.get(`solana:${address}`); if (cached && cached.expiresAt > Date.now()) return cached.freezable;
  try {
    const response = await fetchJson(SOLANA_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64' }] }) });
    const encoded = response?.result?.value?.data?.[0]; const bytes = encoded ? Buffer.from(encoded, 'base64') : null;
    const freezable = Boolean(bytes && bytes.length >= 82 && bytes.readUInt32LE(46) === 1);
    tokenRiskCache.set(`solana:${address}`, { freezable, expiresAt: Date.now() + 600000 }); return freezable;
  } catch { return null; }
}
async function enrichTokenRisks(pairs) {
  const addresses = [...new Set(pairs.filter(pair => pair.chainId === 'solana').flatMap(pair => [pair.baseAddress, pair.quoteAddress]))];
  const risks = new Map(await Promise.all(addresses.map(async address => [address, await fetchSolanaMintRisk(address)])));
  return pairs.map(pair => ({ ...pair, baseFreezable: pair.chainId === 'solana' ? risks.get(pair.baseAddress) ?? null : null, quoteFreezable: pair.chainId === 'solana' ? risks.get(pair.quoteAddress) ?? null : null }));
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
  const candidates = opportunities.filter(item => item.alertable && item.gapPct >= ALERT_GAP_THRESHOLD_PCT).filter(item => { const previous = sentTelegramAlerts.get(item.id); const changed = !previous || Date.now() - previous.sentAt >= TELEGRAM_ALERT_COOLDOWN_MS || Math.abs(item.gapPct - previous.gapPct) >= 1; if (changed) sentTelegramAlerts.set(item.id, { sentAt: Date.now(), gapPct: item.gapPct }); return changed; }).slice(0, 8);
  if (!candidates.length) return;
  if (!TELEGRAM_BOT_TOKEN) { telegramStatus.lastError = 'Bot token is not configured'; return; }
  const chatId = await resolveTelegramChatId(); if (!chatId) { telegramStatus.lastError = 'Target chat is not resolved. The target user must start the bot or TELEGRAM_CHAT_ID must be configured.'; return; }
  const lines = ['<b>ARBITRAGE ALERT · GAP ≥ 5%</b>', `Detected ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} from the live DEX scan.`, ''];
  candidates.forEach((item, index) => { lines.push(`<b>${index + 1}. ${escapeTelegram(item.pair)} · ${item.gapPct.toFixed(3)}%</b>`); lines.push(`${escapeTelegram(item.classification.type)} · ${escapeTelegram(item.buy.chain)} / ${escapeTelegram(item.buy.dex)} → ${escapeTelegram(item.sell.chain)} / ${escapeTelegram(item.sell.dex)}`); lines.push(`<b>Model:</b> gross ${item.grossUsd.toFixed(0)} USD · estimated net ${item.estimatedNetUsd.toFixed(0)} USD`); lines.push(`<b>Why it may exist:</b> ${escapeTelegram(item.classification.risk)}`); lines.push('<b>Procedure</b>'); opportunityProcedure(item).forEach(step => lines.push(escapeTelegram(step))); const links = opportunityLinks(item); if (links) lines.push(`<b>Links:</b> ${links}`); lines.push(''); });
  try { await telegramRequest('sendMessage', { chat_id: chatId, text: lines.join('\n').slice(0, 4090), parse_mode: 'HTML', disable_web_page_preview: true }); telegramStatus.lastSentAt = new Date().toISOString(); telegramStatus.alertsSent += candidates.length; telegramStatus.lastError = null; } catch (error) { telegramStatus.lastError = error.message; }
}
async function fetchJson(url, options = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  try { const response = await fetch(url, { ...options, headers: { accept: 'application/json', ...(options.headers || {}) }, signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); }
  finally { clearTimeout(timeout); }
}
function buildOpportunity(low, high) {
  if (!low || !high || low.pairAddress === high.pairAddress || low.base !== high.base || low.quote !== high.quote) return null;
  const sameChain = low.chainId === high.chainId;
  const sameTokenAddresses = low.baseAddress.toLowerCase() === high.baseAddress.toLowerCase() && low.quoteAddress.toLowerCase() === high.quoteAddress.toLowerCase();
  if (sameChain && !sameTokenAddresses) return null;
  if (low.baseFreezable === true || high.baseFreezable === true) return null;
  const lowPrice = Math.min(low.price, high.price); const highPrice = Math.max(low.price, high.price); const buy = low.price <= high.price ? low : high; const sell = buy === low ? high : low;
  const gapPct = (highPrice - lowPrice) / lowPrice * 100; if (gapPct <= 0.05 || gapPct > 50) return null;
  const bridge = bridgeEstimate(buy.chainId, sell.chainId); const classification = classifyGap(buy, sell, gapPct); const capital = Math.min(25000, buy.liquidity * 0.04, sell.liquidity * 0.04);
  const tradingFee = capital * 0.0025 * 2; const slippage = capital * Math.min(0.012, capital / Math.min(buy.liquidity, sell.liquidity) * 0.6); const bridgeFee = capital * bridge.feeBps / 10000; const gas = buy.chainId === 'ethereum' || sell.chainId === 'ethereum' ? 35 : 4; const gross = capital * gapPct / 100; const net = gross - tradingFee - slippage - bridgeFee - gas;
  const identityVerified = sameChain && sameTokenAddresses;
  const riskVerified = buy.chainId !== 'solana' || (buy.baseFreezable === false && sell.baseFreezable === false);
  const risk = identityVerified ? classification.risk : `${classification.risk} Cross-chain token identity is symbol-level only; verify the mint/contract mapping before trading.`;
  return { id: `${buy.chainId}:${buy.dex}:${buy.pairAddress}:${sell.chainId}:${sell.dex}:${sell.pairAddress}`, detectedAt: new Date().toISOString(), pair: `${buy.base} / ${buy.quote}`, asset: buy.base, buy: { chainId: buy.chainId, chain: buy.chain, dex: buy.dex, price: buy.price, liquidity: buy.liquidity, quoteReserve: buy.quoteReserve, pairAddress: buy.pairAddress, baseAddress: buy.baseAddress, quoteAddress: buy.quoteAddress, url: buy.url, priceChangePct: buy.priceChangePct, liquidityChangePct: buy.liquidityChangePct }, sell: { chainId: sell.chainId, chain: sell.chain, dex: sell.dex, price: sell.price, liquidity: sell.liquidity, quoteReserve: sell.quoteReserve, pairAddress: sell.pairAddress, baseAddress: sell.baseAddress, quoteAddress: sell.quoteAddress, url: sell.url, priceChangePct: sell.priceChangePct, liquidityChangePct: sell.liquidityChangePct }, gapPct: round(gapPct, 3), grossUsd: round(gross), estimatedNetUsd: round(net), estimatedNetPct: round(net / capital * 100, 3), liquidityUsd: round(Math.min(buy.liquidity, sell.liquidity)), bridgeMinutes: bridge.minutes, bridgeMode: bridge.mode, freshnessSeconds: 0, observationCount: 1, costs: { tradingFeeUsd: round(tradingFee), slippageUsd: round(slippage), bridgeFeeUsd: round(bridgeFee), gasUsd: round(gas) }, classification: { ...classification, risk }, identityVerified, riskVerified, alertable: identityVerified && riskVerified, status: identityVerified && riskVerified && net / capital * 100 >= 0.35 && net > 0 ? 'qualified' : 'observed', source: 'DEX Screener snapshot', simulated: false };
}
function findOpportunities(pairs) {
  const groups = new Map(); for (const pair of pairs) { const key = `${pair.base}|${pair.quote}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(pair); }
  const opportunities = []; for (const group of groups.values()) { group.sort((a, b) => a.price - b.price); for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) { const opportunity = buildOpportunity(group[i], group[j]); if (opportunity) opportunities.push(opportunity); } }
  return opportunities.sort((a, b) => b.estimatedNetPct - a.estimatedNetPct).slice(0, 100);
}
function simulateOpportunity(opportunity, requestedCapital = DEFAULT_PNL_CAPITAL_USD) {
  const { capital, gross, costs, totalCosts } = simulationCosts(opportunity, requestedCapital); const outcome = executionModel(opportunity); const persistedNet = gross - totalCosts; const revertedNet = -totalCosts; const expectedNet = persistedNet * outcome.persistenceProbability + revertedNet * outcome.reversionProbability;
  return { id: opportunity.id, createdAt: new Date().toISOString(), model: 'persistence-weighted execution model', capitalUsd: round(capital), grossUsd: round(gross), costs: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, round(value)])), totalCostsUsd: round(totalCosts), netUsd: round(expectedNet), netPct: round(expectedNet / capital * 100, 3), persistedNetUsd: round(persistedNet), revertedNetUsd: round(revertedNet), persistenceProbability: outcome.persistenceProbability, reversionProbability: outcome.reversionProbability, outcomeNote: 'If the gap reverts after execution, gross spread is zero and only modeled execution costs are lost.', timeline: [{ key: 'detect', label: 'Detect', detail: `Observed ${opportunity.gapPct.toFixed(3)}% price gap between ${opportunity.buy.dex} and ${opportunity.sell.dex}.` }, { key: 'quote', label: 'Re-quote', detail: 'Re-checking pool liquidity, price impact, and quote freshness.' }, { key: 'fund', label: 'Allocate', detail: `Allocating $${Math.round(capital).toLocaleString('en-US')} of simulated inventory.` }, { key: 'bridge', label: opportunity.bridgeMinutes ? 'Bridge' : 'Route', detail: opportunity.bridgeMinutes ? `Estimated ${opportunity.bridgeMinutes} minute cross-chain settlement.` : 'Keeping inventory on the same chain.' }, { key: 'swap', label: 'Swap', detail: `Buy on ${opportunity.buy.dex}, then sell on ${opportunity.sell.dex}.` }, { key: 'settle', label: 'Settle', detail: `Expected result: $${Math.round(expectedNet).toLocaleString('en-US')}; persisted gap: $${Math.round(persistedNet).toLocaleString('en-US')}; reverted gap: -$${Math.round(totalCosts).toLocaleString('en-US')}.` }] };
}
function calculatePnl(history, periodHours = DEFAULT_PNL_PERIOD_HOURS, initialCapital = DEFAULT_PNL_CAPITAL_USD) {
  const hours = clamp(Number(periodHours) || DEFAULT_PNL_PERIOD_HOURS, 1, 24 * 365); const startingCapital = pnlCapital(initialCapital); const cutoff = Date.now() - hours * 3600000;
  const attempts = history.filter(item => Date.parse(item.detectedAt) >= cutoff && item.opportunitySnapshot).map(item => { const simulation = simulateOpportunity(item.opportunitySnapshot, startingCapital); return { detectedAt: item.detectedAt, pair: item.pair, simulation }; });
  const sums = attempts.reduce((acc, item) => { const sim = item.simulation; acc.expected += sim.netUsd; acc.persisted += sim.persistedNetUsd * sim.persistenceProbability; acc.reverted += sim.revertedNetUsd * sim.reversionProbability; acc.best += sim.persistedNetUsd; acc.worst += sim.revertedNetUsd; acc.reversionProbability += sim.reversionProbability; return acc; }, { expected: 0, persisted: 0, reverted: 0, best: 0, worst: 0, reversionProbability: 0 });
  const expected = sums.expected; return { periodHours: hours, periodLabel: hours < 48 ? `${hours} hours` : `${round(hours / 24, hours % 24 ? 1 : 0)} days`, startingCapitalUsd: round(startingCapital), endingCapitalUsd: round(startingCapital + expected), pnlUsd: round(expected), pnlPct: round(expected / startingCapital * 100, 3), attempts: attempts.length, persistedContributionUsd: round(sums.persisted), revertedLossUsd: round(sums.reverted), bestCaseUsd: round(sums.best), worstCaseUsd: round(sums.worst), averageReversionProbability: attempts.length ? round(sums.reversionProbability / attempts.length * 100, 1) : 0, coverage: attempts.length ? { from: attempts[attempts.length - 1].detectedAt, to: attempts[0].detectedAt } : null };
}
async function scan() {
  const started = Date.now(); state.scanner.sourceStatus = 'scanning'; state.scanner.errors = [];
  const results = await Promise.allSettled(SEARCH_QUERIES.map(query => fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`))); const allPairs = [];
  results.forEach((result, index) => { if (result.status === 'fulfilled') (result.value.pairs || []).forEach(pair => { const normalized = normalizePair(pair); if (normalized) allPairs.push(normalized); }); else state.scanner.errors.push(`${SEARCH_QUERIES[index]}: ${result.reason?.message || 'request failed'}`); });
  const unique = enrichMarketSignals(await enrichTokenRisks([...new Map(allPairs.map(pair => [`${pair.chainId}:${pair.pairAddress}`, pair])).values()])); const byChain = new Map(); unique.forEach(pair => byChain.set(pair.chainId, (byChain.get(pair.chainId) || 0) + 1));
  const previousOpportunities = new Map(state.opportunities.map(item => [item.id, item])); state.networks = WATCHLIST.map(id => ({ id, name: CHAIN_NAMES[id] || id, status: byChain.get(id) ? 'online' : 'quiet', pairs: byChain.get(id) || 0, lastSeen: byChain.get(id) ? new Date().toISOString() : null })); state.opportunities = findOpportunities(unique).map(item => ({ ...item, observationCount: (previousOpportunities.get(item.id)?.observationCount || 0) + 1, firstObservedAt: previousOpportunities.get(item.id)?.firstObservedAt || item.detectedAt })); state.scanner.durationMs = Date.now() - started; state.scanner.lastScan = new Date().toISOString(); state.scanner.nextScan = new Date(Date.now() + SCAN_INTERVAL_MS).toISOString(); state.scanner.sourceStatus = results.some(result => result.status === 'fulfilled') ? 'live' : 'error';
  for (const opportunity of state.opportunities.slice(0, 20)) {
    const recent = state.history.find(item => item.opportunityId === opportunity.id && Date.now() - Date.parse(item.detectedAt) < 300000);
    if (!recent) state.history.unshift({ opportunityId: opportunity.id, detectedAt: opportunity.detectedAt, pair: opportunity.pair, route: `${opportunity.buy.chain} / ${opportunity.buy.dex} → ${opportunity.sell.chain} / ${opportunity.sell.dex}`, gapPct: opportunity.gapPct, estimatedNetPct: opportunity.estimatedNetPct, qualification: opportunity.status, opportunitySnapshot: opportunity, status: 'detected' });
  }
  state.history = state.history.slice(0, 60); await notifyTelegram(state.opportunities); return state;
}
function snapshot() { const pnl = calculatePnl(state.history); return JSON.parse(JSON.stringify({ scanner: state.scanner, networks: state.networks, opportunities: state.opportunities, history: state.history, telegram: { configured: telegramStatus.configured, target: telegramStatus.target, resolved: telegramStatus.resolved, thresholdPct: ALERT_GAP_THRESHOLD_PCT, lastSentAt: telegramStatus.lastSentAt, alertsSent: telegramStatus.alertsSent, lastError: telegramStatus.lastError }, summary: { networksMonitored: state.networks.length, networksWithData: state.networks.filter(network => network.status === 'online').length, dexPairs: state.networks.reduce((sum, network) => sum + network.pairs, 0), liveGaps: state.opportunities.length, qualified: state.opportunities.filter(item => item.status === 'qualified').length, simulatedPnl: pnl.pnlUsd, pnl } })); }
function sendJson(response, statusCode, payload) { const body = JSON.stringify(payload); response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) }); response.end(body); }
function serveStatic(response, pathname) { const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(PUBLIC_DIR, requested); if (!file.startsWith(path.resolve(PUBLIC_DIR)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found'); return; } const contentTypes = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }; const type = contentTypes[path.extname(file).toLowerCase()] || 'application/octet-stream'; response.writeHead(200, { 'content-type': type, 'cache-control': path.extname(file) === '.html' ? 'no-store' : 'public, max-age=3600' }); fs.createReadStream(file).pipe(response); }
async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return sendJson(response, 200, { ok: true, scanner: state.scanner.sourceStatus, lastScan: state.scanner.lastScan });
  if (url.pathname === '/api/telegram/status' && request.method === 'GET') { if (TELEGRAM_BOT_TOKEN && !telegramStatus.resolved) await resolveTelegramChatId(); return sendJson(response, 200, { configured: telegramStatus.configured, target: telegramStatus.target, resolved: telegramStatus.resolved, thresholdPct: ALERT_GAP_THRESHOLD_PCT, alertsSent: telegramStatus.alertsSent, lastSentAt: telegramStatus.lastSentAt, lastError: telegramStatus.lastError }); }
  if (url.pathname === '/api/pnl' && request.method === 'GET') return sendJson(response, 200, calculatePnl(state.history, Number(url.searchParams.get('hours')) || DEFAULT_PNL_PERIOD_HOURS, Number(url.searchParams.get('capital')) || DEFAULT_PNL_CAPITAL_USD));
  if (url.pathname === '/api/state' && request.method === 'GET') return sendJson(response, 200, snapshot());
  if (url.pathname === '/api/scan' && request.method === 'POST') {
    await scan();
    return sendJson(response, 200, snapshot());
  }
  const simulationMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/simulate$/);
  if (simulationMatch && request.method === 'POST') { const id = decodeURIComponent(simulationMatch[1]); const opportunity = state.opportunities.find(item => item.id === id); if (!opportunity) return sendJson(response, 404, { error: 'Opportunity is no longer in the live snapshot.' }); const simulation = simulateOpportunity(opportunity); const existing = state.history.find(item => item.opportunityId === opportunity.id && item.opportunitySnapshot); if (existing) Object.assign(existing, { status: 'simulated', simulation, opportunitySnapshot: opportunity }); else state.history.unshift({ opportunityId: opportunity.id, detectedAt: opportunity.detectedAt, pair: opportunity.pair, route: `${opportunity.buy.chain} / ${opportunity.buy.dex} → ${opportunity.sell.chain} / ${opportunity.sell.dex}`, gapPct: opportunity.gapPct, estimatedNetPct: opportunity.estimatedNetPct, opportunitySnapshot: opportunity, status: 'simulated', simulation }); state.history = state.history.slice(0, 60); return sendJson(response, 200, { opportunity, simulation, state: snapshot() }); }
  return serveStatic(response, url.pathname);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const server = http.createServer((request, response) => { handle(request, response).catch(error => { console.error(error); sendJson(response, 500, { error: 'Internal scanner error' }); }); });
server.listen(PORT, '127.0.0.1', () => { console.log(`Arbitrage monitor listening on 127.0.0.1:${PORT}`); scan().catch(error => console.error('Initial scan failed:', error)); });
setInterval(() => scan().catch(error => console.error('Scheduled scan failed:', error)), SCAN_INTERVAL_MS);
