'use strict';

/**
 * Agentic Commerce Protocol (ACP) — v2026-04-17
 * Spec: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
 *
 * Implements:
 *  GET  /acp/feed                              — ACP product catalog (AI agent ingestion)
 *  GET  /acp/products                          — Paginated product list
 *  GET  /acp/products/:id                      — Single product detail
 *  POST /acp/psp/tokens                        — Mock Shared Payment Token (SPT) issuance
 *  POST /acp/checkout_sessions                 — Create checkout session
 *  POST /acp/checkout_sessions/:id             — Update session (address, fulfillment, buyer)
 *  GET  /acp/checkout_sessions/:id             — Retrieve session state
 *  POST /acp/checkout_sessions/:id/complete    — Complete with payment token → places order
 *  POST /acp/checkout_sessions/:id/cancel      — Cancel session
 */

const express        = require('express');
const { randomUUID, createHash } = require('crypto');
const pool           = require('../db/pool');

const router = express.Router();

// ── ACP Constants ─────────────────────────────────────────────────────────────
const ACP_VERSION        = '2026-04-17';
const SUPPORTED_VERSIONS = ['2026-04-17', '2026-01-30', '2026-01-22', '2026-01-16'];
const CURRENCY           = 'usd';
const MERCHANT_NAME      = 'AI Shop';

// ── In-memory stores ──────────────────────────────────────────────────────────
const sessions         = new Map(); // sessionId → session object
const idempotencyStore = new Map(); // key → { bodyHash, statusCode, body, inFlight, timestamp }
const pspTokens        = new Map(); // token → { instrument, used, created_at }

// Prune idempotency keys older than 24 h — spec §6 requires retention for at least 24 h
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of idempotencyStore) {
    if (v.timestamp < cutoff) idempotencyStore.delete(k);
  }
}, 60 * 60 * 1000).unref();

// Prune expired PSP tokens (15-minute TTL)
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pspTokens) {
    if (!v.used && new Date(v.created_at).getTime() < cutoff) pspTokens.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ── Money helpers (spec: all amounts are integers in minor units) ──────────────
function toCents(dollars) {
  return Math.round(parseFloat(dollars) * 100);
}
function toDisplay(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

// ── Misc helpers ──────────────────────────────────────────────────────────────
function hashBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? '')).digest('hex');
}

function acpError(type, code, message, param) {
  const obj = { type, code, message };
  if (param) obj.param = param;
  return obj;
}

function getBaseUrl(req) {
  return req.app.get('baseUrl') || '';
}

// ── Fulfillment helpers ───────────────────────────────────────────────────────
function shippingCents(subtotalCents) {
  return subtotalCents >= 5000 ? 0 : 999; // Free over $50, else $9.99
}

function buildFulfillmentOptions(subtotalCents) {
  const standardCost = shippingCents(subtotalCents);
  return [
    {
      id:                    'shipping_standard',
      type:                  'shipping',
      title:                 standardCost === 0 ? 'Free Standard Shipping' : 'Standard Shipping',
      description:           '5–7 business days via USPS',
      carrier:               'USPS',
      earliest_delivery_time: new Date(Date.now() + 5 * 86400000).toISOString(),
      latest_delivery_time:   new Date(Date.now() + 7 * 86400000).toISOString(),
      totals: [
        { type: 'fulfillment', display_text: 'Standard Shipping', amount: standardCost },
      ],
    },
    {
      id:                    'shipping_express',
      type:                  'shipping',
      title:                 'Express Shipping',
      description:           '2–3 business days via UPS',
      carrier:               'UPS',
      earliest_delivery_time: new Date(Date.now() + 2 * 86400000).toISOString(),
      latest_delivery_time:   new Date(Date.now() + 3 * 86400000).toISOString(),
      totals: [
        { type: 'fulfillment', display_text: 'Express Shipping', amount: 1499 },
      ],
    },
    {
      id:          'shipping_overnight',
      type:        'shipping',
      title:       'Overnight Shipping',
      description: 'Next business day via FedEx',
      carrier:     'FedEx',
      earliest_delivery_time: new Date(Date.now() + 1 * 86400000).toISOString(),
      latest_delivery_time:   new Date(Date.now() + 1 * 86400000).toISOString(),
      totals: [
        { type: 'fulfillment', display_text: 'Overnight Shipping', amount: 2999 },
      ],
    },
  ];
}

