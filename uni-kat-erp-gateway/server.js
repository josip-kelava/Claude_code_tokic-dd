'use strict';
/*
 * UNI KAT ERP gateway
 *
 * Sits between the UNI KAT web page (browser) and the Business Central TMConnect ERP V2.14
 * web service. The browser builds a GetErpInformationRequest exactly as TKAT does, without a
 * password. This service:
 *   1. checks that the user is logged in (customer K-code + password, kept server-side only),
 *   2. puts the user's credentials into <Credentials>,
 *   3. answers it from BC – TMC_MODE=bcapi (default): calls the BC TKAT API (OData actions
 *      TKATApiMgmt_GetItemsPrice / TKATApiMgmt_GetItemsStock, the same ones TKAT's ERP side uses) and
 *      builds a TMConnect GetErpInformationReply; TMC_MODE=soap: forwards to a TMConnect SOAP endpoint,
 *   4. returns the GetErpInformationReply XML to the browser.
 *
 * Only GetErpInformation is exposed. SendOrder is deliberately not exposed: "U košaricu" hands the
 * item over to TKAT, it does not create an order in BC.
 *
 * No external dependencies (Node.js 18+). All settings come from environment variables; nothing
 * secret is stored in this repository.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const cfg = {
  port: +(process.env.PORT || 8080),
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'https://josip-kelava.github.io',
  bcUrl: process.env.BC_TMCONNECT_URL || '',                 // e.g. https://<tmconnect-host>/TMConnectV2.svc
  mode: (process.env.TMC_MODE || 'bcapi').toLowerCase(),     // 'bcapi' (BC TKAT OData API), 'soap' (TMConnect WSDL) or 'xml'
  bcBase: process.env.BC_BASE_URL || '',                     // e.g. https://<bc-server>:<port>/<instance>
  bcCompany: process.env.BC_COMPANY || '',                   // company name in BC (test and production differ)
  bcUser: process.env.BC_USER || '',                         // BC web service user – from a secret store, never in the repo
  bcPassword: process.env.BC_PASSWORD || '',
  devLogin: process.env.ALLOW_DEV_LOGIN === '1',             // internal testing only: login with K-code, no password
  soapNs: process.env.TMC_SOAP_NS || 'http://tempuri.org/',  // target namespace from TMConnect_V2.14.wsdl
  soapAction: process.env.TMC_SOAP_ACTION || '',             // e.g. http://tempuri.org/ITMConnect/GetErpInformation
  soapParam: process.env.TMC_SOAP_PARAM || 'request',        // name of the operation's parameter in the WSDL
  bcAuthHeader: process.env.BC_AUTH_HEADER || '',            // optional service-level auth header for BC, e.g. "Basic ..."
  sessionHours: +(process.env.SESSION_HOURS || 8),
  maxBody: 1024 * 1024,
  maxItems: +(process.env.MAX_ITEMS || 100),
};

const sessions = new Map(); // sid -> { customerId, username, password, exp }

function xe(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin === cfg.allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > cfg.maxBody) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getSession(req) {
  const m = /(?:^|;\s*)unikat_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}

function errorReply(msg) {
  return '<?xml version="1.0"?>\n<GetErpInformationReply xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<StatusId>-1</StatusId><ErrorMessage>' + xe(msg) + '</ErrorMessage><TimeStamp>' + new Date().toISOString() + '</TimeStamp></GetErpInformationReply>';
}

/* Replace whatever <Credentials> the browser sent with the logged-in user's credentials. */
function injectCredentials(xml, s) {
  const cred = '<Credentials><CatalogUserCredentials><Username>' + xe(s.username) + '</Username><Password>' + xe(s.password) +
    '</Password><CustomerId>' + xe(s.customerId) + '</CustomerId></CatalogUserCredentials><IsEncrypted>false</IsEncrypted></Credentials>';
  const stripped = xml.replace(/<Credentials>[\s\S]*?<\/Credentials>|<Credentials\s*\/>/, '');
  return stripped.replace(/(<GetErpInformationRequest\b[^>]*>)/, '$1' + cred);
}

