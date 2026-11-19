/* QORVEXA DIGITAL BANK — progressive enhancement (all features also work without JS). */
(function () {
  'use strict';
  document.documentElement.classList.remove('no-js');
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const csrf = ($('meta[name="csrf-token"]') || {}).content || '';

  // Mobile top navigation
  $$('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const target = $(btn.getAttribute('data-toggle'));
    if (!target) return;
    const open = target.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  }));

  // App sidebar (mobile)
  const sidebar = $('#sidebar');
  const backdrop = $('.sidebar-backdrop');
  const setSidebar = (open) => { if (!sidebar) return; sidebar.classList.toggle('open', open); if (backdrop) backdrop.classList.toggle('show', open); };
  $$('[data-open-sidebar]').forEach((b) => b.addEventListener('click', () => setSidebar(true)));
  $$('[data-close-sidebar]').forEach((b) => b.addEventListener('click', () => setSidebar(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSidebar(false); });

  // Dismissible alerts
  $$('.alert-close').forEach((b) => b.addEventListener('click', () => b.closest('.alert').remove()));

  // Scroll reveal
  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window && reveals.length) {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.12 });
    reveals.forEach((r) => io.observe(r));
  } else reveals.forEach((r) => r.classList.add('in'));

  // Confirmation prompts
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); }));
  $$('[data-confirm-click]').forEach((b) => b.addEventListener('click', (e) => { if (!window.confirm(b.getAttribute('data-confirm-click'))) e.preventDefault(); }));

  // Prevent double submission on money-moving forms (server is idempotent as well)
  $$('form[data-once]').forEach((f) => f.addEventListener('submit', (e) => {
    if (f.dataset.submitted) { e.preventDefault(); return; }
    if (!f.checkValidity()) return;
    f.dataset.submitted = '1';
    const btn = $('button[type="submit"]', f);
    if (btn) { btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true'); }
  }));

  // Print buttons
  $$('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

  // Show/hide password
  $$('[data-toggle-password]').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
  }));

  // Password strength meter
  $$('input[data-strength]').forEach((input) => {
    const wrap = input.closest('form').querySelector('.strength-bar i');
    if (!wrap) return;
    input.addEventListener('input', () => {
      const v = input.value; let s = 0;
      if (v.length >= 10) s++; if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++; if (/\d/.test(v)) s++; if (/[^A-Za-z0-9]/.test(v)) s++; if (v.length >= 14) s++;
      wrap.style.width = (s * 20) + '%';
      wrap.style.background = s <= 2 ? '#B42318' : s <= 3 ? '#C9A227' : '#12805A';
    });
  });

  // Recipient name enquiry
  $$('[data-lookup]').forEach((btn) => btn.addEventListener('click', async () => {
    const input = $(btn.getAttribute('data-lookup'));
    const out = $(btn.getAttribute('data-target'));
    const q = (input.value || '').trim();
    out.className = 'lookup-result';
    if (q.length < 3) { out.classList.add('err'); out.textContent = 'Enter an account number or username first.'; return; }
    btn.disabled = true; out.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/recipient?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json', 'X-CSRF-Token': csrf }, credentials: 'same-origin' });
      const data = await res.json();
      if (res.ok) { out.classList.add('ok'); out.textContent = '✓ ' + data.name + ' · ' + data.accountNumber; }
      else { out.classList.add('err'); out.textContent = data.error || 'Recipient not found.'; }
    } catch (err) { out.classList.add('err'); out.textContent = 'Could not verify right now. You can still continue — we verify again on the next step.'; }
    btn.disabled = false;
  }));

  // Charts
  const parse = (el, k) => { try { return JSON.parse(el.getAttribute('data-' + k) || '[]'); } catch (e) { return []; } };
  const money = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  function drawCharts() {
    if (!window.Chart) return;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = '#5F6B7E';
    const base = { responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: 'easeOutQuart' },
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + (c.dataset.money === false ? c.raw : '$' + Number(c.raw).toLocaleString('en-US', { minimumFractionDigits: 2 })) } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#EEF1F6' }, ticks: { callback: money } } } };
    $$('canvas[data-chart]').forEach((el) => {
      const kind = el.getAttribute('data-chart');
      const labels = parse(el, 'labels');
      if (kind === 'history') {
        new Chart(el, { type: 'bar', data: { labels, datasets: [
          { label: 'Money in', data: parse(el, 'credits'), backgroundColor: '#C9A227', borderRadius: 6, maxBarThickness: 28 },
          { label: 'Money out', data: parse(el, 'debits'), backgroundColor: '#12305A', borderRadius: 6, maxBarThickness: 28 } ] }, options: base });
      } else if (kind === 'admin-volume') {
        new Chart(el, { type: 'line', data: { labels, datasets: [
          { label: 'Deposits', data: parse(el, 'deposits'), borderColor: '#12805A', backgroundColor: 'rgba(18,128,90,.08)', fill: true, tension: .35 },
          { label: 'Transfers', data: parse(el, 'transfers'), borderColor: '#C9A227', backgroundColor: 'rgba(201,162,39,.08)', fill: true, tension: .35 },
          { label: 'Withdrawals', data: parse(el, 'withdrawals'), borderColor: '#12305A', backgroundColor: 'rgba(18,48,90,.06)', fill: true, tension: .35 } ] }, options: base });
      } else if (kind === 'admin-registrations') {
        const opts = JSON.parse(JSON.stringify({ ...base, plugins: { legend: { display: false } } }));
        opts.scales.y.ticks = { precision: 0 };
        new Chart(el, { type: 'bar', data: { labels, datasets: [{ label: 'New customers', money: false, data: parse(el, 'values'), backgroundColor: '#C9A227', borderRadius: 6, maxBarThickness: 22 }] }, options: opts });
      }
    });
  }
  if (document.readyState === 'complete') drawCharts(); else window.addEventListener('load', drawCharts);
})();