function recomputeTotals(session) {
  const itemsBase = session.line_items.reduce((s, li) => s + li.base_amount, 0);
  const subtotal  = itemsBase; // no item-level discounts

  // Determine active fulfillment cost
  let fulfillmentCost = shippingCents(subtotal); // default: standard
  if (session.selected_fulfillment_options.length > 0) {
    const optId = session.selected_fulfillment_options[0].option_id;
    const opt   = session.fulfillment_options.find(o => o.id === optId);
    if (opt) {
      const ft = opt.totals.find(t => t.type === 'fulfillment');
      if (ft) fulfillmentCost = ft.amount;
    }
  }

  const tax   = 0; // no tax for demo
  const total = subtotal + fulfillmentCost + tax;

  session.totals = [
    { type: 'items_base_amount', display_text: 'Items',    amount: itemsBase },
    { type: 'subtotal',          display_text: 'Subtotal', amount: subtotal  },
    { type: 'fulfillment',       display_text: 'Shipping', amount: fulfillmentCost },
    { type: 'tax',               display_text: 'Tax',      amount: tax   },
    { type: 'total',             display_text: 'Total',    amount: total },
  ];

  // Refresh fulfillment options (shipping threshold may have changed)
  session.fulfillment_options = buildFulfillmentOptions(subtotal);
}

// Derive ACP session status from the session's current data
function deriveStatus(session) {
  if (!session.line_items.length)        return 'not_ready_for_payment';
  const fd = session.fulfillment_details;
  if (!fd || !fd.email || !fd.address)   return 'not_ready_for_payment';
  const a = fd.address;
  if (!a.line_one || !a.city || !a.country || !a.postal_code) return 'not_ready_for_payment';
  return 'ready_for_payment';
}

