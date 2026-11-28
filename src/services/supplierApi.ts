import {
  addProduct,
  getProduct,
  getOrCreateCategory,
  getSupplierApiSource,
  getSupplierProductLinkBySupplierProduct,
  getSupplierProductLinkByProduct,
  recordSupplierOrderLog,
  setProductActive,
  updateProduct,
  updateSupplierApiSource,
  updateSupplierProductLink,
  upsertSupplierProductLink,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type {
  DBSupplierApiSource,
  DBSupplierProductLink,
  SupplierAuthMode,
  SupplierOrderMethod,
} from '../types.js';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Stock values that mean "no cap" rather than a quantity. */
const UNLIMITED_STOCK_RE = /^(unlimited|unlimited_stock|infinite|infinity|unbegrenzt|∞)$/i;
/** Finite stand-in used for unlimited supplier stock. */
const UNLIMITED_STOCK_QTY = 999_999;

export type SupplierCatalogProduct = {
  id: string;
  name: string;
  price: number | null;
  stock: number | null;
  raw: Record<string, unknown>;
};

export type SupplierImportResult = {
  localProductId: number;
  created: boolean;
  link: DBSupplierProductLink;
};

export type SupplierConnectionTest = {
  ok: boolean;
  balance: number | null;
  productsSeen: number;
  sampleProducts: SupplierCatalogProduct[];
  error: string | null;
};

export type SupplierOrderResult = {
  ok: boolean;
  items: string[];
  status: string | null;
  error: string | null;
  raw: Record<string, unknown>;
};

export type SupplierAutoOrderFailure = {
  supplierId: number;
  supplierName: string;
  supplierProductId: string;
  error: string;
  lowBalance: boolean;
};

export type SupplierSourceConfig = {
  name: string;
  base_url: string;
  api_key?: string;
  auth_mode?: SupplierAuthMode;
  key_header?: string;
  key_query_param?: string;
  products_path?: string;
  balance_path?: string;
  order_path?: string;
  order_method?: SupplierOrderMethod;
  balance_json_path?: string;
  products_json_path?: string;
  product_id_json_path?: string;
  product_name_json_path?: string;
  product_price_json_path?: string;
  product_stock_json_path?: string;
  order_items_json_path?: string;
  order_status_json_path?: string;
  order_request_template?: Record<string, unknown>;
  auto_import_new_products?: boolean;
  auto_import_active?: boolean;
  import_category_name?: string | null;
  markup_percent?: number;
  fixed_markup?: number;
  low_balance_threshold?: number;
  notes?: string | null;
};

const LEGACY_SUPPLIER_HOSTS: Record<string, string> = {
  'insightxstore-bot-production.up.railway.app': 'api.insightxpro.store',
};

export function resolveSupplierBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const replacement = LEGACY_SUPPLIER_HOSTS[url.hostname.toLowerCase()];
    if (!replacement) return baseUrl;
    url.hostname = replacement;
    return url.toString().replace(/\/$/, '');
  } catch {
    return baseUrl;
  }
}

export type SupplierLinkConfig = {
  local_product_id: number;
  supplier_id: number;
  supplier_product_id: string;
  supplier_product_name?: string | null;
  supplier_cost?: number | null;
  supplier_stock?: number | null;
  auto_order?: boolean;
  auto_sync_stock?: boolean;
  fallback_manual?: boolean;
};

export class SupplierApiError extends Error {
  /** Set when the supplier answered 429; how long to wait before retrying. */
  retryAfterMs?: number;

  constructor(message: string) {
    super(message);
  }
}

export function canbosoSupplierConfig(apiKey: string): SupplierSourceConfig {
  return {
    name: 'Canboso',
    base_url: 'https://canboso.com',
    api_key: apiKey.trim(),
    auth_mode: 'query',
    key_query_param: 'key',
    products_path: '/api/v2/telegram-buyer/products',
    balance_path: '/api/v2/telegram-buyer/balance',
    order_path: '/api/v2/telegram-buyer/purchase',
    order_method: 'POST',
    products_json_path: 'products',
    balance_json_path: 'balanceUsd',
    product_id_json_path: '_id',
    product_name_json_path: 'product_name',
    product_price_json_path: 'usdPricing',
    product_stock_json_path: 'stats.available',
    order_items_json_path: 'deliveredAccounts',
    order_status_json_path: 'success',
    order_request_template: {
      key: '{{api_key}}',
      product_id: '{{supplier_product_id}}',
      quantity: '{{qty}}',
    },
    markup_percent: 25,
    fixed_markup: 0,
    low_balance_threshold: 5,
    auto_import_new_products: false,
    auto_import_active: false,
    import_category_name: 'Canboso Supplier',
    notes: 'One-click Canboso v2 telegram-buyer supplier connector.',
  };
}
export function insightxSupplierConfig(apiKey: string): SupplierSourceConfig {
  return {
    name: 'InsightX Store',
    base_url: 'https://api.insightxpro.store',
    api_key: apiKey.trim(),
    auth_mode: 'bearer',
    products_path: '/api/v1/products',
    balance_path: '/api/v1/balance',
    order_path: '/api/v1/orders',
    order_method: 'POST',
    products_json_path: 'products',
    balance_json_path: 'balance_usdt',
    product_id_json_path: 'id',
    product_name_json_path: 'name',
    product_price_json_path: 'price_usdt',
    product_stock_json_path: 'stock',
    order_request_template: {
      product_id: '{{supplier_product_id}}',
      quantity: '{{qty}}',
    },
    order_items_json_path: 'order.codes',
    order_status_json_path: 'order.status',
    markup_percent: 25,
    fixed_markup: 0,
    low_balance_threshold: 5,
    auto_import_new_products: false,
    auto_import_active: false,
    import_category_name: 'InsightX Store Supplier',
    notes: 'One-click InsightX Store supplier connector.',
  };
}

