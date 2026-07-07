'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('./db/pool');

const app = express();
const PORT = process.env.STOREFRONT_PORT || 4000;

// Ensure order tables exist (non-destructive migration)
pool.query(`
  CREATE TABLE IF NOT EXISTS shop_orders (
    id               SERIAL PRIMARY KEY,
    order_number     VARCHAR(30) UNIQUE NOT NULL,
    customer_name    VARCHAR(200) NOT NULL,
    customer_email   VARCHAR(200) NOT NULL,
    shipping_address JSONB NOT NULL DEFAULT '{}',
    items_total      DECIMAL(10,2) NOT NULL DEFAULT 0,
    shipping_total   DECIMAL(10,2) NOT NULL DEFAULT 0,
    grand_total      DECIMAL(10,2) NOT NULL DEFAULT 0,
    status           VARCHAR(50) DEFAULT 'pending',
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS shop_order_items (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER REFERENCES shop_orders(id) ON DELETE CASCADE,
    product_id   INTEGER,
    product_name VARCHAR(200) NOT NULL,
    product_slug VARCHAR(200),
    size         VARCHAR(50),
    price        DECIMAL(10,2) NOT NULL,
    quantity     INTEGER NOT NULL DEFAULT 1,
    line_total   DECIMAL(10,2) NOT NULL
  );
`).catch(err => console.error('Order table migration error:', err.message));
const BASE_URL = (process.env.STOREFRONT_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
app.set('baseUrl', BASE_URL);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getCategories() {
  const res = await pool.query('SELECT * FROM shop_categories ORDER BY sort_order, name');
  return res.rows;
}

// Build a parameterised WHERE clause from an optional-filter bag.
// Returns { where, params } where params contains only the filter values
// (no LIMIT/OFFSET). Caller is responsible for appending those.
function buildProductFilter({ category, brand, min_price, max_price, in_stock, featured, q }) {
  const params = [];
  const conditions = [];
  const p = (val) => { params.push(val); return `$${params.length}`; };

  if (category)        conditions.push(`p.category_slug = ${p(category)}`);
  if (brand)           conditions.push(`p.brand ILIKE ${p('%' + brand + '%')}`);
  if (min_price)       conditions.push(`p.price >= ${p(parseFloat(min_price))}`);
  if (max_price)       conditions.push(`p.price <= ${p(parseFloat(max_price))}`);
  if (in_stock === 'true')  conditions.push('p.in_stock = true');
  if (featured === 'true')  conditions.push('p.is_featured = true');
  if (q) {
    const term = '%' + q.trim() + '%';
    conditions.push(`(p.name ILIKE ${p(term)} OR p.brand ILIKE ${p(term)} OR p.short_description ILIKE ${p(term)})`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function resolveSort(sort) {
  return {
    price_asc:  'p.price ASC',
    price_desc: 'p.price DESC',
    name_asc:   'p.name ASC',
    rating:     'p.rating DESC, p.review_count DESC',
    newest:     'p.created_at DESC',
  }[sort] || 'p.is_featured DESC, p.created_at DESC';
}


// ── Agentic Commerce Protocol (ACP) v2026-04-17 ───────────────────────────────
app.use('/acp', require('./routes/acp'));

// ── API ───────────────────────────────────────────────────────────────────────

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    res.json({ categories: await getCategories() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/products
app.get('/api/products', async (req, res) => {
  const { category, brand, min_price, max_price, in_stock, sort, page, limit, featured, q } = req.query;
  const { where, params } = buildProductFilter({ category, brand, min_price, max_price, in_stock, featured, q });
  const orderBy = resolveSort(sort);
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 12));
  const offset   = (pageNum - 1) * limitNum;

  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM shop_products p ${where}`, params),
      pool.query(
        `SELECT p.*, c.name AS category_name, c.icon AS category_icon
         FROM shop_products p
         LEFT JOIN shop_categories c ON p.category_id = c.id
         ${where} ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    res.json({ products: dataResult.rows, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('GET /api/products error:', err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:slug
app.get('/api/products/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS cat_slug
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.slug = $1`,
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// GET /api/search
app.get('/api/search', async (req, res) => {
  const { q, limit = '12' } = req.query;
  if (!q || q.trim().length < 2) return res.json({ products: [], total: 0 });

  const term = '%' + q.trim() + '%';
  const limitNum = Math.min(50, parseInt(limit, 10) || 12);
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.name ILIKE $1 OR p.brand ILIKE $1 OR p.short_description ILIKE $1 OR p.description ILIKE $1
       ORDER BY CASE WHEN p.name ILIKE $1 THEN 0 ELSE 1 END, p.is_featured DESC, p.rating DESC
       LIMIT $2`,
      [term, limitNum]
    );
    res.json({ products: result.rows, total: result.rows.length, query: q });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /openapi.json — OpenAPI 3.1 specification
app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.1.0',
    info: {
      title: 'AI Shop API',
      description: 'Public product catalog API for AI agents, crawlers, and developers. No authentication required.',
      version: '1.0.0',
      contact: { url: BASE_URL },
    },
    servers: [{ url: BASE_URL }],
    paths: {
      '/api/feed': {
        get: {
          operationId: 'getProductFeed',
          summary: 'Full product feed',
          description: 'Returns the complete product catalog as a schema.org ItemList. Intended for AI agents and automated crawlers that need a snapshot of all products, categories, and merchant metadata in a single request.',
          tags: ['Feed'],
          responses: {
            '200': {
              description: 'schema.org ItemList containing all products',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      '@context': { type: 'string', example: 'https://schema.org' },
                      '@type':    { type: 'string', example: 'ItemList' },
                      name:       { type: 'string', example: 'AI Shop Product Catalog' },
                      description: { type: 'string' },
                      url:        { type: 'string', format: 'uri' },
                      numberOfItems: { type: 'integer' },
                      itemListElement: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            '@type':   { type: 'string', example: 'ListItem' },
                            position:  { type: 'integer' },
                            item: {
                              type: 'object',
                              properties: {
                                '@type':      { type: 'string', example: 'Product' },
                                '@id':        { type: 'string', format: 'uri' },
                                name:         { type: 'string' },
                                description:  { type: 'string' },
                                brand:        { type: 'object', properties: { '@type': { type: 'string' }, name: { type: 'string' } } },
                                sku:          { type: 'string' },
                                image:        { type: 'string', format: 'uri' },
                                url:          { type: 'string', format: 'uri' },
                                category:     { type: 'string' },
                                offers: {
                                  type: 'object',
                                  properties: {
                                    '@type':        { type: 'string', example: 'Offer' },
                                    price:          { type: 'number' },
                                    priceCurrency:  { type: 'string', example: 'USD' },
                                    availability:   { type: 'string', example: 'https://schema.org/InStock' },
                                  },
                                },
                                aggregateRating: {
                                  type: 'object',
                                  properties: {
                                    '@type':      { type: 'string', example: 'AggregateRating' },
                                    ratingValue:  { type: 'number' },
                                    reviewCount:  { type: 'integer' },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      categories: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name:         { type: 'string' },
                            slug:         { type: 'string' },
                            icon:         { type: 'string' },
                            url:          { type: 'string', format: 'uri' },
                            productCount: { type: 'integer' },
                          },
                        },
                      },
                      merchant: {
                        type: 'object',
                        properties: {
                          name:     { type: 'string' },
                          url:      { type: 'string', format: 'uri' },
                          currency: { type: 'string' },
                          locale:   { type: 'string' },
                        },
                      },
                      generatedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
            '500': { description: 'Feed generation failed' },
          },
        },
      },
      '/api/products': {
        get: {
          operationId: 'listProducts',
          summary: 'List products',
          description: 'Paginated product listing with optional filtering.',
          tags: ['Products'],
          parameters: [
            { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category slug' },
            { name: 'brand',    in: 'query', schema: { type: 'string' }, description: 'Filter by brand name' },
            { name: 'min_price', in: 'query', schema: { type: 'number' } },
            { name: 'max_price', in: 'query', schema: { type: 'number' } },
            { name: 'in_stock', in: 'query', schema: { type: 'boolean' } },
            { name: 'featured', in: 'query', schema: { type: 'boolean' } },
            { name: 'sort',     in: 'query', schema: { type: 'string', enum: ['price_asc', 'price_desc', 'rating', 'newest', 'featured'] } },
            { name: 'q',        in: 'query', schema: { type: 'string' }, description: 'Keyword search' },
            { name: 'page',     in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit',    in: 'query', schema: { type: 'integer', default: 12, maximum: 100 } },
          ],
          responses: {
            '200': {
              description: 'Paginated product list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      products:   { type: 'array', items: { '$ref': '#/components/schemas/Product' } },
                      total:      { type: 'integer' },
                      page:       { type: 'integer' },
                      limit:      { type: 'integer' },
                      totalPages: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/products/{slug}': {
        get: {
          operationId: 'getProduct',
          summary: 'Get a product by slug',
          tags: ['Products'],
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Product detail',
              content: { 'application/json': { schema: { type: 'object', properties: { product: { '$ref': '#/components/schemas/Product' } } } } },
            },
            '404': { description: 'Product not found' },
          },
        },
      },
      '/api/categories': {
        get: {
          operationId: 'listCategories',
          summary: 'List all categories',
          tags: ['Categories'],
          responses: {
            '200': {
              description: 'Category list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      categories: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id:            { type: 'integer' },
                            name:          { type: 'string' },
                            slug:          { type: 'string' },
                            icon:          { type: 'string' },
                            product_count: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/ai-commerce/readiness': {
        get: {
          operationId: 'checkReadiness',
          summary: 'AI-agent readiness check',
          description: 'Reports catalog completeness score and available endpoint URLs for AI agent discovery.',
          tags: ['AI Commerce'],
          responses: {
            '200': {
              description: 'Readiness report',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ready:    { type: 'boolean' },
                      score:    { type: 'integer', description: 'Completeness score 0–100' },
                      summary:  { type: 'object' },
                      checks:   { type: 'object' },
                      endpoints: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/ai-commerce/search': {
        get: {
          operationId: 'aiSearch',
          summary: 'Structured product search for AI agents',
          tags: ['AI Commerce'],
          parameters: [
            { name: 'q',         in: 'query', required: true, schema: { type: 'string', minLength: 2 } },
            { name: 'category',  in: 'query', schema: { type: 'string' } },
            { name: 'brand',     in: 'query', schema: { type: 'string' } },
            { name: 'min_price', in: 'query', schema: { type: 'number' } },
            { name: 'max_price', in: 'query', schema: { type: 'number' } },
            { name: 'limit',     in: 'query', schema: { type: 'integer', default: 12, maximum: 50 } },
            { name: 'sort',      in: 'query', schema: { type: 'string', enum: ['price_asc', 'price_desc', 'rating', 'newest'] } },
          ],
          responses: {
            '200': {
              description: 'Search results',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      query:    { type: 'string' },
                      total:    { type: 'integer' },
                      products: { type: 'array', items: { '$ref': '#/components/schemas/Product' } },
                    },
                  },
                },
              },
            },
            '400': { description: 'Query too short' },
          },
        },
      },
      '/api/ai-commerce/products/{id}': {
        get: {
          operationId: 'aiGetProduct',
          summary: 'Full product record (slug or numeric id)',
          tags: ['AI Commerce'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Product slug or numeric id' }],
          responses: {
            '200': { description: 'Product record', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Product' } } } },
            '404': { description: 'Product not found' },
          },
        },
      },
      '/api/ai-commerce/products/{id}/inventory': {
        get: {
          operationId: 'getInventory',
          summary: 'Real-time inventory status',
          tags: ['AI Commerce'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Inventory status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      productId:         { type: 'integer' },
                      sku:               { type: 'string' },
                      inStock:           { type: 'boolean' },
                      stockQuantity:     { type: 'integer' },
                      availability:      { type: 'string' },
                      availabilityLabel: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/ai-commerce/products/{id}/variants': {
        get: {
          operationId: 'getVariants',
          summary: 'Product variant combinations (sizes, colors, etc.)',
          tags: ['AI Commerce'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Variant data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      productId:         { type: 'integer' },
                      hasVariants:       { type: 'boolean' },
                      variantDimensions: { type: 'object' },
                      basePrice:         { type: 'number' },
                      currency:          { type: 'string' },
                      variants:          { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/ai-commerce/carts': {
        post: {
          operationId: 'createCart',
          summary: 'Create a cart from a list of products',
          tags: ['AI Commerce'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['productId', 'quantity'],
                        properties: {
                          productId: { type: 'string', description: 'Product slug or numeric id' },
                          quantity:  { type: 'integer', minimum: 1 },
                          variant:   { type: 'object', description: 'Optional variant attributes, e.g. {"size":"M"}' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Cart created with checkout URL' },
            '400': { description: 'Missing or invalid items' },
            '422': { description: 'No valid items (all out of stock or not found)' },
          },
        },
      },
    },
    components: {
      schemas: {
        Product: {
          type: 'object',
          properties: {
            id:                { type: 'integer' },
            name:              { type: 'string' },
            slug:              { type: 'string' },
            sku:               { type: 'string' },
            brand:             { type: 'string' },
            short_description: { type: 'string' },
            description:       { type: 'string' },
            price:             { type: 'string', description: 'Decimal string, e.g. "49.99"' },
            compare_at_price:  { type: 'string', nullable: true },
            image_url:         { type: 'string', format: 'uri' },
            category_name:     { type: 'string' },
            in_stock:          { type: 'boolean' },
            stock_quantity:    { type: 'integer' },
            rating:            { type: 'number' },
            review_count:      { type: 'integer' },
            is_featured:       { type: 'boolean' },
            is_new:            { type: 'boolean' },
            tags:              { type: 'array', items: { type: 'string' } },
            attributes:        { type: 'object', description: 'Variant attributes, e.g. {"sizes":["S","M","L"]}' },
          },
        },
      },
    },
    tags: [
      { name: 'Feed',        description: 'Full catalog snapshot — ideal for AI agents needing all products at once' },
      { name: 'Products',    description: 'Standard paginated product API' },
      { name: 'Categories',  description: 'Category listing' },
      { name: 'AI Commerce', description: 'AI-agent optimised endpoints: search, inventory, variants, cart' },
    ],
  });
});

// ── Page routes ───────────────────────────────────────────────────────────────

// GET /catalog  or  GET /catalog/:category
app.get(['/catalog', '/catalog/:category'], async (req, res) => {
  const { category } = req.params;
  const { brand, min_price, max_price, in_stock, sort, page = '1', q } = req.query;

  let currentCategory = null;
  if (category) {
    const catRes = await pool.query('SELECT * FROM shop_categories WHERE slug = $1', [category]);
    if (!catRes.rows.length) {
      return res.status(404).render('error', { title: '404 — Category Not Found', description: '', status: 404, message: `Category "${category}" does not exist.`, baseUrl: BASE_URL });
    }
    currentCategory = catRes.rows[0];
  }

  const { where, params } = buildProductFilter({ category, brand, min_price, max_price, in_stock, q });
  const orderBy  = resolveSort(sort);
  const pageNum  = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = 12;
  const offset   = (pageNum - 1) * limitNum;

  try {
    const [categories, countRes, dataRes, brandsRes] = await Promise.all([
      getCategories(),
      pool.query(`SELECT COUNT(*) FROM shop_products p ${where}`, params),
      pool.query(
        `SELECT p.*, c.name AS category_name FROM shop_products p
         LEFT JOIN shop_categories c ON p.category_id = c.id
         ${where} ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      pool.query('SELECT DISTINCT brand FROM shop_products WHERE brand IS NOT NULL ORDER BY brand'),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    const hasActiveFilters = Boolean(brand || min_price || max_price || in_stock || q || pageNum > 1);
    res.render('catalog', {
      title: currentCategory ? `${currentCategory.name} — Shop` : 'All Products — Shop',
      description: currentCategory
        ? `Shop our ${currentCategory.name} collection`
        : 'Browse our complete product catalog — shoes, shirts, phones & accessories',
      categories,
      products: dataRes.rows,
      currentCategory,
      filters: { brand, min_price, max_price, in_stock, sort, q },
      brands: brandsRes.rows.map(r => r.brand),
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
      searchQuery: q || '',
      baseUrl: BASE_URL,
      canonicalUrl: `${BASE_URL}${req.path}`,
      noindex: hasActiveFilters,
    });
  } catch (err) {
    console.error('GET /catalog error:', err.message);
    res.status(500).render('error', { title: 'Error', description: '', status: 500, message: 'Could not load catalog', baseUrl: BASE_URL });
  }
});

// GET /product/:slug
app.get('/product/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS cat_slug
       FROM shop_products p
       LEFT JOIN shop_categories c ON p.category_id = c.id
       WHERE p.slug = $1`,
      [req.params.slug]
    );
    if (!result.rows.length) {
      return res.status(404).render('error', { title: '404 — Product Not Found', description: '', status: 404, message: 'This product does not exist.', baseUrl: BASE_URL });
    }

    const product = result.rows[0];
    const [categories, relatedRes] = await Promise.all([
      getCategories(),
      pool.query(
        `SELECT p.*, c.name AS category_name FROM shop_products p
         LEFT JOIN shop_categories c ON p.category_id = c.id
         WHERE p.category_id = $1 AND p.id != $2
         ORDER BY p.is_featured DESC, p.rating DESC LIMIT 4`,
        [product.category_id, product.id]
      ),
    ]);

    res.render('product', {
      title: `${product.name || product.meta_title} — Shop`,
      description: product.meta_description || product.short_description || `Buy ${product.name} from ${product.brand}`,
      categories,
      product,
      relatedProducts: relatedRes.rows,
      baseUrl: BASE_URL,
    });
  } catch (err) {
    console.error('GET /product/:slug error:', err.message);
    res.status(500).render('error', { title: 'Error', description: '', status: 500, message: 'Could not load product', baseUrl: BASE_URL });
  }
});

// GET /search — redirects to catalog with q param for search
app.get('/search', (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.redirect('/catalog');
  res.redirect(`/catalog?q=${encodeURIComponent(q.trim())}`);
});

// GET /checkout
app.get('/checkout', async (req, res) => {
  try {
    const categories = await getCategories();
    res.render('checkout', {
      title: 'Checkout — Shop',
      description: 'Complete your purchase',
      categories,
      baseUrl: BASE_URL,
      noindex: true,
    });
  } catch (err) {
    console.error('GET /checkout error:', err.message);
    res.status(500).render('error', { title: 'Error', description: '', status: 500, message: 'Could not load checkout', baseUrl: BASE_URL });
  }
});

// POST /api/orders — place a new order
app.post('/api/orders', async (req, res) => {
  const { customer, items } = req.body;

  if (!customer || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Missing order data' });
  }

  const orderNumber = 'ORD-' + Date.now().toString(36).toUpperCase().slice(-8);
  const itemsTotal  = items.reduce((s, i) => s + parseFloat(i.price) * parseInt(i.qty, 10), 0);
  const shippingTotal = itemsTotal >= 50 ? 0 : 9.99;
  const grandTotal  = itemsTotal + shippingTotal;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `INSERT INTO shop_orders
         (order_number, customer_name, customer_email, shipping_address, items_total, shipping_total, grand_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [orderNumber, customer.name, customer.email,
       JSON.stringify(customer.address || {}),
       itemsTotal.toFixed(2), shippingTotal.toFixed(2), grandTotal.toFixed(2)]
    );

    const orderId = orderRes.rows[0].id;

    for (const item of items) {
      const lineTotal = parseFloat(item.price) * parseInt(item.qty, 10);
      await client.query(
        `INSERT INTO shop_order_items
           (order_id, product_id, product_name, product_slug, size, price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.productId || null, item.name, item.slug || null,
         item.size || null, parseFloat(item.price).toFixed(2),
         parseInt(item.qty, 10), lineTotal.toFixed(2)]
      );
    }

    await client.query('COMMIT');
    res.json({ orderId, orderNumber, grandTotal });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/orders error:', err.message);
    res.status(500).json({ error: 'Failed to place order' });
  } finally {
    client.release();
  }
});

// GET /order/:id — order confirmation page
app.get('/order/:id', async (req, res) => {
  try {
    const [orderRes, categories] = await Promise.all([
      pool.query('SELECT * FROM shop_orders WHERE id = $1', [req.params.id]),
      getCategories(),
    ]);

    if (!orderRes.rows.length) {
      return res.status(404).render('error', {
        title: 'Order Not Found', description: '', status: 404,
        message: 'This order could not be found.',
        baseUrl: BASE_URL,
      });
    }

    const order = orderRes.rows[0];
    const itemsRes = await pool.query(
      'SELECT * FROM shop_order_items WHERE order_id = $1 ORDER BY id',
      [order.id]
    );

    res.render('order-confirmation', {
      title: `Order ${order.order_number} — Shop`,
      description: 'Your order has been placed successfully',
      categories,
      order,
      items: itemsRes.rows,
      baseUrl: BASE_URL,
      noindex: true,
    });
  } catch (err) {
    console.error('GET /order/:id error:', err.message);
    res.status(500).render('error', { title: 'Error', description: '', status: 500, message: 'Could not load order', baseUrl: BASE_URL });
  }
});


// ── ACP Discovery — /.well-known/acp ─────────────────────────────────────────
// Tells AI agents and crawler tools how to discover this merchant's ACP endpoints.
app.get('/.well-known/acp', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    protocol:        'acp',
    version:         '2026-04-17',
    merchant: {
      name:          'AI Shop',
      url:           BASE_URL,
      currency:      'usd',
      locale:        'en-US',
    },
    endpoints: {
      // ACP Checkout Sessions (core ACP spec)
      checkout_sessions:        `${BASE_URL}/acp/checkout_sessions`,
      // ACP product catalog (for agent ingestion)
      feed:                     `${BASE_URL}/acp/feed`,
      products:                 `${BASE_URL}/acp/products`,
      // Mock PSP — Shared Payment Token issuance
      psp_tokens:               `${BASE_URL}/acp/psp/tokens`,
      // Discovery
      well_known:               `${BASE_URL}/.well-known/acp`,
    },
    capabilities: {
      checkout:             true,
      product_feed:         true,
      product_search:       true,
      shared_payment_token: true,
      order_persistence:    true,
      fulfillment_options:  true,
      idempotency:          true,
    },
    payment_handlers: [
      {
        id:      'card_tokenized',
        name:    'dev.acp.tokenized.card',
        version: '2026-01-22',
        psp:     'ai-shop-mock-psp',
        config: {
          token_endpoint: `${BASE_URL}/acp/psp/tokens`,
        },
      },
    ],
    policies: {
      shipping: 'Free shipping on orders $50 or more. $9.99 flat otherwise.',
      returns:  '30-day no-questions-asked returns.',
      currency: 'usd',
      login_required: false,
    },
    spec_url: 'https://github.com/agentic-commerce-protocol/agentic-commerce-protocol',
  });
});

// ── SEO ───────────────────────────────────────────────────────────────────────

app.get('/sitemap.xml', async (req, res) => {
  try {
    const [products, categories] = await Promise.all([
      pool.query('SELECT slug, updated_at FROM shop_products ORDER BY updated_at DESC'),
      pool.query('SELECT slug FROM shop_categories'),
    ]);

    const now = new Date().toISOString().split('T')[0];
    const urls = [
      `<url><loc>${BASE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${now}</lastmod></url>`,
      `<url><loc>${BASE_URL}/catalog</loc><changefreq>daily</changefreq><priority>0.9</priority><lastmod>${now}</lastmod></url>`,
      ...categories.rows.map(c =>
        `<url><loc>${BASE_URL}/catalog/${c.slug}</loc><changefreq>daily</changefreq><priority>0.8</priority><lastmod>${now}</lastmod></url>`
      ),
      ...products.rows.map(p => {
        const mod = p.updated_at ? new Date(p.updated_at).toISOString().split('T')[0] : now;
        return `<url><loc>${BASE_URL}/product/${p.slug}</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${mod}</lastmod></url>`;
      }),
    ];

    res.header('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
  } catch (err) {
    res.status(500).send('Sitemap generation failed');
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/_health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🛍   Shop Storefront');
  console.log('──────────────────────────────');
  console.log(`  Homepage:  ${BASE_URL}/`);
  console.log(`  Catalog:   ${BASE_URL}/catalog`);
  console.log(`  API:       ${BASE_URL}/api/products`);
  console.log(`  Sitemap:   ${BASE_URL}/sitemap.xml`);
  console.log('──────────────────────────────\n');
});

module.exports = app;
