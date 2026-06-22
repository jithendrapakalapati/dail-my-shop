'use strict';

(function () {
  var CART_KEY = 'shop_cart';

  function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function fmt(n) { return '$' + parseFloat(n).toFixed(2); }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var summaryEl    = document.getElementById('checkoutSummaryItems');
  var subtotalEl   = document.getElementById('checkoutSubtotal');
  var shippingEl   = document.getElementById('checkoutShipping');
  var totalEl      = document.getElementById('checkoutTotal');
  var layoutEl     = document.getElementById('checkoutContent');
  var emptyEl      = document.getElementById('checkoutEmpty');
  var placeOrderBtn = document.getElementById('placeOrderBtn');

  function renderSummary() {
    var items = getCart();

    if (!items.length) {
      if (layoutEl) layoutEl.style.display = 'none';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    var subtotal = items.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
    var shipping = subtotal >= 50 ? 0 : 9.99;
    var total = subtotal + shipping;

    if (summaryEl) {
      summaryEl.innerHTML = items.map(function (item) {
        return '<div class="summary-item">' +
          '<img class="summary-item-img"' +
            ' src="' + esc(item.image || '/images/placeholder.svg') + '"' +
            ' alt="' + esc(item.name) + '"' +
            ' onerror="this.src=\'/images/placeholder.svg\'">' +
          '<div class="summary-item-details">' +
            '<div class="summary-item-name">' + esc(item.name) + '</div>' +
            '<div class="summary-item-meta">' +
              (item.size ? 'Size: ' + esc(item.size) + ' &middot; ' : '') +
              'Qty: ' + item.qty +
            '</div>' +
          '</div>' +
          '<div class="summary-item-price">' + fmt(item.price * item.qty) + '</div>' +
        '</div>';
      }).join('');
    }

    if (subtotalEl) subtotalEl.textContent = fmt(subtotal);
    if (shippingEl) shippingEl.textContent = shipping === 0 ? 'Free' : fmt(shipping);
    if (totalEl) totalEl.textContent = fmt(total);
  }

  renderSummary();

  // Card number auto-formatting
  var cardNumberInput = document.getElementById('cardNumber');
  if (cardNumberInput) {
    cardNumberInput.addEventListener('input', function () {
      var val = this.value.replace(/\D/g, '').slice(0, 16);
      this.value = val.replace(/(.{4})/g, '$1 ').trim();
    });
  }

  // Expiry auto-formatting
  var cardExpiryInput = document.getElementById('cardExpiry');
  if (cardExpiryInput) {
    cardExpiryInput.addEventListener('input', function () {
      var val = this.value.replace(/\D/g, '').slice(0, 4);
      if (val.length > 2) val = val.slice(0, 2) + '/' + val.slice(2);
      this.value = val;
    });
  }

  // Place order
  if (placeOrderBtn) {
    placeOrderBtn.addEventListener('click', function () {
      var items = getCart();
      if (!items.length) return;

      var firstName = (document.getElementById('firstName') || {}).value || '';
      var lastName  = (document.getElementById('lastName')  || {}).value || '';
      var email     = (document.getElementById('email')     || {}).value || '';
      var phone     = (document.getElementById('phone')     || {}).value || '';
      var address   = (document.getElementById('address')   || {}).value || '';
      var address2  = (document.getElementById('address2')  || {}).value || '';
      var city      = (document.getElementById('city')      || {}).value || '';
      var state     = (document.getElementById('state')     || {}).value || '';
      var zip       = (document.getElementById('zip')       || {}).value || '';
      var country   = (document.getElementById('country')   || {}).value || 'US';
      var cardName   = (document.getElementById('cardName')   || {}).value || '';
      var cardNumber = (document.getElementById('cardNumber') || {}).value || '';
      var cardExpiry = (document.getElementById('cardExpiry') || {}).value || '';
      var cardCvv    = (document.getElementById('cardCvv')    || {}).value || '';

      // Trim all values
      firstName = firstName.trim(); lastName = lastName.trim();
      email = email.trim(); address = address.trim();
      city = city.trim(); state = state.trim(); zip = zip.trim();
      cardName = cardName.trim(); cardNumber = cardNumber.trim();
      cardExpiry = cardExpiry.trim(); cardCvv = cardCvv.trim();

      if (!firstName || !lastName || !email || !address || !city || !state || !zip) {
        alert('Please fill in all required contact and shipping fields.');
        return;
      }
      if (!cardName || !cardNumber || !cardExpiry || !cardCvv) {
        alert('Please fill in your payment information.');
        return;
      }

      var btn = this;
      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Placing order…';

      fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: {
            name: firstName + ' ' + lastName,
            email: email,
            phone: phone.trim(),
            address: {
              line1: address,
              line2: address2.trim(),
              city: city,
              state: state,
              zip: zip,
              country: country,
            },
          },
          items: items.map(function (i) {
            return {
              productId: i.productId,
              name: i.name,
              price: i.price,
              qty: i.qty,
              size: i.size || null,
              slug: i.slug,
            };
          }),
        }),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || 'Order failed');
            return data;
          });
        })
        .then(function (data) {
          localStorage.removeItem(CART_KEY);
          window.location.href = '/order/' + data.orderId;
        })
        .catch(function (err) {
          alert('Failed to place order: ' + err.message);
          btn.disabled = false;
          btn.textContent = originalText;
        });
    });
  }
})();