export function tunVnMmoSupplierConfig(apiKey: string): SupplierSourceConfig {
  return {
    name: 'TunVN MMO',
    base_url: 'https://tunvnmmo.duckdns.org',
    api_key: apiKey.trim(),
    auth_mode: 'x-api-key',
    key_header: 'X-API-Key',
    products_path: '/api/products',
    balance_path: '/api/balance',
    order_path: '/api/buy',
    order_method: 'POST',
    products_json_path: 'products',
    balance_json_path: 'balance_usdt',
    product_id_json_path: 'id',
    product_name_json_path: 'name',
    product_price_json_path: 'price_usdt',
    product_stock_json_path: 'stock',
    order_items_json_path: 'items',
    order_status_json_path: 'success',
    order_request_template: {
      product_id: '{{supplier_product_id}}',
      quantity: '{{qty}}',
      currency: 'usdt',
    },
    markup_percent: 25,
    fixed_markup: 0,
    low_balance_threshold: 5,
    auto_import_new_products: false,
    auto_import_active: false,
    import_category_name: 'TunVN MMO Products',
    notes: 'One-click connector for the TunVN MMO Shop Bot API.',
  };
}

export function supabaseResellerSupplierConfig(apiKey: string): SupplierSourceConfig {
  return {
    name: 'ZYRON Reseller API',
    base_url: 'https://eygkdpfjrjwwbiackfpr.supabase.co/functions/v1/reseller-api',
    api_key: apiKey.trim(),
    auth_mode: 'bearer',
    products_path: '?action=products',
    balance_path: '?action=balance',
    order_path: '?action=order',
    order_method: 'POST',
    products_json_path: 'products',
    balance_json_path: 'reseller.balance',
    product_id_json_path: 'id',
    product_name_json_path: 'name',
    product_price_json_path: 'wholesale_price',
    product_stock_json_path: 'stock',
    order_items_json_path: 'order.items',
    order_status_json_path: 'ok',
    order_request_template: {
      product_id: '{{supplier_product_id}}',
      quantity: '{{qty}}',
      external_order_id: '{{request_id}}',
    },
    markup_percent: 25,
    fixed_markup: 0,
    low_balance_threshold: 5,
    auto_import_new_products: false,
    auto_import_active: false,
    import_category_name: 'ZYRON Reseller Products',
    notes: 'One-click Bearer-token supplier connector for Supabase reseller-api?action endpoints.',
  };
}

export function vexResellerSupplierConfig(apiKey: string): SupplierSourceConfig {
  return {
    name: 'VEX Reseller API',
    base_url: 'https://eismrrkygprctnwxmkbw.supabase.co/functions/v1/reseller-api',
    api_key: apiKey.trim(),
    auth_mode: 'bearer',
    products_path: '?action=products',
    balance_path: '?action=balance',
    order_path: '?action=order',
    order_method: 'POST',
    products_json_path: 'products',
    balance_json_path: 'balance',
    product_id_json_path: 'id',
    product_name_json_path: 'name',
    product_price_json_path: 'price',
    product_stock_json_path: 'stock',
    order_items_json_path: 'data',
    order_status_json_path: 'status',
    order_request_template: {
      product_id: '{{supplier_product_id}}',
      quantity: '{{qty}}',
      external_order_id: '{{request_id}}',
    },
    markup_percent: 25,
    fixed_markup: 0,
    low_balance_threshold: 5,
    auto_import_new_products: false,
    auto_import_active: false,
    import_category_name: 'VEX Reseller Products',
    notes: 'One-click VEX supplier connector for Supabase reseller-api?action endpoints.',
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (/^(true|yes|on|1)$/i.test(v.trim())) return true;
    if (/^(false|no|off|0)$/i.test(v.trim())) return false;
  }
  return fallback;
}

function cleanPath(path: string | null | undefined, fallback: string): string {
  const s = (path ?? '').trim();
  return s.length > 0 ? s : fallback;
}

function joinUrl(base: string, path: string): URL {
  const cleanBase = base.trim().replace(/\/+$/, '');
  const cleanSuffix = path.trim().replace(/^\/+/, '');
  if (cleanSuffix.startsWith('?') || cleanSuffix.startsWith('#')) {
    return new URL(`${cleanBase}${cleanSuffix}`);
  }
  return new URL(cleanSuffix ? `${cleanBase}/${cleanSuffix}` : cleanBase);
}

function deepGet(obj: unknown, path: string | null | undefined): unknown {
  const clean = (path ?? '').trim();
  if (!clean || clean === '$' || clean === '.') return obj;
  const parts = clean
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function firstValue(obj: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = deepGet(obj, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function supplierResponseError(json: Record<string, unknown>, status: string | null): string {
  return (
    asString(
      firstValue(json, [
        'error',
        'message',
        'reason',
        'details',
        'order.error',
        'data.error',
        'data.message',
        'data.reason',
        'response.error',
        'response.message',
      ]),
    ) ??
    (status ? `Supplier status: ${status}` : 'Supplier rejected the order')
  );
}

export function isSupplierLowBalanceMessage(message: string): boolean {
  return /balance|insufficient|not enough|low fund|wallet|credit|recharge|top[\s-]?up/i.test(message);
}

function replaceTemplate(value: unknown, vars: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    // Preserve the original variable type when the whole field is one
    // placeholder. Supplier schemas commonly require quantity/order_id
    // as JSON numbers, not numeric strings.
    const exact = value.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
    if (exact) return vars[exact[1]!] ?? '';
    return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
      String(vars[key] ?? ''),
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceTemplate(item, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceTemplate(val, vars);
    }
    return out;
  }
  return value;
}

function authHeaders(source: DBSupplierApiSource): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const key = source.api_key.trim();
  if (!key) return headers;
  if (source.auth_mode === 'bearer') headers.authorization = `Bearer ${key}`;
  if (source.auth_mode === 'x-api-key') headers[source.key_header || 'x-api-key'] = key;
  return headers;
}

/**
 * One request, retried when the supplier answers 429.
 *
 * Suppliers cap requests per minute (LaraStock: 30). A burst elsewhere can
 * leave a real purchase rejected even though the buyer has already been
 * charged, so a rate-limited call waits and tries again rather than failing
 * the order outright. Retries honour Retry-After when the supplier sends it.
 */
const RATE_LIMIT_RETRIES = 3;

async function supplierFetch(
  source: DBSupplierApiSource,
  path: string,
  method: SupplierOrderMethod = 'GET',
  payload?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await supplierFetchOnce(source, path, method, payload, extraHeaders);
    } catch (err) {
      lastErr = err;
      const retryAfter = err instanceof SupplierApiError ? err.retryAfterMs : undefined;
      if (retryAfter === undefined || attempt === RATE_LIMIT_RETRIES) throw err;
      logger.warn(
        { supplierId: source.id, path, attempt: attempt + 1, waitMs: retryAfter },
        'supplier rate limited - retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
    }
  }
  throw lastErr;
}