// Build the canonical ACP session response body
function buildSessionBody(session, req) {
  const bu = getBaseUrl(req);
  const body = {
    id:       session.id,
    status:   session.status,
    currency: CURRENCY,
    line_items:                    session.line_items,
    fulfillment_details:           session.fulfillment_details || null,
    fulfillment_options:           session.fulfillment_options,
    selected_fulfillment_options:  session.selected_fulfillment_options,
    totals:   session.totals,
    messages: session.messages,
    links: [
      { rel: 'terms_of_use',   href: `${bu}/terms`   },
      { rel: 'privacy_policy', href: `${bu}/privacy` },
      { rel: 'return_policy',  href: `${bu}/returns` },
    ],
    capabilities: {
      payment: {
        handlers: [
          {
            id:                       'card_tokenized',
            name:                     'dev.acp.tokenized.card',
            version:                  '2026-01-22',
            spec:                     'https://acp.dev/handlers/tokenized.card',
            requires_delegate_payment: false,
            requires_pci_compliance:   false,
            psp:                      'ai-shop-mock-psp',
            config: {
              token_endpoint:         `${bu}/acp/psp/tokens`,
              supported_instruments:  ['card'],
            },
          },
        ],
      },
    },
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
  if (session.order) body.order = session.order;
  return body;
}

// ── Idempotency helpers ───────────────────────────────────────────────────────
function saveIdempotent(req, statusCode, body) {
  if (!req._idempotencyKey) return;
  idempotencyStore.set(req._idempotencyKey, {
    bodyHash:  req._bodyHash,
    statusCode,
    body,
    inFlight:  false,
    timestamp: Date.now(),
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────

/** Validate the client's API-Version header, if one was sent */
function mwVersion(req, res, next) {
  const v = req.headers['api-version'];
  if (!v) return next();
  if (!SUPPORTED_VERSIONS.includes(v)) {
    return res.status(400).json({
      ...acpError('invalid_request', 'unsupported_api_version',
        `API version "${v}" is not supported.`),
      supported_versions: SUPPORTED_VERSIONS,
    });
  }
  next();
}

/** Apply Idempotency-Key replay/conflict handling when the client sends one */
function mwIdempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();
  if (key.length > 255) {
    return res.status(400).json(acpError(
      'invalid_request', 'invalid',
      'Idempotency-Key must be 255 characters or fewer.',
      '$.headers.Idempotency-Key'
    ));
  }

  const bodyHash = hashBody(req.body);
  const existing = idempotencyStore.get(key);

  if (existing) {
    if (existing.inFlight) {
      // Spec: same key, still processing → 409 retryable
      return res.status(409).json(acpError(
        'processing_error', 'idempotency_in_flight',
        'A request with this Idempotency-Key is already in progress. Retry after a short delay.'
      ));
    }
    if (existing.bodyHash !== bodyHash) {
      // Spec: same key, different body → 422 non-retryable
      return res.status(422).json(acpError(
        'invalid_request', 'idempotency_conflict',
        'A different request body was previously submitted with this Idempotency-Key. Use a new key for a different request.'
      ));
    }
    // Spec: same key, same body → replay cached response
    return res
      .set('Idempotent-Replayed', 'true')
      .status(existing.statusCode)
      .json(existing.body);
  }

  // Mark as in-flight before processing
  idempotencyStore.set(key, { bodyHash, inFlight: true, timestamp: Date.now() });
  req._idempotencyKey = key;
  req._bodyHash       = bodyHash;
  next();
}

const GET_MW  = [mwVersion];
const POST_MW = [mwVersion, mwIdempotency];

// ═════════════════════════════════════════════════════════════════════════════
// ACP PRODUCT FEED & DISCOVERY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /acp/feed
 * Full ACP-native product catalog for AI agent ingestion.
 * Agents should call this once on startup to build a local product index.
 */
router.get('/feed', async (req, res) => {
  try {
    const [prodRes, catRes] = await Promise.all([
      pool.query(`
        SELECT p.*, c.name AS category_name, c.slug AS category_slug
        FROM shop_products p
        LEFT JOIN shop_categories c ON p.category_id = c.id
        ORDER BY p.category_id, p.name
      `),
      pool.query('SELECT * FROM shop_categories ORDER BY sort_order'),
    ]);

    const bu = getBaseUrl(req);

    const items = prodRes.rows.map(p => {
      const attrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes : {};
      return {
        // ACP item identity
        id:               String(p.id),
        checkout_item_id: String(p.id),   // pass this as items[].id to /checkout_sessions
        name:             p.name,
        slug:             p.slug,
        sku:              p.sku || '',
        brand:            p.brand || '',
        // Descriptions
        description:       p.description || p.short_description || '',
        short_description: p.short_description || '',
        // Classification
        category:          p.category_name  || '',
        category_slug:     p.category_slug  || '',
        tags:              p.tags || [],
        // Pricing (minor units + display)
        price_cents:              toCents(p.price),
        price_display:            toDisplay(toCents(p.price)),
        compare_at_price_cents:   p.compare_at_price ? toCents(p.compare_at_price) : null,
        compare_at_price_display: p.compare_at_price ? toDisplay(toCents(p.compare_at_price)) : null,
        currency:                 CURRENCY,
        // Availability
        in_stock:       !!p.in_stock,
        stock_quantity: p.stock_quantity || 0,
        // Social proof
        rating:       p.rating       ? parseFloat(p.rating)        : null,
        review_count: p.review_count ? parseInt(p.review_count, 10) : 0,
        // Merchandising
        is_featured: !!p.is_featured,
        is_new:      !!p.is_new,
        // Attributes (sizes, colors, etc.)
        attributes: attrs,
        // Links
        url:       `${bu}/product/${p.slug}`,
        image_url: p.image_url || '',
      };
    });

    res.json({
      protocol:    'acp',
      version:     ACP_VERSION,
      merchant: {
        name:         MERCHANT_NAME,
        url:          bu,
        currency:     CURRENCY,
        locale:       'en-US',
        policies: {
          shipping: 'Free shipping on orders over $50. Otherwise $9.99 flat.',
          returns:  '30-day no-questions-asked returns.',
          payment:  'No account required. Pay by card via Shared Payment Token.',
        },
      },
      feed: {
        total:      items.length,
        categories: catRes.rows.map(c => ({
          id:    String(c.id),
          name:  c.name,
          slug:  c.slug,
          icon:  c.icon,
          url:   `${bu}/catalog/${c.slug}`,
          count: c.product_count,
        })),
        items,
      },
      endpoints: {
        checkout_sessions: `${bu}/acp/checkout_sessions`,
        products:          `${bu}/acp/products`,
        search:            `${bu}/acp/products?q=`,
        discovery:         `${bu}/.well-known/acp`,
        psp_tokens:        `${bu}/acp/psp/tokens`,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json(acpError('service_unavailable', 'internal', 'Feed generation failed.'));
  }
});

/**
 * GET /acp/products
 * Paginated, filterable product list with ACP-native format.
 * Query: q, category, brand, min_price, max_price, in_stock, featured, page, limit
 */
router.get('/products', GET_MW, async (req, res) => {
  const { q, category, brand, min_price, max_price, in_stock, featured, page = '1', limit = '20' } = req.query;
  const bu       = getBaseUrl(req);
  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset   = (pageNum - 1) * limitNum;

  const params = [];
  const conds  = [];
  const bind   = v => { params.push(v); return `$${params.length}`; };

  if (q && q.trim().length >= 2) {
    const term = `%${q.trim()}%`;
    conds.push(`(p.name ILIKE ${bind(term)} OR p.brand ILIKE ${bind(term)} OR p.short_description ILIKE ${bind(term)} OR p.description ILIKE ${bind(term)})`);
  }
  if (category)           conds.push(`p.category_slug = ${bind(category)}`);
  if (brand)              conds.push(`p.brand ILIKE ${bind('%' + brand + '%')}`);
  if (min_price)          conds.push(`p.price >= ${bind(parseFloat(min_price))}`);
  if (max_price)          conds.push(`p.price <= ${bind(parseFloat(max_price))}`);
  if (in_stock === 'true')conds.push('p.in_stock = true');
  if (featured === 'true')conds.push('p.is_featured = true');

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM shop_products p ${where}`, params),
      pool.query(
        `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM shop_products p
         LEFT JOIN shop_categories c ON p.category_id = c.id
         ${where}
         ORDER BY p.is_featured DESC, p.rating DESC, p.name ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);

    res.json({
      protocol: 'acp',
      version:  ACP_VERSION,
      query:    q || null,
      pagination: {
        page:        pageNum,
        limit:       limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
      products: dataRes.rows.map(p => {
        const attrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes : {};
        return {
          id:               String(p.id),
          checkout_item_id: String(p.id),
          name:             p.name,
          slug:             p.slug,
          sku:              p.sku  || '',
          brand:            p.brand || '',
          short_description: p.short_description || '',
          category:         p.category_name  || '',
          category_slug:    p.category_slug  || '',
          tags:             p.tags || [],
          price_cents:      toCents(p.price),
          price_display:    toDisplay(toCents(p.price)),
          compare_at_price_cents: p.compare_at_price ? toCents(p.compare_at_price) : null,
          currency:         CURRENCY,
          in_stock:         !!p.in_stock,
          rating:           p.rating       ? parseFloat(p.rating)        : null,
          review_count:     p.review_count ? parseInt(p.review_count, 10) : 0,
          is_featured:      !!p.is_featured,
          is_new:           !!p.is_new,
          attributes:       attrs,
          url:              `${bu}/product/${p.slug}`,
          image_url:        p.image_url || '',
        };
      }),
    });
  } catch (err) {
    console.error('GET /acp/products error:', err.message);
    res.status(503).json(acpError('service_unavailable', 'internal', 'Product fetch failed.'));
  }
});

/**
 * GET /acp/products/:id
 * Full ACP product detail — accepts slug or numeric id.
 */
router.get('/products/:id', GET_MW, async (req, res) => {
  const bu = getBaseUrl(req);
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.slug = $1 OR p.id::text = $1`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json(acpError('invalid_request', 'not_found', `Product "${req.params.id}" not found.`));
    }
    const p     = result.rows[0];
    const attrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes : {};

    res.json({
      protocol: 'acp',
      version:  ACP_VERSION,
      product: {
        id:               String(p.id),
        checkout_item_id: String(p.id),
        name:             p.name,
        slug:             p.slug,
        sku:              p.sku  || '',
        brand:            p.brand || '',
        description:       p.description      || p.short_description || '',
        short_description: p.short_description || '',
        category:          p.category_name    || '',
        category_slug:     p.category_slug    || '',
        tags:              p.tags || [],
        price_cents:              toCents(p.price),
        price_display:            toDisplay(toCents(p.price)),
        compare_at_price_cents:   p.compare_at_price ? toCents(p.compare_at_price) : null,
        compare_at_price_display: p.compare_at_price ? toDisplay(toCents(p.compare_at_price)) : null,
        currency:       CURRENCY,
        in_stock:       !!p.in_stock,
        stock_quantity: p.stock_quantity || 0,
        rating:         p.rating       ? parseFloat(p.rating)        : null,
        review_count:   p.review_count ? parseInt(p.review_count, 10) : 0,
        is_featured:    !!p.is_featured,
        is_new:         !!p.is_new,
        attributes:     attrs,
        url:            `${bu}/product/${p.slug}`,
        image_url:      p.image_url || '',
        meta_title:      p.meta_title      || p.name,
        meta_description: p.meta_description || p.short_description || '',
      },
    });
  } catch (err) {
    res.status(503).json(acpError('service_unavailable', 'internal', 'Failed to fetch product.'));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MOCK PSP — Shared Payment Token (SPT) issuance
// In production replace this with Stripe's /v1/tokens endpoint.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /acp/psp/tokens
 * Issues a one-time Shared Payment Token from card data.
 * Does NOT require API-Version or Idempotency-Key (PSP owns this contract).
 *
 * Request: { card: { number, exp_month, exp_year, cvc, cardholder_name? } }
 * Response: { token, type: "spt", instrument: { type, last_four, expiry }, expires_at }
 */
router.post('/psp/tokens', (req, res) => {
  const { card } = req.body || {};

  if (!card || typeof card !== 'object') {
    return res.status(400).json(acpError('invalid_request', 'missing',
      'Request body must include a "card" object.', '$.card'));
  }

  const { number, exp_month, exp_year, cvc } = card;
  const missing = [];
  if (!number)    missing.push('number');
  if (!exp_month) missing.push('exp_month');
  if (!exp_year)  missing.push('exp_year');
  if (!cvc)       missing.push('cvc');
  if (missing.length) {
    return res.status(400).json(acpError('invalid_request', 'missing',
      `Card is missing required fields: ${missing.join(', ')}.`));
  }

  // Basic luhn-style mock validation (reject obvious test-fail numbers)
  const digits = String(number).replace(/\s/g, '');
  if (digits === '0000000000000000' || digits.length < 13 || digits.length > 19) {
    return res.status(422).json(acpError('invalid_request', 'invalid',
      'Card number is not valid.', '$.card.number'));
  }
  if (parseInt(exp_month, 10) < 1 || parseInt(exp_month, 10) > 12) {
    return res.status(422).json(acpError('invalid_request', 'invalid',
      'exp_month must be between 1 and 12.', '$.card.exp_month'));
  }

  const token    = `spt_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const lastFour = digits.slice(-4);
  const expiry   = `${String(exp_month).padStart(2, '0')}/${exp_year}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  pspTokens.set(token, {
    token,
    instrument:  { type: 'card', last_four: lastFour, expiry },
    used:        false,
    created_at:  new Date().toISOString(),
    expires_at:  expiresAt,
  });

  res.status(201).json({
    token,
    type:       'spt',
    instrument: { type: 'card', last_four: lastFour, expiry },
    expires_at: expiresAt,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ACP CHECKOUT SESSIONS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /acp/checkout_sessions — Create
 *
 * Required headers: API-Version, Idempotency-Key
 * Body: { items: [{ id, quantity, variant? }], buyer?, fulfillment_details? }
 *
 * items[].id can be a numeric product ID or slug.
 * Items are resolved against the database; out-of-stock items are rejected.
 */
router.post('/checkout_sessions', POST_MW, async (req, res) => {
  const bu = getBaseUrl(req);
  const { items = [], buyer, fulfillment_details } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    const body = acpError('invalid_request', 'missing',
      '"items" must be a non-empty array.', '$.items');
    saveIdempotent(req, 400, body);
    return res.status(400).json(body);
  }

  // Resolve products from DB
  const ids = items.map(i => String(i.id));
  let productRows;
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.id::text = ANY($1) OR p.slug = ANY($1)`,
      [ids]
    );
    productRows = result.rows;
  } catch (err) {
    // 5xx — spec says do NOT cache these
    if (req._idempotencyKey) idempotencyStore.delete(req._idempotencyKey);
    return res.status(503).json(acpError('service_unavailable', 'internal',
      'Database error resolving products. Please retry.'));
  }

  const byId   = new Map(productRows.map(p => [String(p.id), p]));
  const bySlug = new Map(productRows.map(p => [p.slug, p]));

  const lineItems = [];
  const messages  = [];

  for (const item of items) {
    const product = byId.get(String(item.id)) || bySlug.get(String(item.id));
    if (!product) {
      messages.push({
        type: 'error', code: 'invalid', resolution: 'requires_buyer_input',
        content_type: 'plain',
        content: `Product "${item.id}" was not found in the catalog.`,
        param: '$.items',
      });
      continue;
    }
    if (!product.in_stock) {
      messages.push({
        type: 'error', code: 'out_of_stock', resolution: 'requires_buyer_input',
        content_type: 'plain',
        content: `"${product.name}" is currently out of stock.`,
      });
      continue;
    }

    const qty        = Math.max(1, parseInt(item.quantity, 10) || 1);
    const unitAmount = toCents(product.price);
    const baseAmount = unitAmount * qty;

    lineItems.push({
      id:          String(product.id),
      name:        product.name,
      slug:        product.slug,
      brand:       product.brand || '',
      sku:         product.sku   || '',
      image_url:   product.image_url || '',
      url:         `${bu}/product/${product.slug}`,
      quantity:    qty,
      unit_amount: unitAmount,
      base_amount: baseAmount,
      discount:    0,
      subtotal:    baseAmount,
      tax:         0,
      total:       baseAmount,
      variant:     item.variant || null,
    });
  }

  if (lineItems.length === 0) {
    const body = {
      ...acpError('invalid_request', 'out_of_stock',
        'No valid in-stock items could be resolved from the provided item list.'),
      messages,
    };
    saveIdempotent(req, 422, body);
    return res.status(422).json(body);
  }

  const subtotalCents  = lineItems.reduce((s, li) => s + li.subtotal, 0);
  const shippingCost   = shippingCents(subtotalCents);

  const session = {
    id:                           randomUUID(),
    line_items:                   lineItems,
    buyer:                        buyer || null,
    fulfillment_details:          fulfillment_details || null,
    fulfillment_options:          buildFulfillmentOptions(subtotalCents),
    selected_fulfillment_options: [],
    totals: [
      { type: 'items_base_amount', display_text: 'Items',    amount: subtotalCents  },
      { type: 'subtotal',          display_text: 'Subtotal', amount: subtotalCents  },
      { type: 'fulfillment',       display_text: 'Shipping', amount: shippingCost   },
      { type: 'tax',               display_text: 'Tax',      amount: 0              },
      { type: 'total',             display_text: 'Total',    amount: subtotalCents + shippingCost },
    ],
    messages,
    order:      null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  session.status = deriveStatus(session);
  sessions.set(session.id, session);

  const responseBody = buildSessionBody(session, req);
  saveIdempotent(req, 201, responseBody);
  res.status(201).json(responseBody);
});

/**
 * POST /acp/checkout_sessions/:id — Update
 *
 * Update fulfillment_details, buyer, or selected_fulfillment_options.
 * Returns the full authoritative session state.
 */
router.post('/checkout_sessions/:id', POST_MW, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    const body = acpError('invalid_request', 'not_found',
      `Checkout session "${req.params.id}" not found.`);
    saveIdempotent(req, 404, body);
    return res.status(404).json(body);
  }
  if (session.status === 'completed' || session.status === 'canceled') {
    const body = acpError('invalid_request', 'invalid',
      `Cannot update a session with status "${session.status}".`);
    saveIdempotent(req, 422, body);
    return res.status(422).json(body);
  }

  const { fulfillment_details, selected_fulfillment_options, buyer } = req.body;

  if (fulfillment_details !== undefined) session.fulfillment_details = fulfillment_details;
  if (buyer !== undefined)               session.buyer               = buyer;

  if (Array.isArray(selected_fulfillment_options)) {
    const validIds = new Set(session.fulfillment_options.map(o => o.id));
    const invalid  = selected_fulfillment_options.filter(s => !validIds.has(s.option_id));
    if (invalid.length) {
      const body = acpError('invalid_request', 'invalid',
        `Unknown fulfillment option IDs: ${invalid.map(s => s.option_id).join(', ')}.`,
        '$.selected_fulfillment_options');
      saveIdempotent(req, 422, body);
      return res.status(422).json(body);
    }
    session.selected_fulfillment_options = selected_fulfillment_options;
  }

  session.updated_at = new Date().toISOString();
  recomputeTotals(session);
  session.status = deriveStatus(session);

  const responseBody = buildSessionBody(session, req);
  saveIdempotent(req, 200, responseBody);
  res.json(responseBody);
});

/**
 * GET /acp/checkout_sessions/:id — Retrieve
 *
 * Returns the current authoritative session state. No idempotency key required.
 */
router.get('/checkout_sessions/:id', GET_MW, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json(acpError('invalid_request', 'not_found',
      `Checkout session "${req.params.id}" not found.`));
  }
  res.json(buildSessionBody(session, req));
});

