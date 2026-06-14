'use strict';

(function () {
  // ── Search toggle ─────────────────────────────────────────────────────────
  const searchToggle = document.getElementById('searchToggle');
  const searchBarWrap = document.getElementById('searchBarWrap');
  const searchInput = document.getElementById('searchInput');

  if (searchToggle && searchBarWrap) {
    searchToggle.addEventListener('click', () => {
      const open = searchBarWrap.classList.toggle('open');
      if (open && searchInput) setTimeout(() => searchInput.focus(), 50);
    });
  }

  // ── Mobile nav toggle ─────────────────────────────────────────────────────
  const navToggle = document.getElementById('navToggle');
  const mainNav = document.getElementById('mainNav');

  if (navToggle && mainNav) {
    navToggle.addEventListener('click', () => mainNav.classList.toggle('open'));
  }

  // ── Catalog: sort select → form submit ───────────────────────────────────
  const sortSelect = document.getElementById('sortSelect');
  const sortHidden = document.getElementById('sortHidden');
  const filterForm = document.getElementById('filterForm');

  if (sortSelect && sortHidden && filterForm) {
    sortSelect.addEventListener('change', () => {
      sortHidden.value = sortSelect.value;
      filterForm.submit();
    });
  }

  // ── Catalog: mobile sidebar ───────────────────────────────────────────────
  const filterToggle = document.getElementById('filterToggle');
  const catalogSidebar = document.getElementById('catalogSidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const sidebarClose = document.getElementById('sidebarClose');

  function openSidebar() {
    catalogSidebar && catalogSidebar.classList.add('open');
    sidebarOverlay && sidebarOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    catalogSidebar && catalogSidebar.classList.remove('open');
    sidebarOverlay && sidebarOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  filterToggle && filterToggle.addEventListener('click', openSidebar);
  sidebarClose && sidebarClose.addEventListener('click', closeSidebar);
  sidebarOverlay && sidebarOverlay.addEventListener('click', closeSidebar);

  // ── Product image lazy load fallback ─────────────────────────────────────
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    img.addEventListener('error', function () {
      this.src = '/images/placeholder.svg';
    });
  });

  // ── Size chip toggle ──────────────────────────────────────────────────────
  document.querySelectorAll('.size-chip').forEach(chip => {
    chip.addEventListener('click', function () {
      document.querySelectorAll('.size-chip').forEach(c => {
        c.classList.remove('selected');
        c.style.background = '';
        c.style.color = '';
        c.style.borderColor = '';
      });
      this.classList.add('selected');
      this.style.background = 'var(--primary)';
      this.style.color = '#fff';
      this.style.borderColor = 'var(--primary)';
    });
  });

  // ── Cart ──────────────────────────────────────────────────────────────────
  const CART_KEY = 'shop_cart';

  const Cart = {
    get() {
      try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
      catch { return []; }
    },
    save(items) { localStorage.setItem(CART_KEY, JSON.stringify(items)); },
    add(product) {
      const items = this.get();
      const key = String(product.productId) + (product.size ? '-' + product.size : '');
      const existing = items.find(i => i.key === key);
      if (existing) {
        existing.qty++;
      } else {
        items.push({ key, ...product, qty: 1 });
      }
      this.save(items);
      return items;
    },
    remove(key) {
      const items = this.get().filter(i => i.key !== key);
      this.save(items);
      return items;
    },
    updateQty(key, delta) {
      const items = this.get();
      const item = items.find(i => i.key === key);
      if (item) {
        item.qty = Math.max(1, item.qty + delta);
        this.save(items);
      }
      return items;
    },
    count() { return this.get().reduce((s, i) => s + i.qty, 0); },
    subtotal() { return this.get().reduce((s, i) => s + i.price * i.qty, 0); },
  };

  // ── Cart Drawer ───────────────────────────────────────────────────────────
  const cartDrawer  = document.getElementById('cartDrawer');
  const cartOverlay = document.getElementById('cartOverlay');
  const cartBadge   = document.getElementById('cartBadge');
  const cartToggle  = document.getElementById('cartToggle');
  const cartClose   = document.getElementById('cartClose');
  const cartItemsEl = document.getElementById('cartItems');
  const cartCountEl = document.getElementById('cartItemCount');
  const cartSubtotalEl = document.getElementById('cartSubtotal');

  function openCart() {
    if (!cartDrawer) return;
    closeSidebar();
    searchBarWrap && searchBarWrap.classList.remove('open');
    cartDrawer.classList.add('open');
    cartOverlay && cartOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeCart() {
    if (!cartDrawer) return;
    cartDrawer.classList.remove('open');
    cartOverlay && cartOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  function fmt(n) { return '$' + parseFloat(n).toFixed(2); }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderCart() {
    const items = Cart.get();
    const count = Cart.count();
    const subtotal = Cart.subtotal();

    if (cartBadge) {
      cartBadge.textContent = count > 9 ? '9+' : count;
      cartBadge.style.display = count > 0 ? 'flex' : 'none';
    }
    if (cartCountEl) cartCountEl.textContent = count;
    if (cartSubtotalEl) cartSubtotalEl.textContent = fmt(subtotal);

    if (!cartItemsEl) return;

    if (!items.length) {
      cartItemsEl.innerHTML =
        '<div class="cart-empty">' +
          '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
            '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>' +
            '<line x1="3" y1="6" x2="21" y2="6"/>' +
            '<path d="M16 10a4 4 0 0 1-8 0"/>' +
          '</svg>' +
          '<p>Your cart is empty</p>' +
          '<a href="/catalog" class="btn btn-primary btn-sm">Start Shopping</a>' +
        '</div>';
      return;
    }

    cartItemsEl.innerHTML = items.map(function (item) {
      return '<div class="cart-item" data-key="' + esc(item.key) + '">' +
        '<img class="cart-item-img"' +
          ' src="' + esc(item.image || '/images/placeholder.svg') + '"' +
          ' alt="' + esc(item.name) + '"' +
          ' onerror="this.src=\'/images/placeholder.svg\'">' +
        '<div class="cart-item-body">' +
          '<div class="cart-item-name">' + esc(item.name) + '</div>' +
          '<div class="cart-item-meta">' + (item.size ? 'Size: ' + esc(item.size) : '') + '</div>' +
          '<div class="cart-item-row">' +
            '<span class="cart-item-price">' + fmt(item.price * item.qty) + '</span>' +
            '<div class="cart-qty-ctrl">' +
              '<button class="cart-qty-btn" data-action="dec" data-key="' + esc(item.key) + '">&#x2212;</button>' +
              '<span class="cart-qty-num">' + item.qty + '</span>' +
              '<button class="cart-qty-btn" data-action="inc" data-key="' + esc(item.key) + '">+</button>' +
            '</div>' +
          '</div>' +
          '<button class="cart-remove-btn" data-action="remove" data-key="' + esc(item.key) + '">Remove</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Delegated click handler for cart items
  if (cartItemsEl) {
    cartItemsEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      if (action === 'inc') Cart.updateQty(key, 1);
      else if (action === 'dec') Cart.updateQty(key, -1);
      else if (action === 'remove') Cart.remove(key);
      renderCart();
    });
  }

  cartToggle && cartToggle.addEventListener('click', function () {
    if (cartDrawer && cartDrawer.classList.contains('open')) closeCart();
    else openCart();
  });
  cartClose && cartClose.addEventListener('click', closeCart);
  cartOverlay && cartOverlay.addEventListener('click', closeCart);

  const cartContinueBtn = document.getElementById('cartContinueBtn');
  cartContinueBtn && cartContinueBtn.addEventListener('click', closeCart);

  // Keyboard: Escape closes all overlays
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      searchBarWrap && searchBarWrap.classList.remove('open');
      closeSidebar();
      closeCart();
    }
  });

  // Initialize badge on every page load
  renderCart();

  // ── Add to Cart (product detail page) ────────────────────────────────────
  const addToCartBtn = document.getElementById('addToCartBtn');
  if (addToCartBtn && !addToCartBtn.disabled) {
    addToCartBtn.addEventListener('click', function () {
      const sizeChips = document.querySelectorAll('.size-chip');
      const selectedChip = document.querySelector('.size-chip.selected');
      const sizeVal = selectedChip ? selectedChip.textContent.trim() : null;

      // Require a size when chips are present
      if (sizeChips.length > 0 && !sizeVal) {
        const sizeGrid = document.querySelector('.size-grid');
        if (sizeGrid) {
          sizeGrid.style.outline = '2px solid var(--accent)';
          sizeGrid.style.outlineOffset = '4px';
          sizeGrid.style.borderRadius = 'var(--radius)';
          setTimeout(function () {
            sizeGrid.style.outline = '';
            sizeGrid.style.outlineOffset = '';
          }, 2000);
        }
        return;
      }

      Cart.add({
        productId: this.dataset.productId,
        name: this.dataset.name,
        price: parseFloat(this.dataset.price),
        image: this.dataset.image,
        slug: this.dataset.slug,
        size: sizeVal,
      });

      renderCart();
      openCart();

      // Brief success state on button
      const original = this.innerHTML;
      this.innerHTML = '&#10003; Added!';
      this.style.background = '#16a34a';
      this.style.borderColor = '#16a34a';
      setTimeout(function () {
        addToCartBtn.innerHTML = original;
        addToCartBtn.style.background = '';
        addToCartBtn.style.borderColor = '';
      }, 1500);
    });
  }
})();