async function supplierFetchOnce(
  source: DBSupplierApiSource,
  path: string,
  method: SupplierOrderMethod = 'GET',
  payload?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const url = joinUrl(resolveSupplierBaseUrl(source.base_url), path);
  if (source.auth_mode === 'query' && source.api_key.trim()) {
    url.searchParams.set(source.key_query_param || 'api_key', source.api_key.trim());
  }
  if (method === 'GET' && payload) {
    for (const [key, val] of Object.entries(payload)) {
      if (val !== undefined && val !== null) url.searchParams.set(key, String(val));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...authHeaders(source), ...extraHeaders },
      body: method === 'POST' ? JSON.stringify(payload ?? {}) : undefined,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let json: unknown = {};
    try {
      json = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      json = { raw: bodyText.slice(0, 1000) };
    }
    if (!res.ok) {
      const sample = bodyText.replace(/\s+/g, ' ').slice(0, 300);
      const error = new SupplierApiError(
        `HTTP ${res.status} from ${url.hostname}: ${sample || res.statusText}`,
      );
      if (res.status === 429) {
        const header = Number(res.headers.get('retry-after'));
        // Default to 20s: the usual window is per minute, and three tries
        // then span it without hammering the supplier.
        error.retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : 20_000;
      }
      throw error;
    }
    return json;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new SupplierApiError(`Timeout after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCatalogProduct(
  source: DBSupplierApiSource,
  raw: unknown,
): SupplierCatalogProduct | null {
  const row = asRecord(raw);
  const id = asString(
    firstValue(row, [
      source.product_id_json_path,
      'product_id',
      'id',
      'pid',
      'service_id',
      'sku',
    ]),
  );
  if (!id) return null;
  const name =
    asString(
      firstValue(row, [
        source.product_name_json_path,
        'product_name',
        'name',
        'title',
        'service',
      ]),
    ) ?? id;
  const price = asNumber(
    firstValue(row, [
      source.product_price_json_path,
      'price',
      'wholesale_price',
      'cost',
      'rate',
      'amount',
    ]),
  );
  const rawStock = firstValue(row, [
    source.product_stock_json_path,
    'stock',
    'quantity',
    'qty',
    'available',
    'count',
  ]);
  // Some suppliers report an uncapped product as the string "unlimited"
  // (LaraStock) or "∞" instead of a number. asNumber() yields null for
  // those, which would import the product with 0 stock and make it
  // unsellable, so they are mapped to a large finite quantity instead.
  const stock = UNLIMITED_STOCK_RE.test(String(rawStock ?? '').trim())
    ? UNLIMITED_STOCK_QTY
    : asNumber(rawStock);
  return {
    id,
    name,
    price,
    stock: stock === null ? null : Math.max(0, Math.floor(stock)),
    raw: row,
  };
}

export async function fetchSupplierBalance(
  source: DBSupplierApiSource,
): Promise<number | null> {
  const json = await supplierFetch(source, cleanPath(source.balance_path, '/balance'));
  return asNumber(
    firstValue(json, [
      source.balance_json_path,
      'balance',
      'api_balance',
      'reseller.balance',
      'reseller.api_balance',
      'wallet.balance',
      'data.balance',
      'data.api_balance',
    ]),
  );
}

/**
 * Short-lived catalogue cache.
 *
 * Suppliers rate-limit (LaraStock allows 30 requests/minute) and the stock
 * sync used to pull the whole catalogue once per linked product - 61 identical
 * requests every five minutes, which exhausted the budget and made real
 * purchases fail with HTTP 429. One fetch now serves every caller in the
 * window, and `force` is there for a caller that must see fresh stock.
 */
const CATALOG_CACHE_MS = 60_000;
const catalogCache = new Map<
  number,
  { at: number; products: SupplierCatalogProduct[] }
>();

export function invalidateSupplierCatalog(supplierId: number): void {
  catalogCache.delete(supplierId);
}

export async function fetchSupplierProducts(
  source: DBSupplierApiSource,
  opts: { force?: boolean } = {},
): Promise<SupplierCatalogProduct[]> {
  const hit = catalogCache.get(source.id);
  if (!opts.force && hit && Date.now() - hit.at < CATALOG_CACHE_MS) return hit.products;
  const json = await supplierFetch(source, cleanPath(source.products_path, '/products'));
  const rawProducts =
    deepGet(json, source.products_json_path) ??
    deepGet(json, 'products') ??
    deepGet(json, 'data.products') ??
    deepGet(json, 'data') ??
    json;
  const arr = Array.isArray(rawProducts) ? rawProducts : [];
  const products = arr
    .map((p) => normalizeCatalogProduct(source, p))
    .filter((p): p is SupplierCatalogProduct => p !== null);
  catalogCache.set(source.id, { at: Date.now(), products });
  return products;
}

export async function fetchSupplierOrders(
  source: DBSupplierApiSource,
  orderId?: string,
): Promise<unknown> {
  const basePath = cleanPath(source.order_path, '/orders');
  const path = orderId
    ? `${basePath.replace(/\/+$/, '')}/${encodeURIComponent(orderId)}`
    : basePath;
  return supplierFetch(source, path);
}

export function supplierSellPrice(
  source: DBSupplierApiSource,
  product: SupplierCatalogProduct,
): number {
  const base = Number(product.price ?? 0);
  return Number(
    (base * (1 + Number(source.markup_percent) / 100) + Number(source.fixed_markup)).toFixed(3),
  );
}

/**
 * Fallback glyph for an imported product, by name.
 *
 * Suppliers often send a `custom_emoji_id` from an emoji pack this bot
 * cannot resolve. Telegram drops an icon it cannot resolve without raising
 * an error, which leaves the button with no glyph at all, so a plain
 * unicode emoji is stored as well - it renders for every user, premium or
 * not.
 */
const SUPPLIER_EMOJI_RULES: Array<[RegExp, string]> = [
  [/chatgpt|openai/i, '\u{1F7E2}'],
  [/claude/i, '\u{1F9E0}'],
  [/gemini|google ai|antigravity/i, '\u{2728}'],
  [/grok/i, '\u{1F916}'],
  [/seedance|kling|muse/i, '\u{1F39E}'],
  [/elevenlabs|wispr/i, '\u{1F399}'],
  [/replit|bolt\.new|lovable|warp|railway|descript/i, '\u{1F4BB}'],
  [/figma|canva|adobe|framer|magic pattern|mobbin|capcut|picsart/i, '\u{1F3A8}'],
  [/spotify|apple music/i, '\u{1F3B5}'],
  [/crunchyroll|apple tv|osn|netflix|youtube/i, '\u{1F3AC}'],
  [/vpn|hotspot shield/i, '\u{1F510}'],
  [/duolingo|udemy|edx|coursera/i, '\u{1F393}'],
  [/hotmail|outlook|mail/i, '\u{1F4E7}'],
  [/notion|zoom|office|granola|ilovepdf|joinsecret|intercom|customer\.io|pangram|nitro|discord/i, '\u{1F4CA}'],
];

/** Pick the unicode glyph shown on an imported product's button. */
export function supplierEmojiFor(name: string): string {
  const hit = SUPPLIER_EMOJI_RULES.find(([rx]) => rx.test(name));
  return hit ? hit[1] : '\u{1F4E6}';
}

/**
 * Keyword routing for imported supplier products.
 *
 * Suppliers rarely send a category, so without this every product lands in
 * one bucket and the shop becomes unbrowsable as the catalogue grows. First
 * match wins, so narrower patterns come first.
 */
const SUPPLIER_CATEGORY_RULES: Array<[string, RegExp]> = [
  [
    '🤖 AI & Automation',
    /chatgpt|claude|gemini|google ai|grok|muse|seedance|kling|elevenlabs|lovable|bolt\.new|replit|descript|pangram|wispr|antigravity|perplexity|midjourney|copilot/i,
  ],
  ['🎨 Design & Creative', /figma|capcut|canva|adobe|framer|magic pattern|mobbin|picsart/i],
  ['🎬 Streaming & Music', /spotify|apple music|apple tv|crunchyroll|osn|netflix|youtube premium|deezer|shahid/i],
  ['🔐 VPN & Security', /\bvpn\b|hotspot shield|nordvpn|expressvpn|pandavpn|surfshark|proton/i],
  ['🎓 Education', /duolingo|udemy|\bedx\b|coursera|skillshare|quizlet|chegg/i],
  ['📧 Mail & Accounts', /hotmail|outlook|gmail|\bmail\b/i],
  [
    '💼 Productivity & Business',
    /notion|zoom|office 365|microsoft office|granola|ilovepdf|joinsecret|warp|railway|customer\.io|intercom|discord|nitro|slack|trello/i,
  ],
];

/** Pick the category an imported product belongs in, by its name. */
export function supplierCategoryFor(name: string, fallback: string): string {
  const hit = SUPPLIER_CATEGORY_RULES.find(([, rx]) => rx.test(name));
  return hit ? hit[0] : fallback;
}

/**
 * Pull the display fields a supplier ships alongside price and stock, so an
 * imported product arrives with its real description and its icon rather than
 * a bare placeholder.
 *
 * Suppliers disagree on names: LaraStock sends `desc_en` plus a premium
 * `custom_emoji_id`, others use `description` or `note`. The HTML variants are
 * preferred where present because they carry Telegram premium-emoji markup.
 */
export function supplierPresentation(raw: Record<string, unknown>): {
  description: string | null;
  emoji: string | null;
  emojiId: string | null;
} {
  const description =
    asString(
      firstValue(raw, [
        'desc_en_html',
        'desc_en',
        'description_html',
        'description',
        'desc',
        'desc_ar_html',
        'desc_ar',
        'description_raw',
        'note',
      ]),
    )?.trim() || null;

  const emojiId =
    asString(firstValue(raw, ['custom_emoji_id', 'emoji_id', 'customEmojiId']))?.trim() || null;

  // The plain glyph is the fallback Telegram shows when a viewer has no
  // premium emoji; it sits inside the <tg-emoji> wrapper of the HTML name.
  const nameHtml = asString(firstValue(raw, ['name_en_html', 'name_ar_html', 'name_html'])) ?? '';
  const wrapped = /<tg-emoji[^>]*>([^<]+)<\/tg-emoji>/.exec(nameHtml);
  const emoji =
    asString(firstValue(raw, ['emoji', 'icon']))?.trim() || (wrapped ? wrapped[1]!.trim() : null);

  return { description, emoji, emojiId };
}

export async function importSupplierProduct(args: {
  source: DBSupplierApiSource;
  product: SupplierCatalogProduct;
  active?: boolean;
  categoryName?: string;
}): Promise<SupplierImportResult> {
  const existing = await getSupplierProductLinkBySupplierProduct(
    args.source.id,
    args.product.id,
  ).catch((err) => {
    if (isSupplierMigrationError(err)) throw err;
    logger.warn({ err, supplierId: args.source.id, productId: args.product.id }, 'supplier import lookup failed');
    return null;
  });
  if (existing) {
    const product = await getProduct(existing.local_product_id);
    if (product) {
      return { localProductId: product.id, created: false, link: existing };
    }
  }

  // Route by product name so the catalogue stays browsable; the configured
  // import category is the fallback for anything no rule matches.
  const fallbackCategory =
    args.categoryName ?? args.source.import_category_name ?? `Supplier - ${args.source.name}`;
  const category = await getOrCreateCategory(
    supplierCategoryFor(args.product.name, fallbackCategory),
    '🔌',
  );
  const stock = args.product.stock ?? 0;
  const presentation = supplierPresentation(args.product.raw);
  const local = await addProduct({
    category_id: category.id,
    name: args.product.name,
    price: supplierSellPrice(args.source, args.product),
    stock,
    warranty: 'Supplier auto delivery',
    description: presentation.description ?? `Supplier product from ${args.source.name}.`,
    // The supplier's brand icon when it ships one, with a plain unicode
    // glyph alongside it: that glyph is the fallback Telegram shows inside
    // the <tg-emoji> wrapper, and the button label's prefix when there is
    // no custom emoji id at all.
    emoji: presentation.emoji ?? supplierEmojiFor(args.product.name),
    emoji_id: presentation.emojiId,
    unlimited_stock: false,
  });
  if (args.active === false || (args.active === undefined && args.source.auto_import_active === false)) {
    await setProductActive(local.id, false);
  }
  const link = await upsertSupplierProductLink({
    local_product_id: local.id,
    supplier_id: args.source.id,
    supplier_product_id: args.product.id,
    supplier_product_name: args.product.name,
    supplier_cost: args.product.price,
    supplier_stock: args.product.stock,
    auto_order: true,
    auto_sync_stock: true,
    fallback_manual: true,
  });
  return { localProductId: local.id, created: true, link };
}

export async function testSupplierConnection(
  source: DBSupplierApiSource,
): Promise<SupplierConnectionTest> {
  const balanceResult = await fetchSupplierBalance(source).then(
    (balance) => ({ ok: true as const, balance }),
    (err: unknown) => ({ ok: false as const, error: err }),
  );
  const productsResult = await fetchSupplierProducts(source).then(
    (products) => ({ ok: true as const, products }),
    (err: unknown) => ({ ok: false as const, error: err }),
  );
  const errors: string[] = [];
  if (!balanceResult.ok) errors.push(`balance: ${errorMessage(balanceResult.error)}`);
  if (!productsResult.ok) errors.push(`products: ${errorMessage(productsResult.error)}`);
  const products = productsResult.ok ? productsResult.products : [];
  const balance = balanceResult.ok ? balanceResult.balance : null;
  const out: SupplierConnectionTest = {
    ok: errors.length === 0,
    balance,
    productsSeen: products.length,
    sampleProducts: products.slice(0, 5),
    error: errors.length > 0 ? errors.join(' | ') : null,
  };
  await updateSupplierApiSource(source.id, {
    last_balance: balance,
    last_sync_at: new Date().toISOString(),
    last_error: out.error,
  });
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HIDDEN_DELIVERY_KEY_RX =
  /^(?:product[_-]?item[_-]?id|delivered[_-]?at|created[_-]?at|updated[_-]?at)$/i;

function sanitizeDeliveryString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return sanitizeDeliveryValue(JSON.parse(trimmed));
    } catch {
      // Keep treating it as a normal supplier payload.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.split(':', 1)[0]?.trim() ?? '';
      return !HIDDEN_DELIVERY_KEY_RX.test(key);
    })
    .join('\n')
    .trim();
}

function sanitizeDeliveryValue(value: unknown): string {
  if (typeof value === 'string') return sanitizeDeliveryString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const row = asRecord(value);
  const direct = asString(firstValue(row, ['payload', 'item', 'code', 'link', 'account']));
  if (direct) return sanitizeDeliveryString(direct);
  return Object.entries(row)
    .filter(([key, item]) => {
      if (item === null || item === undefined || item === '') return false;
      return !HIDDEN_DELIVERY_KEY_RX.test(key.replace(/\s+/g, '_'));
    })
    .map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`)
    .join('\n')
    .trim();
}

function normalizeItems(source: DBSupplierApiSource, json: Record<string, unknown>): string[] {
  // Try multiple common paths for order items
  const paths = [
    source.order_items_json_path,
    'items',
    'data.items',
    'order.items',
    'order.codes',
    'order.delivered_codes',
    'order.delivery',
    'delivery',
    'data.delivery',
    'result.items',
    'result.delivery',
    'data.data',
    'data',
    'codes',
    'accounts',
    'credentials',
    'code',
    'account',
  ];
  
  let raw: unknown = undefined;
  for (const path of paths) {
    raw = deepGet(json, path);
    if (raw !== undefined && raw !== null) break;
  }
  
  // If raw is a string, split by newlines to get multiple items
  if (typeof raw === 'string') {
    const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length > 1) {
      return lines
        .map(line => sanitizeDeliveryString(line))
        .filter(s => s.length > 0);
    }
    const clean = sanitizeDeliveryString(raw);
    return clean ? [clean] : [];
  }
  
  // If raw is an array, process each item
  if (Array.isArray(raw)) {
    return raw
      .map(item => {
        // If item is a string, sanitize it
        if (typeof item === 'string') {
          const lines = item.split(/\r?\n/);
          return lines.map(line => sanitizeDeliveryString(line)).filter(s => s.length > 0);
        }
        // If item is an object, try to extract the value
        return [sanitizeDeliveryValue(item)].filter(s => s.length > 0);
      })
      .flat()
      .filter(s => s.length > 0);
  }
  
  // If raw is an object, sanitize it
  if (raw && typeof raw === 'object') {
    return [sanitizeDeliveryValue(raw)].filter(s => s.length > 0);
  }
  
  return [];
}