/* TODO: confirm element names against TMConnect_V2.14.wsdl (operation, parameter and result names). */
function toSoap(innerXml) {
  const body = innerXml.replace(/^<\?xml[^>]*>\s*/, '')
    .replace(/^<GetErpInformationRequest\b[^>]*>/, '<' + cfg.soapParam + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
    .replace(/<\/GetErpInformationRequest>\s*$/, '</' + cfg.soapParam + '>');
  return '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<GetErpInformation xmlns="' + xe(cfg.soapNs) + '">' + body + '</GetErpInformation></s:Body></s:Envelope>';
}

function fromSoap(xml) {
  const fault = /<(?:\w+:)?Fault\b[\s\S]*?<faultstring[^>]*>([\s\S]*?)<\/faultstring>/.exec(xml);
  if (fault) return errorReply('BC SOAP fault: ' + fault[1]);
  const m = /<(\w+:)?GetErpInformationResult\b([^>]*)>([\s\S]*)<\/\1?GetErpInformationResult>/.exec(xml);
  if (!m) return xml; // already a plain reply
  return '<?xml version="1.0"?>\n<GetErpInformationReply xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + m[3] + '</GetErpInformationReply>';
}

/* ---------- BC TKAT API (OData unbound actions) ---------- */
function bcAction(name, customerNo, skus) {
  const u = new URL(cfg.bcBase.replace(/\/$/, '') + '/ODataV4/TKATApiMgmt_' + name + '/?company=' + encodeURIComponent(cfg.bcCompany));
  const body = JSON.stringify({ customerNo, data: JSON.stringify({ items: skus.map(itemNo => ({ itemNo })) }) });
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      Authorization: 'Basic ' + Buffer.from(cfg.bcUser + ':' + cfg.bcPassword).toString('base64') };
    const r = lib.request(u, { method: 'POST', headers, timeout: 15000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(name + ' HTTP ' + res.statusCode));
        try { const j = JSON.parse(txt); let v = j.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) {} } resolve(v); }
        catch (e) { reject(new Error(name + ' invalid JSON')); }
      });
    });
    r.on('timeout', () => r.destroy(new Error(name + ' timeout')));
    r.on('error', reject);
    r.end(body);
  });
}
/* Field mapping per "TKAT API Management Documentation" (codeunit 50048 "TKAT API Mgmt. TQBC") and real BC replies. */
function unwrap(v, method) {
  const r = v && typeof v === 'object' ? (v[method + 'Result'] || Object.values(v).find(x => x && typeof x === 'object' && 'items' in x)) : null;
  if (!r) throw new Error(method + ': unexpected reply');
  if (String(r.status).toUpperCase() !== 'OK') throw new Error(method + ': ' + (r.errorDescription || r.status));
  return r.items || [];
}
function mapPrices(v) {
  const out = {};
  for (const r of unwrap(v, 'itemPriceList')) {
    if (!r.itemNo) continue;
    const price = +r.price || 0, disc = +r.discountPct || 0, vat = r.vat == null ? 25 : +r.vat;
    out[String(r.itemNo)] = price > 0 ? { price, disc, vat, incl: r.priceInclVat !== false, cur: r.priceCurrency || 'EUR', action: !!r.itemOnAction,
      actionTo: r.actionToDate || '', customer: Math.round(price * (100 - disc)) / 100 } : { restrictedPrice: true };
  }
  return out;
}
function mapStock(v) {
  const out = {};
  for (const r of unwrap(v, 'itemStockList')) {
    if (!r.itemNo) continue;
    const loc = String(r.locationCode || ''), store = String(r.storeCode || '');
    const name = loc && store && loc !== store ? store + ' na skl. *' + loc + '* - ' + (r.address || '') : (store || loc) + '  - ' + (r.address || '');
    (out[String(r.itemNo)] = out[String(r.itemNo)] || []).push({ loc, name, qty: Math.max(0, +r.availableInventory || 0), def: false });
  }
  return out;
}
function mapPartnerStock(v) {
  const out = {};
  for (const r of unwrap(v, 'itemPartnerStockList')) {
    if (!r.itemNo) continue;
    const partner = String(r.partnerCode || 'PARTNER'), loc = String(r.locationCode || '');
    (out[String(r.itemNo)] = out[String(r.itemNo)] || []).push({ loc: 'PARTNER:' + partner + ':' + loc, name: partner + ' – skladište ' + loc,
      qty: Math.max(0, +r.inventory || 0), def: false, partner });
  }
  return out;
}
function mapRestriction(v) {
  const out = {};
  for (const r of unwrap(v, 'itemStockList')) if (r.itemNo) out[String(r.itemNo)] = !!r.isRestricted;
  return out;
}
const S_MAT = 'bc13a0a1-e6f7-9f45-0bc1-5892b1d4663e', S_DOST = '86e0a0a3-61b5-16cd-edd7-322dee5a64a7', S_NE = '4f29804c-ca7a-9ec3-2f03-e0230a4deb79', S_NO = 'dd73b12f-c171-d4ba-785f-e5f77d902eed', S_BARTOG = 'b12e7a03-60d7-61a5-c5d1-eac1633d60bb';
const STATES = '<AvailabilityStates><AvailabilityState><Guid>' + S_MAT + '</Guid><Type>2</Type><ShortDescription>Matična</ShortDescription><Description>Dostupno u matičnoj poslovnici</Description></AvailabilityState>' +
  '<AvailabilityState><Guid>' + S_DOST + '</Guid><Type>2</Type><ShortDescription>Dostupno</ShortDescription><Description>Dostupno</Description></AvailabilityState>' +
  '<AvailabilityState><Guid>' + S_NE + '</Guid><Type>4</Type><ShortDescription>Nedost.</ShortDescription><Description>Nedostupno</Description></AvailabilityState>' +
  '<AvailabilityState><Guid>' + S_BARTOG + '</Guid><Type>2</Type><ShortDescription>BARTOG</ShortDescription><Description>BARTOG</Description></AvailabilityState>' +
  '<AvailabilityState><Guid>' + S_NO + '</Guid><Type>10</Type><ShortDescription>Nije moguće naručiti</ShortDescription><Description>Nije moguće naručiti</Description></AvailabilityState></AvailabilityStates>';
