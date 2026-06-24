'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');

const router = express.Router();

// In-memory cart store (survives the process lifetime; resets on restart)
const carts = new Map();

// ── Canonical product schema builder ─────────────────────────────────────────
// Converts a DB row into a schema.org Product object enriched with all known
// attributes, tags, and AI-commerce metadata.

function toCanonicalProduct(p, baseUrl) {
  const attrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes : {};
  const additionalProperty = [];
  Object.entries(attrs).forEach(([k, v]) => {
    (Array.isArray(v) ? v : [v]).forEach(val =>
      additionalProperty.push({ '@type': 'PropertyValue', name: k, value: String(val) })
    );
  });

  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${baseUrl}/product/${p.slug}`,
    name: p.name,
    description: p.description || p.short_description || '',
    shortDescription: p.short_description || '',
    sku: p.sku || '',
    brand: { '@type': 'Brand', name: p.brand || '' },
    image: [p.image_url].filter(Boolean),
    url: `${baseUrl}/product/${p.slug}`,
    category: p.category_name || '',
    offers: {
      '@type': 'Offer',
      price: parseFloat(p.price),
      priceCurrency: 'USD',
      availability: p.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      url: `${baseUrl}/product/${p.slug}`,
      ...(p.compare_at_price && parseFloat(p.compare_at_price) > parseFloat(p.price)
        ? { highPrice: parseFloat(p.compare_at_price) } : {}),
    },
    isNew: !!p.is_new,
    isFeatured: !!p.is_featured,
  };

  if (p.review_count > 0) {
    product.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: parseFloat(p.rating),
      reviewCount: parseInt(p.review_count, 10),
      bestRating: 5,
      worstRating: 1,
    };
  }
  if (additionalProperty.length) product.additionalProperty = additionalProperty;
  if (p.tags && p.tags.length) product.keywords = p.tags.join(', ');

  return product;
}

// ── GET /api/ai-commerce/readiness ────────────────────────────────────────────
// Tells AI agents whether this store is fully instrumented for discovery.
router.get('/readiness', async (req, res) => {
  try {
    const [total, withImg, withDesc, withSku, cats, featured] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM shop_products'),
      pool.query("SELECT COUNT(*) FROM shop_products WHERE image_url IS NOT NULL AND image_url != ''"),
      pool.query("SELECT COUNT(*) FROM shop_products WHERE short_description IS NOT NULL AND short_description != ''"),
      pool.query("SELECT COUNT(*) FROM shop_products WHERE sku IS NOT NULL AND sku != ''"),
      pool.query('SELECT COUNT(*) FROM shop_categories'),
      pool.query('SELECT COUNT(*) FROM shop_products WHERE is_featured = true'),
    ]);

    const t = parseInt(total.rows[0].count, 10);
    const i = parseInt(withImg.rows[0].count, 10);
    const d = parseInt(withDesc.rows[0].count, 10);
    const s = parseInt(withSku.rows[0].count, 10);
    const c = parseInt(cats.rows[0].count, 10);
    const f = parseInt(featured.rows[0].count, 10);

    // Score: images 30 pts, descriptions 30 pts, SKUs 20 pts, featured 10 pts, categories 10 pts
    const score = t === 0 ? 0 : Math.round(
      (i / t) * 30 + (d / t) * 30 + (s / t) * 20 + (f > 0 ? 10 : 0) + (c > 0 ? 10 : 0)
    );

    res.json({
      ready: score >= 70,
      score,
      summary: {
        totalProducts: t,
        categories: c,
        featuredProducts: f,
        productsWithImages: i,
        productsWithDescriptions: d,
        productsWithSku: s,
      },
      checks: {
        hasProducts: t > 0,
        hasCategories: c > 0,
        allHaveImages: i === t,
        allHaveDescriptions: d === t,
        allHaveSkus: s === t,
        hasFeaturedProducts: f > 0,
        schemaOrgEnabled: true,
        jsonLdEnabled: true,
      },
      endpoints: {
        search: '/api/ai-commerce/search?q=',
        product: '/api/ai-commerce/products/:id',
        inventory: '/api/ai-commerce/products/:id/inventory',
        variants: '/api/ai-commerce/products/:id/variants',
        carts: '/api/ai-commerce/carts',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Readiness check failed', message: err.message });
  }
});

// ── GET /api/ai-commerce/search?q=... ────────────────────────────────────────
// Structured product search for AI agents. Supports filters and returns canonical schema.
router.get('/search', async (req, res) => {
  const baseUrl = req.app.get('baseUrl') || '';
  const { q, category, min_price, max_price, brand, limit = '12', sort = '' } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: '"q" must be at least 2 characters' });
  }

  const term = '%' + q.trim() + '%';
  const params = [term]; // $1 — reused in ORDER BY CASE expression
  const conditions = ['(p.name ILIKE $1 OR p.brand ILIKE $1 OR p.short_description ILIKE $1 OR p.description ILIKE $1)'];

  const addParam = (v) => { params.push(v); return `$${params.length}`; };
  if (category)  conditions.push(`p.category_slug = ${addParam(category)}`);
  if (brand)     conditions.push(`p.brand ILIKE ${addParam('%' + brand + '%')}`);
  if (min_price) conditions.push(`p.price >= ${addParam(parseFloat(min_price))}`);
  if (max_price) conditions.push(`p.price <= ${addParam(parseFloat(max_price))}`);

  const orderBy = {
    price_asc:  'p.price ASC',
    price_desc: 'p.price DESC',
    rating:     'p.rating DESC',
    newest:     'p.created_at DESC',
  }[sort] || 'CASE WHEN p.name ILIKE $1 THEN 0 ELSE 1 END, p.is_featured DESC, p.rating DESC';

  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
  params.push(limitNum);

  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params
    );

    res.json({
      query: q,
      total: result.rows.length,
      products: result.rows.map(row => toCanonicalProduct(row, baseUrl)),
    });
  } catch (err) {
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// ── GET /api/ai-commerce/products/:id ────────────────────────────────────────
// Full canonical product record. Accepts slug or numeric id.
router.get('/products/:id', async (req, res) => {
  const baseUrl = req.app.get('baseUrl') || '';
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.slug = $1 OR p.id::text = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });

    const product = result.rows[0];
    const imagesRes = await pool.query(
      'SELECT url, alt_text FROM shop_product_images WHERE product_id = $1 ORDER BY sort_order',
      [product.id]
    );

    const canonical = toCanonicalProduct(product, baseUrl);
    if (imagesRes.rows.length) {
      canonical.image = [product.image_url, ...imagesRes.rows.map(r => r.url)].filter(Boolean);
    }

    res.json(canonical);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product', message: err.message });
  }
});

// ── GET /api/ai-commerce/products/:id/inventory ───────────────────────────────
router.get('/products/:id/inventory', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, slug, name, in_stock, stock_quantity, sku FROM shop_products WHERE slug = $1 OR id::text = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });

    const p = result.rows[0];
    res.json({
      productId: p.id,
      sku: p.sku || '',
      inStock: p.in_stock,
      stockQuantity: p.stock_quantity,
      availability: p.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      availabilityLabel: p.in_stock ? 'In Stock' : 'Out of Stock',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory', message: err.message });
  }
});

// ── GET /api/ai-commerce/products/:id/variants ────────────────────────────────
// Derives variant combinations from the product's attributes JSONB (sizes, colors, etc.).
router.get('/products/:id/variants', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, slug, name, price, compare_at_price, in_stock, sku, attributes FROM shop_products WHERE slug = $1 OR id::text = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });

    const p = result.rows[0];
    const attrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes : {};

    const variantDimensions = {};
    ['size', 'sizes', 'color', 'colors', 'style', 'material'].forEach(k => {
      if (attrs[k]) variantDimensions[k] = Array.isArray(attrs[k]) ? attrs[k] : [attrs[k]];
    });

    const hasVariants = Object.keys(variantDimensions).length > 0;

    res.json({
      productId: p.id,
      hasVariants,
      variantDimensions,
      basePrice: parseFloat(p.price),
      currency: 'USD',
      variants: hasVariants ? buildVariants(p, variantDimensions) : [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch variants', message: err.message });
  }
});

function buildVariants(product, dimensions) {
  const keys = Object.keys(dimensions);
  const combos = keys.reduce((acc, key) => {
    if (!acc.length) return dimensions[key].map(v => ({ [key]: v }));
    return acc.flatMap(combo => dimensions[key].map(v => ({ ...combo, [key]: v })));
  }, []);

  return combos.map((combo, idx) => ({
    id: `${product.slug}-v${idx + 1}`,
    attributes: combo,
    price: parseFloat(product.price),
    currency: 'USD',
    inStock: product.in_stock,
    sku: product.sku
      ? `${product.sku}-${Object.values(combo).join('-').toUpperCase().replace(/\s+/g, '')}`
      : '',
  }));
}

// ── POST /api/ai-commerce/carts ───────────────────────────────────────────────
// Creates a new in-memory cart from a list of { productId, quantity, variant? } items.
router.post('/carts', async (req, res) => {
  const baseUrl = req.app.get('baseUrl') || '';
  const { items = [] } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '"items" must be a non-empty array' });
  }
  for (const item of items) {
    if (!item.productId || !item.quantity || parseInt(item.quantity, 10) < 1) {
      return res.status(400).json({ error: 'Each item needs "productId" and "quantity" ≥ 1' });
    }
  }

  try {
    const ids = items.map(i => String(i.productId));
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.slug = ANY($1) OR p.id::text = ANY($1)`,
      [ids]
    );

    const bySlug = new Map(result.rows.map(p => [p.slug, p]));
    const byId   = new Map(result.rows.map(p => [String(p.id), p]));

    const resolved = [];
    const errors   = [];

    for (const item of items) {
      const product = bySlug.get(item.productId) || byId.get(item.productId);
      if (!product) { errors.push({ productId: item.productId, error: 'Product not found' }); continue; }
      if (!product.in_stock) { errors.push({ productId: item.productId, error: 'Out of stock' }); continue; }

      const qty = parseInt(item.quantity, 10);
      resolved.push({
        productId: item.productId,
        name: product.name,
        slug: product.slug,
        brand: product.brand,
        quantity: qty,
        unitPrice: parseFloat(product.price),
        lineTotal: parseFloat((parseFloat(product.price) * qty).toFixed(2)),
        variant: item.variant || null,
        imageUrl: product.image_url,
        productUrl: `${baseUrl}/product/${product.slug}`,
      });
    }

    if (!resolved.length) {
      return res.status(422).json({ error: 'No valid items could be added', errors });
    }

    const subtotal = parseFloat(resolved.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));
    const cartId = randomUUID();
    const cart = {
      cartId,
      createdAt: new Date().toISOString(),
      items: resolved,
      itemCount: resolved.reduce((s, i) => s + i.quantity, 0),
      subtotal,
      currency: 'USD',
      ...(errors.length ? { errors } : {}),
    };
    carts.set(cartId, cart);

    res.status(201).json({
      ...cart,
      checkoutUrl: `${baseUrl}/api/ai-commerce/carts/${cartId}/checkout-initiation`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create cart', message: err.message });
  }
});

// ── GET /api/ai-commerce/carts/:cart_id/checkout-initiation ──────────────────
// Returns cart summary and next-step actions for an AI agent to surface to the user.
router.get('/carts/:cart_id/checkout-initiation', (req, res) => {
  const baseUrl = req.app.get('baseUrl') || '';
  const cart = carts.get(req.params.cart_id);
  if (!cart) return res.status(404).json({ error: 'Cart not found or expired' });

  res.json({
    cartId: cart.cartId,
    status: 'ready',
    items: cart.items,
    itemCount: cart.itemCount,
    subtotal: cart.subtotal,
    currency: cart.currency,
    summary: cart.items
      .map(i => `${i.name} ×${i.quantity} @ $${i.unitPrice.toFixed(2)}`)
      .join('; '),
    actions: {
      viewCatalog: `${baseUrl}/catalog`,
      continueShopping: `${baseUrl}/catalog`,
    },
    note: 'Demo storefront — no real payment processing occurs.',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
});

module.exports = router;
