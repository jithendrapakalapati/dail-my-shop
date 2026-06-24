-- AI Shop custom storefront schema
-- Tables are prefixed with shop_ to avoid conflicts with the Evershop schema.

DROP TABLE IF EXISTS shop_product_images CASCADE;
DROP TABLE IF EXISTS shop_products CASCADE;
DROP TABLE IF EXISTS shop_categories CASCADE;

CREATE TABLE shop_categories (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  slug         VARCHAR(100) UNIQUE NOT NULL,
  description  TEXT,
  icon         VARCHAR(10),
  image_url    VARCHAR(500),
  product_count INTEGER DEFAULT 0,
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shop_products (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(200) NOT NULL,
  slug              VARCHAR(200) UNIQUE NOT NULL,
  short_description VARCHAR(500),
  description       TEXT,
  price             DECIMAL(10,2) NOT NULL,
  compare_at_price  DECIMAL(10,2),
  sku               VARCHAR(100),
  category_id       INTEGER REFERENCES shop_categories(id),
  category_slug     VARCHAR(100),
  brand             VARCHAR(100),
  in_stock          BOOLEAN DEFAULT true,
  stock_quantity    INTEGER DEFAULT 100,
  image_url         VARCHAR(500),
  tags              TEXT[],
  rating            DECIMAL(3,1) DEFAULT 4.0,
  review_count      INTEGER DEFAULT 0,
  meta_title        VARCHAR(200),
  meta_description  TEXT,
  attributes        JSONB DEFAULT '{}',
  is_featured       BOOLEAN DEFAULT false,
  is_new            BOOLEAN DEFAULT false,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shop_product_images (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES shop_products(id) ON DELETE CASCADE,
  url        VARCHAR(500) NOT NULL,
  alt_text   VARCHAR(200),
  is_primary BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX idx_shop_products_category  ON shop_products(category_id);
CREATE INDEX idx_shop_products_slug      ON shop_products(slug);
CREATE INDEX idx_shop_products_brand     ON shop_products(brand);
CREATE INDEX idx_shop_products_featured  ON shop_products(is_featured) WHERE is_featured = true;
CREATE INDEX idx_shop_products_fts       ON shop_products USING gin(to_tsvector('english', name || ' ' || COALESCE(brand,'') || ' ' || COALESCE(short_description,'')));
CREATE INDEX idx_shop_categories_slug    ON shop_categories(slug);

-- Orders
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