async function answerFromBcApi(reqXml, customerNo) {
  const arts = [...reqXml.matchAll(/<ArticleTmf>[\s\S]*?<Guid>([^<]+)<\/Guid>[\s\S]*?<ArticleIdErp>([^<]*)<\/ArticleIdErp>[\s\S]*?<\/ArticleTmf>/g)].map(m => ({ guid: m[1], sku: m[2].trim() }));
  const skus = [...new Set(arts.map(a => a.sku).filter(Boolean))];
  const [pv, sv, rv, ps] = await Promise.all([bcAction('GetItemsPrice', customerNo, skus), bcAction('GetItemsStock', customerNo, skus),
    bcAction('GetItemsRestricition', customerNo, skus).catch(() => null), bcAction('GetItemsPartnerStock', customerNo, skus).catch(() => null)]);
  const P = mapPrices(pv), W = mapStock(sv), R = rv ? mapRestriction(rv) : {}, PS = ps ? mapPartnerStock(ps) : {};
  const infos = arts.map((a, i) => {
    const p = P[a.sku], w = (W[a.sku] || []).concat(PS[a.sku] || []), restricted = R[a.sku] === true;
    const price = (type, desc, value, reb) => '<Price><Guid>' + crypto.randomUUID() + '</Guid><Type>' + type + '</Type><Description>' + desc + '</Description><Value>' + value.toFixed(2) +
      '</Value><RebateProcent>' + reb + '</RebateProcent><CurrencyCode_Iso_4217>' + xe(p.cur) + '</CurrencyCode_Iso_4217><VAT>' + p.vat + '</VAT><TaxIncluded>' + p.incl + '</TaxIncluded></Price>';
    const prices = (!p || p.restrictedPrice) ? '<Prices />' : '<Prices>' + price(4, p.incl ? 'MPC s popustom' : 'VPC s popustom', p.customer, p.disc) + price(5, p.incl ? 'MPC' : 'VPC', p.price, 0) + '</Prices>';
    const memo = p && p.action ? '<Memos><Memo><Type>0</Type><Text>Akcija' + (p.actionTo ? ' do ' + xe(p.actionTo) : '') + '</Text></Memo></Memos>' : '';
    const mat = w.some(x => x.def && x.qty > 0), any = w.some(x => x.qty > 0);
    const whs = '<Warehouses>' + w.map(x => '<Warehouse><Guid>' + crypto.randomUUID() + '</Guid><Id>' + xe(x.loc) + '</Id><Name>' + xe(x.name) + '</Name><Quantities><Quantity><Value>' + Math.min(x.qty, 10).toFixed(1) +
      '</Value><AvailabilityState><Guid>' + (x.qty > 0 ? (x.partner === 'BARTOG' ? S_BARTOG : S_DOST) : S_NE) + '</Guid><Type>AvailabilityState</Type></AvailabilityState></Quantity></Quantities><IsDefault>' + x.def + '</IsDefault></Warehouse>').join('') + '</Warehouses>';
    return '<ErpInformation><Guid>00000000-0000-0000-0000-000000000000</Guid><Item><Guid>' + xe(a.guid) + '</Guid><Type>ArticleTmf</Type></Item><RequestedQuantity>1.0</RequestedQuantity><SortId>' + i + '</SortId>' +
      '<AvailabilityState><Guid>' + (restricted ? S_NO : mat ? S_MAT : any ? S_DOST : S_NE) + '</Guid><Type>AvailabilityState</Type></AvailabilityState>' + prices + whs + memo + '</ErpInformation>';
  }).join('');
  const md = (reqXml.match(/<MasterData>[\s\S]*?<\/MasterData>/) || ['<MasterData />'])[0].replace(/<AvailabilityStates\s*\/>|<AvailabilityStates>[\s\S]*?<\/AvailabilityStates>/, STATES);
  return '<?xml version="1.0"?>\n<GetErpInformationReply xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><StatusId>0</StatusId><ErrorMessage>OK</ErrorMessage><TimeStamp>' +
    new Date().toISOString() + '</TimeStamp>' + md + '<ErpArticleInformation>' + infos + '</ErpArticleInformation><TypeId>1</TypeId></GetErpInformationReply>';
}