/**
 * Strip the supplier API key out of an order payload before it is
 * persisted to `supplier_order_logs`. Matches both well-known
 * credential field names and any value equal to the live key.
 */
function redactSupplierSecrets(
  payload: Record<string, unknown>,
  apiKey: string,
): Record<string, unknown> {
  const secretKeys = new Set(['key', 'api_key', 'apikey', 'token', 'secret', 'authorization']);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(payload)) {
    const isSecretField = secretKeys.has(field.toLowerCase());
    const isSecretValue = apiKey.length > 0 && value === apiKey;
    out[field] = isSecretField || isSecretValue ? '***' : value;
  }
  return out;
}

export async function placeSupplierOrder(args: {
  source: DBSupplierApiSource;
  link: DBSupplierProductLink;
  qty: number;
  localOrderId: number;
  requestId?: string;
}): Promise<SupplierOrderResult> {
  const requestId = args.requestId ?? `ord_${args.localOrderId}_${Date.now()}`;
  const vars = {
    api_key: args.source.api_key.trim(),
    supplier_product_id: args.link.supplier_product_id,
    local_product_id: args.link.local_product_id,
    qty: args.qty,
    quantity: args.qty,
    order_id: args.localOrderId,
    request_id: requestId,
  };
  const payload = asRecord(replaceTemplate(args.source.order_request_template, vars));
  // Order templates may inject the supplier credential into the body
  // (e.g. Canboso's `key`). Never persist it in the order log.
  const loggedPayload = redactSupplierSecrets(payload, args.source.api_key.trim());
  try {
    const rawJson = await supplierFetch(
      args.source,
      cleanPath(args.source.order_path, '/order'),
      args.source.order_method,
      payload,
      { 'Idempotency-Key': requestId },
    );
    const json = asRecord(rawJson);
    const statusValue =
      firstValue(json, [
        args.source.order_status_json_path,
        'status',
        'data.status',
        'order.status',
        'success',
        'ok',
      ]);
    const status =
      asString(
        statusValue,
      ) ?? null;
    const failed =
      statusValue === false ||
      statusValue === 0 ||
      (status ? /^(false|0)$|fail|error|reject|cancel/i.test(status) : false);
    const items = normalizeItems(args.source, json);
    const error = failed ? supplierResponseError(json, status) : null;
    
    // Log order result for debugging
    logger.info({ 
      supplierName: args.source.name,
      localOrderId: args.localOrderId,
      requestedQty: args.qty,
      receivedItems: items.length,
      itemsPreview: items.slice(0, 5),
      status,
      ok: !failed,
      rawJsonKeys: Object.keys(json),
      rawJsonString: JSON.stringify(json).slice(0, 1000)
    }, 'placeSupplierOrder result');
    
    await recordSupplierOrderLog({
      supplier_id: args.source.id,
      local_order_id: args.localOrderId,
      local_product_id: args.link.local_product_id,
      supplier_product_id: args.link.supplier_product_id,
      status: failed ? 'failed' : 'success',
      request_payload: loggedPayload,
      response_payload: Array.isArray(rawJson) ? { data: rawJson } : json,
      error,
    });
    return { ok: !failed, items, status, error, raw: Array.isArray(rawJson) ? { data: rawJson } : json };
  } catch (err) {
    const msg = errorMessage(err);
    await recordSupplierOrderLog({
      supplier_id: args.source.id,
      local_order_id: args.localOrderId,
      local_product_id: args.link.local_product_id,
      supplier_product_id: args.link.supplier_product_id,
      status: 'failed',
      request_payload: loggedPayload,
      response_payload: {},
      error: msg,
    }).catch((logErr) => logger.warn({ err: logErr }, 'supplier order failure log failed'));
    throw err;
  }
}