/**
 * POST /acp/checkout_sessions/:id/complete — Complete
 *
 * Finalizes the session with a Shared Payment Token and creates a DB order.
 * Body: { buyer?, payment_data: { handler_id, instrument: { type, credential: { type: "spt", token } }, billing_address? } }
 */
router.post('/checkout_sessions/:id/complete', POST_MW, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    const body = acpError('invalid_request', 'not_found',
      `Checkout session "${req.params.id}" not found.`);
    saveIdempotent(req, 404, body);
    return res.status(404).json(body);
  }

  // Idempotent replay for already-completed sessions
  if (session.status === 'completed') {
    const body = buildSessionBody(session, req);
    saveIdempotent(req, 200, body);
    return res.json(body);
  }

  if (session.status === 'canceled') {
    const body = acpError('invalid_request', 'invalid', 'Cannot complete a canceled session.');
    saveIdempotent(req, 422, body);
    return res.status(422).json(body);
  }

  if (session.status !== 'ready_for_payment') {
    const body = acpError('invalid_request', 'invalid',
      `Session status is "${session.status}". Provide fulfillment_details (name, email, address) and ensure items are valid before completing.`);
    saveIdempotent(req, 422, body);
    return res.status(422).json(body);
  }

  const { buyer, payment_data } = req.body;

  if (!payment_data || typeof payment_data !== 'object') {
    const body = acpError('invalid_request', 'missing',
      '"payment_data" is required to complete a checkout session.', '$.payment_data');
    saveIdempotent(req, 400, body);
    return res.status(400).json(body);
  }

  const { handler_id, instrument } = payment_data;
  if (handler_id !== 'card_tokenized') {
    const body = acpError('invalid_request', 'invalid',
      `Unknown payment handler "${handler_id}". Supported handlers: card_tokenized.`,
      '$.payment_data.handler_id');
    saveIdempotent(req, 400, body);
    return res.status(400).json(body);
  }

  const sptToken = instrument?.credential?.token;
  if (!sptToken) {
    const body = acpError('invalid_request', 'missing',
      'payment_data.instrument.credential.token (Shared Payment Token) is required.',
      '$.payment_data.instrument.credential.token');
    saveIdempotent(req, 400, body);
    return res.status(400).json(body);
  }

  const pspEntry = pspTokens.get(sptToken);
  if (!pspEntry) {
    const body = acpError('invalid_request', 'invalid',
      'Payment token not found or has expired. Obtain a new token from the PSP.',
      '$.payment_data.instrument.credential.token');
    saveIdempotent(req, 400, body);
    return res.status(400).json(body);
  }
  if (pspEntry.used) {
    const body = acpError('invalid_request', 'invalid',
      'Payment token has already been used. Tokens are single-use; obtain a new one.',
      '$.payment_data.instrument.credential.token');
    saveIdempotent(req, 400, body);
    return res.status(400).json(body);
  }

  // Consume the token (single-use)
  pspEntry.used = true;

  // Transition to in_progress while we persist the order
  session.status     = 'in_progress';
  session.updated_at = new Date().toISOString();
  if (buyer) session.buyer = buyer;

  const fd  = session.fulfillment_details || {};
  const adr = fd.address || {};
  const totalEntry    = session.totals.find(t => t.type === 'total');
  const shippingEntry = session.totals.find(t => t.type === 'fulfillment');
  const itemsEntry    = session.totals.find(t => t.type === 'items_base_amount');

  const grandTotalDollars = ((totalEntry?.amount    || 0) / 100).toFixed(2);
  const shippingDollars   = ((shippingEntry?.amount || 0) / 100).toFixed(2);
  const itemsDollars      = ((itemsEntry?.amount    || 0) / 100).toFixed(2);
  const orderNumber       = `ACP-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  const customerName  = buyer
    ? `${buyer.first_name || ''} ${buyer.last_name || ''}`.trim() || fd.name || 'ACP Customer'
    : fd.name || 'ACP Customer';
  const customerEmail = buyer?.email || fd.email || '';

  const dbClient = await pool.connect();
  let orderId;
  try {
    await dbClient.query('BEGIN');

    const orderRes = await dbClient.query(
      `INSERT INTO shop_orders
         (order_number, customer_name, customer_email, shipping_address,
          items_total, shipping_total, grand_total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid')
       RETURNING id`,
      [
        orderNumber,
        customerName,
        customerEmail,
        JSON.stringify({
          name:    fd.name    || customerName,
          street:  adr.line_one    || '',
          street2: adr.line_two    || '',
          city:    adr.city        || '',
          state:   adr.state       || '',
          zip:     adr.postal_code || '',
          country: adr.country     || 'US',
        }),
        itemsDollars,
        shippingDollars,
        grandTotalDollars,
      ]
    );
    orderId = orderRes.rows[0].id;

    for (const li of session.line_items) {
      await dbClient.query(
        `INSERT INTO shop_order_items
           (order_id, product_id, product_name, product_slug, size, price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          parseInt(li.id, 10) || null,
          li.name,
          li.slug || null,
          li.variant?.size || null,
          (li.unit_amount / 100).toFixed(2),
          li.quantity,
          (li.total / 100).toFixed(2),
        ]
      );
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    // Return token to usable state on DB failure so agent can retry
    pspEntry.used = false;
    session.status = 'ready_for_payment';
    if (req._idempotencyKey) idempotencyStore.delete(req._idempotencyKey);
    return res.status(503).json(acpError('service_unavailable', 'internal',
      'Order persistence failed. The payment token has been returned to an unused state. Please retry.'));
  } finally {
    dbClient.release();
  }

  const bu = getBaseUrl(req);
  session.status     = 'completed';
  session.updated_at = new Date().toISOString();
  session.order = {
    id:                  String(orderId),
    order_number:        orderNumber,
    checkout_session_id: session.id,
    permalink_url:       `${bu}/order/${orderId}`,
    grand_total_cents:   totalEntry?.amount || 0,
    grand_total_display: toDisplay(totalEntry?.amount || 0),
    status:              'paid',
    payment: {
      handler:   'card_tokenized',
      last_four: pspEntry.instrument.last_four,
      expiry:    pspEntry.instrument.expiry,
    },
  };
  session.messages.push({
    type:         'info',
    severity:     'high',
    content_type: 'plain',
    content:      `Order ${orderNumber} placed successfully. Total: ${toDisplay(totalEntry?.amount || 0)}. View at ${bu}/order/${orderId}`,
  });

  const responseBody = buildSessionBody(session, req);
  saveIdempotent(req, 200, responseBody);
  res.json(responseBody);
});

/**
 * POST /acp/checkout_sessions/:id/cancel — Cancel
 *
 * Cancels an open session. Cannot cancel a completed session.
 */
router.post('/checkout_sessions/:id/cancel', POST_MW, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    const body = acpError('invalid_request', 'not_found',
      `Checkout session "${req.params.id}" not found.`);
    saveIdempotent(req, 404, body);
    return res.status(404).json(body);
  }
  if (session.status === 'completed') {
    const body = acpError('invalid_request', 'invalid',
      'Completed sessions cannot be canceled. Contact support for refunds.');
    saveIdempotent(req, 422, body);
    return res.status(422).json(body);
  }
  if (session.status === 'canceled') {
    // Already canceled — idempotent
    const body = buildSessionBody(session, req);
    saveIdempotent(req, 200, body);
    return res.json(body);
  }

  session.status     = 'canceled';
  session.updated_at = new Date().toISOString();
  session.messages.push({
    type:         'info',
    severity:     'low',
    content_type: 'plain',
    content:      'This checkout session has been canceled.',
  });

  const responseBody = buildSessionBody(session, req);
  saveIdempotent(req, 200, responseBody);
  res.json(responseBody);
});

module.exports = router;