function postBc(payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.bcUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': cfg.mode === 'soap' ? 'text/xml; charset=utf-8' : 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) };
    if (cfg.mode === 'soap') headers.SOAPAction = '"' + cfg.soapAction + '"';
    if (cfg.bcAuthHeader) headers.Authorization = cfg.bcAuthHeader;
    const r = lib.request(u, { method: 'POST', headers, timeout: 15000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('BC timeout')));
    r.on('error', reject);
    r.end(payload);
  });
}

async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'POST' && path === '/login') {
    // TODO: validate the customer against BC (e.g. TMConnect GetSession or a BC user check) before creating the session.
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, 'bad request'); }
    const customerId = String(b.customerId || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(customerId)) return send(res, 400, 'bad request');
    // The BC TKAT API is called with a service account + customerNo, so BC does not check the customer's password.
    // Until UNI KAT gets a real login (TKAT/Topmotive account or Tokić identity), only internal dev logins are possible.
    if (!cfg.devLogin) return send(res, 501, 'Prijava kupca još nije povezana (TKAT/Topmotive ili Tokić identitet)');
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { customerId, username: customerId, password: '', exp: Date.now() + cfg.sessionHours * 3600e3 });
    res.setHeader('Set-Cookie', 'unikat_sid=' + sid + '; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=' + cfg.sessionHours * 3600);
    return send(res, 200, JSON.stringify({ customerId }), 'application/json');
  }

  if (req.method === 'POST' && path === '/logout') {
    const m = /(?:^|;\s*)unikat_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    if (m) sessions.delete(m[1]);
    res.setHeader('Set-Cookie', 'unikat_sid=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0');
    return send(res, 204, '');
  }

  if (req.method === 'POST' && path === '/tmconnect/GetErpInformation') {
    const s = getSession(req);
    if (!s) return send(res, 401, errorReply('Niste prijavljeni'), 'application/xml; charset=utf-8');
    let xml; try { xml = await readBody(req); } catch (e) { return send(res, 413, errorReply('Upit je prevelik'), 'application/xml; charset=utf-8'); }
    if (!/<GetErpInformationRequest\b/.test(xml)) return send(res, 400, errorReply('Očekivan GetErpInformationRequest'), 'application/xml; charset=utf-8');
    if ((xml.match(/<ErpInformation>/g) || []).length > cfg.maxItems) return send(res, 400, errorReply('Previše artikala u jednom upitu'), 'application/xml; charset=utf-8');
    if (cfg.mode === 'bcapi') {
      if (!cfg.bcBase || !cfg.bcUser || !cfg.bcCompany) return send(res, 503, errorReply('BC_BASE_URL / BC_COMPANY / BC_USER nisu postavljeni'), 'application/xml; charset=utf-8');
      try { return send(res, 200, await answerFromBcApi(xml, s.customerId), 'application/xml; charset=utf-8'); }
      catch (e) { console.error('BC API failed:', e.message); return send(res, 502, errorReply('BC nije dostupan'), 'application/xml; charset=utf-8'); }
    }
    if (!cfg.bcUrl) return send(res, 503, errorReply('BC_TMCONNECT_URL nije postavljen'), 'application/xml; charset=utf-8');
    const inner = injectCredentials(xml, s);
    try {
      const r = await postBc(cfg.mode === 'soap' ? toSoap(inner) : inner);
      const reply = cfg.mode === 'soap' ? fromSoap(r.body) : r.body;
      return send(res, r.status >= 500 && !/<GetErpInformationReply/.test(reply) ? 502 : 200, reply, 'application/xml; charset=utf-8');
    } catch (e) {
      console.error('BC request failed:', e.message); // never log the request body: it contains the password
      return send(res, 502, errorReply('BC nije dostupan'), 'application/xml; charset=utf-8');
    }
  }

  if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok');
  return send(res, 404, 'not found');
}

http.createServer((req, res) => { handle(req, res).catch(e => { console.error(e.message); send(res, 500, 'error'); }); })
  .listen(cfg.port, () => console.log('UNI KAT ERP gateway on :' + cfg.port + ' [' + cfg.mode + '] → ' + (cfg.mode === 'bcapi' ? (cfg.bcBase || '(BC_BASE_URL not set)') : (cfg.bcUrl || '(BC_TMCONNECT_URL not set)'))));