/**
 * Can the supplier actually fulfil this order right now?
 *
 * The buyer's wallet is charged before the supplier order is placed, and a
 * supplier failure leaves the order on the manual-delivery placeholder - so
 * without this check a buyer pays and receives nothing until the admin
 * refunds by hand. The commonest cause by far is the reseller account
 * running out of balance, which is knowable up front.
 *
 * Returns ok:true for anything not auto-ordered from a supplier, so normal
 * stock-pool products are unaffected.
 */
const BALANCE_CACHE_MS = 60_000;
const balanceCache = new Map<number, { value: number | null; at: number }>();

async function cachedSupplierBalance(
  source: DBSupplierApiSource,
): Promise<number | null> {
  const hit = balanceCache.get(source.id);
  if (hit && Date.now() - hit.at < BALANCE_CACHE_MS) return hit.value;
  let value: number | null = null;
  try {
    value = await fetchSupplierBalance(source);
  } catch (err) {
    logger.warn({ err, supplierId: source.id }, 'supplier balance check failed');
    value = null;
  }
  balanceCache.set(source.id, { value, at: Date.now() });
  return value;
}

/** Clear the cached balance, e.g. right after an order spends from it. */
export function invalidateSupplierBalance(supplierId: number): void {
  balanceCache.delete(supplierId);
}

export async function supplierCanFulfill(args: {
  localProductId: number;
  qty: number;
}): Promise<{ ok: boolean; needed: number; available: number }> {
  const pass = { ok: true, needed: 0, available: 0 };
  const link = await getSupplierProductLinkByProduct(args.localProductId).catch(() => null);
  if (!link || !link.auto_order) return pass;
  const source = await getSupplierApiSource(link.supplier_id);
  if (!source || !source.enabled) return pass;
  const cost = Number(link.supplier_cost ?? 0);
  if (!Number.isFinite(cost) || cost <= 0) return pass;
  const balance = await cachedSupplierBalance(source);
  // An unreadable balance must not block sales: fall through and let the
  // order attempt decide, exactly as before this check existed.
  if (balance === null) return pass;
  const needed = cost * args.qty;
  if (balance + 1e-9 >= needed) return { ok: true, needed, available: balance };
  return { ok: false, needed, available: balance };
}

export async function trySupplierAutoOrder(args: {
  localProductId: number;
  qty: number;
  localOrderId: number;
  onFailure?: (failure: SupplierAutoOrderFailure) => void | Promise<void>;
}): Promise<{ items: string[]; status: string | null; supplierName: string } | null> {
  const link = await getSupplierProductLinkByProduct(args.localProductId).catch((err) => {
    if (isSupplierMigrationError(err)) {
      logger.debug('supplier tables not migrated; normal checkout fallback remains active');
      return null;
    }
    logger.warn({ err, localProductId: args.localProductId }, 'supplier link lookup failed');
    return null;
  });
  if (!link || !link.auto_order) return null;
  const source = await getSupplierApiSource(link.supplier_id);
  if (!source || !source.enabled) return null;
  try {
    const result = await placeSupplierOrder({
      source,
      link,
      qty: args.qty,
      localOrderId: args.localOrderId,
    });
    if (!result.ok) {
      const error = result.error ?? `Supplier status: ${result.status ?? 'failed'}`;
      await updateSupplierProductLink(link.id, {
        last_error: error,
      }).catch((updateErr) => logger.warn({ err: updateErr }, 'supplier link error update failed'));
      await args.onFailure?.({
        supplierId: source.id,
        supplierName: source.name,
        supplierProductId: link.supplier_product_id,
        error,
        lowBalance: isSupplierLowBalanceMessage(error),
      });
      return null;
    }
    // A supplier can answer "success" while delivering no codes: LaraStock
    // returns status `pending_manual` with an order id for products its own
    // admin fulfils by hand. Completing the local order on that response
    // would charge the buyer and hand them nothing, so it is treated as a
    // failed auto-order and the normal manual-delivery path takes over.
    if (result.items.length === 0) {
      const supplierOrderId =
        asString(firstValue(result.raw, ['order_id', 'order.id', 'data.order_id', 'id'])) ?? null;
      const error = [
        `Supplier accepted the order but returned no items (status: ${result.status ?? 'unknown'}).`,
        supplierOrderId ? `Supplier order id: ${supplierOrderId}.` : null,
        'Deliver this one manually.',
      ]
        .filter(Boolean)
        .join(' ');
      await updateSupplierProductLink(link.id, { last_error: error }).catch((updateErr) =>
        logger.warn({ err: updateErr }, 'supplier link error update failed'),
      );
      await args.onFailure?.({
        supplierId: source.id,
        supplierName: source.name,
        supplierProductId: link.supplier_product_id,
        error,
        lowBalance: false,
      });
      return null;
    }
    invalidateSupplierBalance(source.id);
    return { items: result.items, status: result.status, supplierName: source.name };
  } catch (err) {
    const error = errorMessage(err);
    logger.warn(
      { err, localProductId: args.localProductId, orderId: args.localOrderId, supplierId: source.id },
      'supplier auto-order failed; falling back to local/manual delivery',
    );
    await updateSupplierProductLink(link.id, {
      last_error: error,
    }).catch((updateErr) => logger.warn({ err: updateErr }, 'supplier link error update failed'));
    await args.onFailure?.({
      supplierId: source.id,
      supplierName: source.name,
      supplierProductId: link.supplier_product_id,
      error,
      lowBalance: isSupplierLowBalanceMessage(error),
    });
    return null;
  }
}

export async function syncSupplierProductLink(
  link: DBSupplierProductLink,
  // Supplied by the bulk sync, which fetches the catalogue once per source.
  preloaded?: { source: DBSupplierApiSource; products: SupplierCatalogProduct[] },
): Promise<{
  matched: SupplierCatalogProduct | null;
  updatedLocal: boolean;
}> {
  const source = preloaded?.source ?? (await getSupplierApiSource(link.supplier_id));
  if (!source) throw new SupplierApiError('Supplier not found.');
  const products = preloaded?.products ?? (await fetchSupplierProducts(source));
  const matched = products.find((p) => p.id === link.supplier_product_id) ?? null;
  if (!matched) {
    await updateSupplierProductLink(link.id, {
      last_error: 'Supplier product id not found in catalog.',
    });
    return { matched: null, updatedLocal: false };
  }
  await updateSupplierProductLink(link.id, {
    supplier_product_name: matched.name,
    supplier_cost: matched.price,
    supplier_stock: matched.stock,
    last_sync_at: new Date().toISOString(),
    last_error: null,
  });
  let updatedLocal = false;
  const local = await getProduct(link.local_product_id);
  if (local && link.auto_sync_stock && matched.stock !== null) {
    await updateProduct(link.local_product_id, { stock: matched.stock });
    updatedLocal = true;
  }
  return { matched, updatedLocal };
}

export function isSupplierMigrationError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const body = [e?.code, e?.message, e?.details, e?.hint].map(String).join(' ');
  return (
    body.includes('42P01') ||
    body.includes('42703') ||
    /supplier_(api_sources|product_links|order_logs)/i.test(body) ||
    /relation .* does not exist/i.test(body) ||
    /schema cache/i.test(body)
  );
}

export function parseSupplierSourceConfig(text: string): SupplierSourceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SupplierApiError('Send valid JSON. Use double quotes around keys and strings.');
  }
  const cfg = asRecord(raw);
  const name = asString(cfg.name);
  const baseUrl = asString(cfg.base_url ?? cfg.baseUrl ?? cfg.endpoint);
  if (!name) throw new SupplierApiError('Missing `name`.');
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new SupplierApiError('Missing `base_url` starting with http:// or https://.');
  }
  const authMode = asString(cfg.auth_mode ?? cfg.authMode) ?? 'x-api-key';
  if (!['none', 'bearer', 'x-api-key', 'query'].includes(authMode)) {
    throw new SupplierApiError('`auth_mode` must be one of: none, bearer, x-api-key, query.');
  }
  const orderMethod = (asString(cfg.order_method ?? cfg.orderMethod) ?? 'POST').toUpperCase();
  if (orderMethod !== 'GET' && orderMethod !== 'POST') {
    throw new SupplierApiError('`order_method` must be GET or POST.');
  }
  return {
    name,
    base_url: baseUrl,
    api_key: asString(cfg.api_key ?? cfg.apiKey ?? cfg.key) ?? '',
    auth_mode: authMode as SupplierAuthMode,
    key_header: asString(cfg.key_header ?? cfg.keyHeader) ?? 'x-api-key',
    key_query_param: asString(cfg.key_query_param ?? cfg.keyQueryParam) ?? 'api_key',
    products_path: asString(cfg.products_path ?? cfg.productsPath) ?? '/products',
    balance_path: asString(cfg.balance_path ?? cfg.balancePath) ?? '/balance',
    order_path: asString(cfg.order_path ?? cfg.orderPath) ?? '/order',
    order_method: orderMethod as SupplierOrderMethod,
    balance_json_path: asString(cfg.balance_json_path ?? cfg.balanceJsonPath) ?? 'balance',
    products_json_path: asString(cfg.products_json_path ?? cfg.productsJsonPath) ?? 'products',
    product_id_json_path: asString(cfg.product_id_json_path ?? cfg.productIdJsonPath) ?? 'id',
    product_name_json_path: asString(cfg.product_name_json_path ?? cfg.productNameJsonPath) ?? 'name',
    product_price_json_path: asString(cfg.product_price_json_path ?? cfg.productPriceJsonPath) ?? 'price',
    product_stock_json_path: asString(cfg.product_stock_json_path ?? cfg.productStockJsonPath) ?? 'stock',
    order_items_json_path: asString(cfg.order_items_json_path ?? cfg.orderItemsJsonPath) ?? 'items',
    order_status_json_path: asString(cfg.order_status_json_path ?? cfg.orderStatusJsonPath) ?? 'status',
    order_request_template: asRecord(
      cfg.order_request_template ??
        cfg.orderRequestTemplate ?? {
          product_id: '{{supplier_product_id}}',
          quantity: '{{qty}}',
          request_id: '{{request_id}}',
        },
    ),
    auto_import_new_products: asBoolean(cfg.auto_import_new_products ?? cfg.autoImportNewProducts, false),
    auto_import_active: asBoolean(cfg.auto_import_active ?? cfg.autoImportActive, false),
    import_category_name: asString(cfg.import_category_name ?? cfg.importCategoryName),
    markup_percent: asNumber(cfg.markup_percent ?? cfg.markupPercent) ?? 25,
    fixed_markup: asNumber(cfg.fixed_markup ?? cfg.fixedMarkup) ?? 0,
    low_balance_threshold: asNumber(cfg.low_balance_threshold ?? cfg.lowBalanceThreshold) ?? 5,
    notes: asString(cfg.notes),
  };
}

export function parseSupplierLinkConfig(
  text: string,
  fallbackSupplierId?: number,
): SupplierLinkConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SupplierApiError('Send valid JSON. Use double quotes around keys and strings.');
  }
  const cfg = asRecord(raw);
  const localProductId = asNumber(cfg.local_product_id ?? cfg.localProductId ?? cfg.product_id);
  const supplierId = asNumber(cfg.supplier_id ?? cfg.supplierId) ?? fallbackSupplierId ?? null;
  const supplierProductId = asString(cfg.supplier_product_id ?? cfg.supplierProductId ?? cfg.id);
  if (!localProductId || !Number.isInteger(localProductId) || localProductId <= 0) {
    throw new SupplierApiError('Missing valid `local_product_id`.');
  }
  if (!supplierId || !Number.isInteger(supplierId) || supplierId <= 0) {
    throw new SupplierApiError('Missing valid `supplier_id`.');
  }
  if (!supplierProductId) throw new SupplierApiError('Missing `supplier_product_id`.');
  return {
    local_product_id: localProductId,
    supplier_id: supplierId,
    supplier_product_id: supplierProductId,
    supplier_product_name: asString(cfg.supplier_product_name ?? cfg.supplierProductName),
    supplier_cost: asNumber(cfg.supplier_cost ?? cfg.supplierCost),
    supplier_stock: asNumber(cfg.supplier_stock ?? cfg.supplierStock),
    auto_order: asBoolean(cfg.auto_order, true),
    auto_sync_stock: asBoolean(cfg.auto_sync_stock, true),
    fallback_manual: asBoolean(cfg.fallback_manual, true),
  };
}
