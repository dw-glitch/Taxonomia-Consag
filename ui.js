/**
 * Taxonomia Consag v1.3 — UI Layer
 * Navegação, dashboard, gráficos, filtros, modal de evidências, paginação.
 * Nenhuma lógica de negócio aqui — apenas apresentação.
 */
(() => {
  'use strict';

  // ── Pagination state
  const PAGE_SIZE = 50;
  let currentPage = 1;
  let filteredRows = [];

  // ── Sort state
  let sortField = null;
  let sortDir = 'asc';

  /* ════════════════════════════════════════════════
     1. SIDEBAR NAVIGATION
  ════════════════════════════════════════════════ */
  const sidebar     = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const navItems    = document.querySelectorAll('.nav-item[data-view]');
  const views       = document.querySelectorAll('.view');
  const breadcrumb  = document.getElementById('topbarBreadcrumb');

  const VIEW_LABELS = {
    dashboard:     'Dashboard',
    base:          'Base CONSAG',
    lds:           'Listas de Documentos',
    analise:       'Análise de Documentos',
    sugestoes:     'Sugestões de Taxonomia',
    relatorios:    'Relatórios e Exportação',
    configuracoes: 'Configurações',
  };

  function switchView(name) {
    navItems.forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
    views.forEach(v => {
      const id = v.id.replace('view-', '');
      v.classList.toggle('hidden', id !== name);
    });
    if (breadcrumb) breadcrumb.textContent = VIEW_LABELS[name] || name;

    // Reveal empty state or results in "sugestoes"
    if (name === 'sugestoes') {
      const hasResults = document.getElementById('resultsBody')?.children.length > 0;
      const emptyCard  = document.getElementById('emptyResultsCard');
      if (emptyCard) emptyCard.style.display = hasResults ? 'none' : 'flex';
    }

    // Update report page counts
    if (name === 'relatorios') updateExportPreview();
  }

  navItems.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Sidebar collapse/expand
  function setSidebarCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    try { localStorage.setItem('taxonomia.sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    });
  }

  // Restore sidebar state
  try {
    if (localStorage.getItem('taxonomia.sidebarCollapsed') === '1') setSidebarCollapsed(true);
  } catch {}

  /* ════════════════════════════════════════════════
     2. BASE STATUS SYNC
     Mirror topbar indicator with baseStatus content
  ════════════════════════════════════════════════ */
  function syncBaseIndicator() {
    const baseStatus = document.getElementById('baseStatus');
    if (!baseStatus) return;
    const text = baseStatus.textContent || '';
    const isCustom = text.toLowerCase().includes('personalizada');
    const dot  = document.getElementById('baseIndicatorText')?.previousElementSibling;
    const label = document.getElementById('baseIndicatorText');
    if (dot)  dot.className = 'base-indicator-dot active';
    if (label) label.textContent = isCustom ? 'Base personalizada ativa' : 'Base incorporada ativa';

    // Also sync stats in base view sidebar
    const sideStatTypes = document.getElementById('baseSideStatTypes');
    const sideStatExamples = document.getElementById('baseSideStatExamples');
    const sideStatRefs = document.getElementById('baseSideStatRefs');
    const t = document.getElementById('statTypes');
    const e = document.getElementById('statExamples');
    const r = document.getElementById('statRefs');
    if (sideStatTypes && t)    sideStatTypes.textContent = t.textContent;
    if (sideStatExamples && e) sideStatExamples.textContent = e.textContent;
    if (sideStatRefs && r)     sideStatRefs.textContent = r.textContent;
  }

  // Observe statTypes for changes (app.js sets it on init)
  const statTypesEl = document.getElementById('statTypes');
  if (statTypesEl) {
    new MutationObserver(syncBaseIndicator).observe(statTypesEl, { childList: true, subtree: true, characterData: true });
  }
  setTimeout(syncBaseIndicator, 300);

  /* ════════════════════════════════════════════════
     3. LD LIST RENDERING OVERRIDE
     We intercept ldList changes to render beautiful cards
  ════════════════════════════════════════════════ */
  const ldList = document.getElementById('ldList');
  if (ldList) {
    const ldObs = new MutationObserver(() => {
      const isEmpty = ldList.classList.contains('file-list') && !ldList.innerHTML.includes('file-item');
      // If it became file-list class, reformat it nicely
      reformatLDList();
    });
    ldObs.observe(ldList, { childList: true, subtree: true, attributes: true });
  }

  function reformatLDList() {
    const ldList = document.getElementById('ldList');
    if (!ldList) return;

    const items = Array.from(ldList.querySelectorAll('.file-item'));
    if (!items.length) {
      ldList.className = 'file-list-empty';
      ldList.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".4">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
          <polyline points="13 2 13 9 20 9"/>
        </svg>
        <p>Nenhuma LD carregada.<br>A análise funciona com as referências incorporadas.</p>`;
      updateLDsBadge(0);
      updateKPI('kpiLdsCarregadas', 0);
      return;
    }

    // Build premium list
    ldList.className = 'file-list-loaded';
    const newContent = items.map(item => {
      const name = item.querySelector('strong')?.textContent || '';
      const meta = item.querySelector('small')?.textContent || item.querySelector('span:last-of-type')?.textContent || '';
      const removeBtn = item.querySelector('button');
      const removeDataAttr = removeBtn ? removeBtn.dataset.remove : '';
      return `
        <div class="file-item">
          <div class="file-item-icon">✓</div>
          <div class="file-item-body">
            <div class="file-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
            <div class="file-item-meta">${escapeHtml(meta)}</div>
          </div>
          <span class="file-item-status">✓ Carregado</span>
          ${removeDataAttr ? `<button class="file-item-remove" data-remove="${removeDataAttr}" title="Remover" onclick="document.querySelector('[data-remove=\\'${removeDataAttr}\\']')?.click()">×</button>` : ''}
        </div>`;
    }).join('');
    ldList.innerHTML = newContent;

    // Re-bind remove buttons
    ldList.querySelectorAll('.file-item-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const orig = document.querySelector(`[data-remove="${btn.dataset.remove}"]`);
        if (orig) orig.click();
      });
    });

    updateLDsBadge(items.length);
    updateKPI('kpiLdsCarregadas', items.length);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[ch]));
  }

  /* ════════════════════════════════════════════════
     4. RESULTS TABLE — ENHANCED RENDERING
  ════════════════════════════════════════════════ */
  const resultsBody = document.getElementById('resultsBody');

  let resultsObserver;
  if (resultsBody) {
    resultsObserver = new MutationObserver(() => {
      setTimeout(() => {
        enhanceResultsTable();
        updateKPIsFromResults();
        renderCharts();
        updateNavBadges();
        updateExportPreview();
        // Show sugestoes view automatically
        const hasRows = resultsBody.children.length > 0;
        if (hasRows) {
          document.querySelector('[data-view=sugestoes]')?.click();
        }
      }, 50);
    });
    resultsObserver.observe(resultsBody, { childList: true });
  }

  function confidenceClass(n) {
    if (n >= 95) return 'green';
    if (n >= 85) return 'blue';
    if (n >= 70) return 'yellow';
    return 'red';
  }

  function confidenceLabel(n) {
    if (n >= 95) return 'Alta';
    if (n >= 85) return 'Boa';
    if (n >= 70) return 'Média';
    return 'Baixa';
  }

  function enhanceResultsTable() {
    const rows = Array.from(resultsBody.querySelectorAll('tr'));
    rows.forEach((tr, idx) => {
      // Skip already-enhanced
      if (tr.dataset.enhanced) return;
      tr.dataset.enhanced = '1';

      // Enhance confidence badge → confidence bar
      const confBadge = tr.querySelector('.confidence-badge');
      if (confBadge) {
        const text = confBadge.textContent.trim();
        const match = text.match(/(\d+)%/);
        const n = match ? parseInt(match[1]) : 0;
        const cls = confidenceClass(n);
        confBadge.outerHTML = `
          <div class="confidence-bar conf--${cls}">
            <div class="confidence-bar-top">
              <span class="conf-value">${n}%</span>
              <span class="conf-label">${confidenceLabel(n)}</span>
            </div>
            <div class="conf-track">
              <div class="conf-fill" style="width:${n}%"></div>
            </div>
          </div>`;
      }

      // Enhance status badge
      const statusCells = tr.querySelectorAll('td');
      // Nothing more here — the original renderResults in app.js generates cells

      // Add "Ver Evidências" button in last column
      const lastTd = tr.querySelector('td:last-child');
      if (lastTd && !lastTd.querySelector('.btn-evidence')) {
        const btn = document.createElement('button');
        btn.className = 'btn-evidence';
        btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Evidências`;
        btn.addEventListener('click', () => {
          const rowIndex = parseInt(tr.dataset.index ?? idx);
          openEvidenceModal(rowIndex);
        });
        lastTd.appendChild(btn);
      }

      // Highlight rows that require review
      if (tr.querySelector('.confidence-bar.conf--red') || tr.querySelector('.confidence-bar.conf--yellow')) {
        // soft highlight handled by CSS classes already
      }
    });

    // Apply filters & pagination
    applyFilters();
  }

  /* ════════════════════════════════════════════════
     5. TABLE SEARCH & FILTERS
  ════════════════════════════════════════════════ */
  const tableSearch   = document.getElementById('tableSearch');
  const filterStatus  = document.getElementById('filterStatus');
  const filterConf    = document.getElementById('filterConfianca');
  const tableInfo     = document.getElementById('tableInfo');
  const tablePagination = document.getElementById('tablePagination');

  if (tableSearch)  tableSearch.addEventListener('input',  debounce(applyFilters, 150));
  if (filterStatus) filterStatus.addEventListener('change', applyFilters);
  if (filterConf)   filterConf.addEventListener('change',   applyFilters);

  function applyFilters() {
    const search = (tableSearch?.value || '').toLowerCase().trim();
    const statusFilter = filterStatus?.value || '';
    const confFilter   = filterConf?.value   || '';

    const allRows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    filteredRows = allRows.filter(tr => {
      const text = tr.textContent.toLowerCase();
      if (search && !text.includes(search)) return false;

      if (statusFilter) {
        const statusCell = tr.querySelector('.status-badge');
        if (!statusCell || !statusCell.textContent.includes(statusFilter)) return false;
      }

      if (confFilter) {
        const confEl = tr.querySelector('.conf-value');
        const n = confEl ? parseInt(confEl.textContent) : 0;
        if (confFilter === 'alta'      && n < 95)  return false;
        if (confFilter === 'media-alta' && (n < 85 || n >= 95)) return false;
        if (confFilter === 'media'     && (n < 70 || n >= 85)) return false;
        if (confFilter === 'baixa'     && n >= 70) return false;
      }
      return true;
    });

    currentPage = 1;
    renderPage();
  }

  function renderPage() {
    const allRows = Array.from(resultsBody?.querySelectorAll('tr') || []);

    // Hide all, show filtered+paginated
    allRows.forEach(tr => tr.style.display = 'none');

    const start = (currentPage - 1) * PAGE_SIZE;
    const end   = start + PAGE_SIZE;
    filteredRows.slice(start, end).forEach(tr => tr.style.display = '');

    // Update info
    const total = filteredRows.length;
    if (tableInfo) tableInfo.textContent = `${total.toLocaleString('pt-BR')} resultado${total !== 1 ? 's' : ''}`;

    // Pagination
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const pageInfo  = document.getElementById('pageInfo');
    const pagePrev  = document.getElementById('pagePrev');
    const pageNext  = document.getElementById('pageNext');

    if (tablePagination) tablePagination.style.display = total > PAGE_SIZE ? 'flex' : 'none';
    if (pageInfo) pageInfo.textContent = `Página ${currentPage} de ${totalPages || 1}`;
    if (pagePrev) pagePrev.disabled = currentPage <= 1;
    if (pageNext) pageNext.disabled = currentPage >= totalPages;
  }

  document.getElementById('pagePrev')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderPage(); }
  });
  document.getElementById('pageNext')?.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredRows.length / PAGE_SIZE);
    if (currentPage < totalPages) { currentPage++; renderPage(); }
  });

  /* ════════════════════════════════════════════════
     6. KPI DASHBOARD
  ════════════════════════════════════════════════ */
  function updateKPI(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const formatted = typeof value === 'number' ? value.toLocaleString('pt-BR') : value;
    if (el.textContent !== formatted) {
      el.textContent = formatted;
      el.style.animation = 'none';
      el.offsetHeight; // reflow
      el.style.animation = 'kpiIn .4s ease';
    }
  }

  function updateKPIsFromResults() {
    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    if (!rows.length) return;

    const total = rows.length;
    let analisados = 0, preenchidas = 0, emBranco = 0, aprovadas = 0, pendencias = 0;
    let confTotal = 0, confCount = 0;

    rows.forEach(tr => {
      const notFound = tr.classList.contains('not-found');
      if (!notFound) analisados++;

      const confEl = tr.querySelector('.conf-value');
      const n = confEl ? parseInt(confEl.textContent) : 0;
      if (n > 0) { confTotal += n; confCount++; }

      const chk = tr.querySelector('.row-check');
      if (chk && chk.checked) aprovadas++;

      const statusText = tr.textContent;
      if (statusText.includes('Taxonomia em branco') || statusText.includes('Taxonomia em Branco')) emBranco++;
      if (statusText.includes('Taxonomia preenchida')) preenchidas++;
      if (!notFound && !chk?.checked) pendencias++;
    });

    const confMedia = confCount ? Math.round(confTotal / confCount) : 0;
    const acuracia  = analisados ? Math.round((preenchidas / analisados) * 100) : 0;

    updateKPI('kpiTotal',      total);
    updateKPI('kpiAnalisados', analisados);
    updateKPI('kpiPreenchidas', preenchidas);
    updateKPI('kpiBranco',     emBranco);
    updateKPI('kpiAprovadas',  aprovadas);
    updateKPI('kpiPendencias', pendencias);
    updateKPI('kpiAcuracia',   acuracia + '%');
    updateKPI('kpiConfianca',  confMedia + '%');

    // Hide welcome card
    const welcomeCard = document.getElementById('welcomeCard');
    if (welcomeCard && total > 0) welcomeCard.style.display = 'none';
  }

  function updateLDsBadge(count) {
    const badge = document.getElementById('navBadgeLDs');
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
    updateKPI('kpiLdsCarregadas', count);
  }

  function updateNavBadges() {
    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    const badge = document.getElementById('navBadgeSugestoes');
    const emBranco = rows.filter(tr => !tr.classList.contains('not-found')).length;
    if (badge) {
      badge.textContent = emBranco;
      badge.style.display = emBranco > 0 ? 'flex' : 'none';
    }
  }

  /* ════════════════════════════════════════════════
     7. CANVAS CHARTS
  ════════════════════════════════════════════════ */
  function renderCharts() {
    renderConfidenceChart();
    renderStatusChart();
  }

  function renderConfidenceChart() {
    const canvas = document.getElementById('chartConfianca');
    const emptyEl = document.getElementById('chartConfEmpty');
    if (!canvas) return;

    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    if (!rows.length) { if (emptyEl) emptyEl.style.display = 'flex'; return; }
    if (emptyEl) emptyEl.style.display = 'none';

    const buckets = { 'Alta (≥95%)': 0, 'Boa (85–94%)': 0, 'Média (70–84%)': 0, 'Baixa (<70%)': 0 };
    const colors  = { 'Alta (≥95%)': '#00A86B', 'Boa (85–94%)': '#1565C0', 'Média (70–84%)': '#F7B500', 'Baixa (<70%)': '#D62828' };

    rows.forEach(tr => {
      const confEl = tr.querySelector('.conf-value');
      const n = confEl ? parseInt(confEl.textContent) : 0;
      if (n >= 95)      buckets['Alta (≥95%)']++;
      else if (n >= 85) buckets['Boa (85–94%)']++;
      else if (n >= 70) buckets['Média (70–84%)']++;
      else              buckets['Baixa (<70%)']++;
    });

    const parent = canvas.parentElement;
    canvas.width  = parent.clientWidth || 360;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const labels = Object.keys(buckets);
    const values = Object.values(buckets);
    const maxVal = Math.max(...values, 1);
    const barW   = Math.floor((canvas.width - 60) / labels.length) - 10;
    const chartH = canvas.height - 44;
    const baseY  = canvas.height - 30;

    labels.forEach((label, i) => {
      const x = 30 + i * (barW + 10);
      const h = Math.round((values[i] / maxVal) * chartH);
      const y = baseY - h;

      // Bar with rounded top
      ctx.fillStyle = colors[label] + '22';
      ctx.fillRect(x, y, barW, h);
      ctx.fillStyle = colors[label];
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, [4, 4, 0, 0]);
      ctx.fill();

      // Value
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 13px Inter, Segoe UI, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(values[i], x + barW / 2, y - 6);

      // Label
      ctx.fillStyle = '#64748B';
      ctx.font = '10px Inter, Segoe UI, Arial, sans-serif';
      const short = label.split(' ')[0];
      ctx.fillText(short, x + barW / 2, baseY + 14);
    });

    // Update badge
    const badge = document.getElementById('chartConfBadge');
    if (badge) badge.textContent = `${rows.length} documentos`;
  }

  function renderStatusChart() {
    const canvas  = document.getElementById('chartStatus');
    const emptyEl = document.getElementById('chartStatusEmpty');
    const legend  = document.getElementById('donutLegend');
    if (!canvas) return;

    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    if (!rows.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      if (legend)  legend.style.display = 'none';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (legend)  legend.style.display = 'flex';

    const cats = { 'Em branco': 0, 'Preenchida': 0, 'Não encontrado': 0, 'Revisão': 0 };
    const clrs = { 'Em branco': '#F7B500', 'Preenchida': '#00A86B', 'Não encontrado': '#D62828', 'Revisão': '#1565C0' };

    rows.forEach(tr => {
      if (tr.classList.contains('not-found')) { cats['Não encontrado']++; return; }
      const text = tr.textContent;
      if (text.includes('Taxonomia em branco') || text.includes('Taxonomia em Branco')) { cats['Em branco']++; return; }
      if (text.includes('Taxonomia preenchida')) { cats['Preenchida']++; return; }
      cats['Revisão']++;
    });

    const total = Object.values(cats).reduce((s, v) => s + v, 0) || 1;
    const parent = canvas.parentElement;
    canvas.width  = Math.min(parent.clientWidth || 240, 200);
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2, cy = canvas.height / 2;
    const r  = Math.min(cx, cy) - 10;
    const ri = r * 0.55;
    let angle = -Math.PI / 2;

    Object.entries(cats).forEach(([label, val]) => {
      const slice = (val / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = clrs[label];
      ctx.fill();
      angle += slice;
    });

    // Inner circle (donut hole)
    ctx.beginPath();
    ctx.arc(cx, cy, ri, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Center text
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 22px Inter, Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(total, cx, cy - 5);
    ctx.fillStyle = '#64748B';
    ctx.font = '10px Inter, Segoe UI, Arial';
    ctx.fillText('docs', cx, cy + 12);
    ctx.textBaseline = 'alphabetic';

    // Legend
    if (legend) {
      legend.innerHTML = Object.entries(cats).map(([label, val]) => `
        <div class="donut-legend-item">
          <span class="donut-legend-dot" style="background:${clrs[label]}"></span>
          <span class="donut-legend-label">${label}</span>
          <span class="donut-legend-value">${val}</span>
        </div>`).join('');
    }

    const badge = document.getElementById('chartStatusBadge');
    if (badge) badge.textContent = `${rows.length} analisados`;
  }

  /* ════════════════════════════════════════════════
     8. EVIDENCE MODAL
  ════════════════════════════════════════════════ */
  const modalOverlay  = document.getElementById('evidenceModalOverlay');
  const modalTitle    = document.getElementById('evidenceModalTitle');
  const modalCode     = document.getElementById('evidenceModalCode');
  const modalBody     = document.getElementById('evidenceModalBody');
  const modalClose    = document.getElementById('evidenceModalClose');

  if (modalClose) modalClose.addEventListener('click', closeEvidenceModal);
  if (modalOverlay) modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeEvidenceModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeEvidenceModal();
  });

  function openEvidenceModal(rowIndex) {
    // Access state.results from app.js (window scope via IIFE — we rely on it being globally available)
    // app.js defines state inside an IIFE, but results are accessible via the DOM
    const tr = resultsBody?.querySelector(`tr[data-index="${rowIndex}"]`);
    if (!tr) return;

    const code  = tr.querySelector('.doc-code')?.textContent || `Documento ${rowIndex + 1}`;
    const cells = Array.from(tr.querySelectorAll('td'));

    // Extract data from cells
    const title        = cells[2]?.querySelector('strong')?.textContent || '—';
    const discipline   = cells[2]?.querySelector('span')?.textContent   || '—';
    const statusEl     = cells[3]?.querySelector('.status-badge');
    const statusText   = statusEl ? statusEl.textContent.trim() : (cells[3]?.textContent.trim() || '—');
    const currentTax   = cells[4]?.querySelector('.tax-current')?.textContent?.trim() || '(vazio)';
    const suggestedTax = cells[5]?.querySelector('.tax-input')?.value || cells[5]?.textContent?.trim() || '—';
    const confEl       = cells[6]?.querySelector('.conf-value');
    const confidence   = confEl ? confEl.textContent : '—';
    const origin       = cells[7]?.querySelector('.origin-badge')?.textContent?.trim() || '—';
    const criterion    = cells[8]?.querySelector('.criteria')?.textContent?.trim() || cells[8]?.textContent?.trim() || '—';

    if (modalTitle) modalTitle.textContent = 'Evidências da Recomendação';
    if (modalCode)  modalCode.textContent  = code;

    // Parse taxonomy segments
    const taxParts = parseTaxSegments(suggestedTax);

    const confNum = parseInt(confidence) || 0;
    const confCls = confNum >= 95 ? 'green' : confNum >= 85 ? 'blue' : confNum >= 70 ? 'yellow' : 'red';
    const confLbl = confNum >= 95 ? 'Alta' : confNum >= 85 ? 'Boa' : confNum >= 70 ? 'Média' : 'Baixa';

    if (modalBody) {
      modalBody.innerHTML = `
        <!-- Summary -->
        <div class="evidence-section">
          <div class="evidence-section-title">Documento Analisado</div>
          <div class="evidence-summary-grid">
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Código</div>
              <div class="evidence-summary-value">${escapeHtml(code)}</div>
            </div>
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Confiança</div>
              <div class="evidence-summary-value">
                <span style="color:var(--${confCls === 'green' ? 'green' : confCls === 'yellow' ? 'yellow' : confCls === 'red' ? 'red' : 'blue-badge'})">${confidence} — ${confLbl}</span>
              </div>
            </div>
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Título</div>
              <div class="evidence-summary-value" style="font-family:inherit;font-size:12px">${escapeHtml(title)}</div>
            </div>
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Disciplina</div>
              <div class="evidence-summary-value" style="font-family:inherit;font-size:12px">${escapeHtml(discipline)}</div>
            </div>
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Origem</div>
              <div class="evidence-summary-value" style="font-family:inherit;font-size:12px">${escapeHtml(origin)}</div>
            </div>
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Status LD</div>
              <div class="evidence-summary-value" style="font-family:inherit;font-size:12px">${escapeHtml(statusText)}</div>
            </div>
          </div>
        </div>

        <!-- Taxonomias -->
        <div class="evidence-section">
          <div class="evidence-section-title">Taxonomias</div>
          <div class="evidence-summary-grid">
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Taxonomia Atual</div>
              <div class="evidence-summary-value">${escapeHtml(currentTax)}</div>
            </div>
            <div class="evidence-summary-item">
              <div class="evidence-summary-label">Taxonomia Sugerida</div>
              <div class="evidence-summary-value">${escapeHtml(suggestedTax)}</div>
            </div>
          </div>
        </div>

        <!-- Segmentos -->
        ${taxParts.length ? `
        <div class="evidence-section">
          <div class="evidence-section-title">Detalhamento por Segmento</div>
          <table class="evidence-table">
            <thead>
              <tr>
                <th>Segmento</th>
                <th>Campo</th>
                <th>Código</th>
                <th>Significado</th>
                <th>Peso</th>
              </tr>
            </thead>
            <tbody>
              ${taxParts.map((seg, i) => `
              <tr>
                <td><span class="evidence-weight">${i + 1}</span></td>
                <td style="font-weight:700;color:var(--navy)">${escapeHtml(seg.label)}</td>
                <td><span class="evidence-code">${escapeHtml(seg.value)}</span></td>
                <td>${escapeHtml(seg.meaning)}</td>
                <td><span class="evidence-weight">${seg.weight}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}

        <!-- Critério -->
        <div class="evidence-section">
          <div class="evidence-section-title">Critério de Classificação</div>
          <div style="padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-md);font-size:12px;color:var(--ink-md);line-height:1.6">
            ${escapeHtml(criterion)}
          </div>
        </div>

        <!-- Validação -->
        <div class="evidence-section">
          <div class="evidence-section-title">Conformidade com a Base Oficial</div>
          <div class="validation-notice ${confNum >= 85 ? 'validation-notice--ok' : confNum >= 70 ? 'validation-notice--warn' : 'validation-notice--error'}">
            <strong>${confNum >= 85 ? '✓ Conforme' : confNum >= 70 ? '⚠ Requer revisão' : '✗ Revisão obrigatória'}:</strong>
            ${confNum >= 85
              ? 'Taxonomia compatível com a base oficial CONSAG e validada por evidências suficientes.'
              : confNum >= 70
              ? 'Sugestão baseada em padrões históricos. Verificar conformidade com a matriz Tipo × Setor antes de aplicar.'
              : 'Evidências insuficientes para classificação automática segura. Classificação manual necessária.'}
          </div>
        </div>
      `;
    }

    modalOverlay?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeEvidenceModal() {
    modalOverlay?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function parseTaxSegments(tax) {
    if (!tax || typeof tax !== 'string') return [];
    const parts = tax.split('-');
    if (parts.length !== 8) return [];
    const FIELDS = [
      { label: 'Projeto/Obra', meaning: 'Identifica o estudo, obra ou AG.', weight: '31%' },
      { label: 'Tipo Documental', meaning: 'Classifica o tipo de documento ou registro.', weight: '24%' },
      { label: 'Setor Emissor', meaning: 'Identifica o setor responsável pela emissão.', weight: '8%' },
      { label: 'Etapa', meaning: 'Indica a etapa do projeto.', weight: '—' },
      { label: 'Frente', meaning: 'Indica a frente de serviço ou fase da proposta.', weight: '8%' },
      { label: 'Disciplina', meaning: 'Identifica a disciplina técnica do documento.', weight: '27%' },
      { label: 'Idioma', meaning: 'Indica o idioma do documento.', weight: '2%' },
      { label: 'Sequencial', meaning: 'Número único dentro do prefixo taxonômico.', weight: '—' },
    ];
    return parts.map((val, i) => ({ value: val, ...FIELDS[i] }));
  }

  /* ════════════════════════════════════════════════
     9. EXPORT PREVIEW
  ════════════════════════════════════════════════ */
  function updateExportPreview() {
    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    const countEl = document.getElementById('exportRowCount');
    if (countEl) countEl.textContent = `${rows.length.toLocaleString('pt-BR')} linha${rows.length !== 1 ? 's' : ''} de resultado`;

    // Update apply selected count
    const selectedRows = rows.filter(tr => tr.querySelector('.row-check')?.checked);
    const applyInfo = document.getElementById('applySelectedCount');
    if (applyInfo) {
      if (selectedRows.length > 0) {
        applyInfo.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span style="color:var(--green);font-weight:700">${selectedRows.length} sugestão${selectedRows.length !== 1 ? 'ões' : ''} selecionada${selectedRows.length !== 1 ? 's' : ''} para aplicação</span>`;
      } else {
        applyInfo.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>Selecione sugestões na aba Sugestões antes de aplicar</span>`;
      }
    }
  }

  /* ════════════════════════════════════════════════
     10. TABLE SORTING
  ════════════════════════════════════════════════ */
  document.querySelectorAll('.results-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = field;
        sortDir = 'asc';
      }
      document.querySelectorAll('.results-table thead th[data-sort]').forEach(t => {
        t.classList.remove('sorted-asc', 'sorted-desc');
      });
      th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      sortResults(field, sortDir);
    });
  });

  function sortResults(field, dir) {
    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    rows.sort((a, b) => {
      let va = '', vb = '';
      if (field === 'code') {
        va = a.querySelector('.doc-code')?.textContent || '';
        vb = b.querySelector('.doc-code')?.textContent || '';
      } else if (field === 'confidence') {
        va = parseInt(a.querySelector('.conf-value')?.textContent) || 0;
        vb = parseInt(b.querySelector('.conf-value')?.textContent) || 0;
        return dir === 'asc' ? va - vb : vb - va;
      }
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    rows.forEach(r => resultsBody.appendChild(r));
    filteredRows = rows;
    renderPage();
  }

  /* ════════════════════════════════════════════════
     11. STATUS BADGE ENHANCEMENT
     Runs once when results render, wraps status text in styled badges
  ════════════════════════════════════════════════ */
  function enhanceStatusBadges() {
    // Status text mapping (app.js sets status in the criteria cell or a specific pattern)
    // We look for cells that have plain status text and wrap them
    const rows = Array.from(resultsBody?.querySelectorAll('tr') || []);
    rows.forEach(tr => {
      if (tr.dataset.statusEnhanced) return;
      tr.dataset.statusEnhanced = '1';

      // The origin-badge is in col-origin (td index 7 in new table)
      // Status is not explicitly rendered as a separate cell in original app.js
      // We add a visual indicator to the code cell based on row class
      const codeTd = tr.querySelector('.doc-code');
      if (codeTd) {
        if (tr.classList.contains('not-found')) {
          codeTd.style.color = 'var(--red)';
        }
      }
    });
  }

  /* ════════════════════════════════════════════════
     12. TOAST ENHANCEMENT
  ════════════════════════════════════════════════ */
  // Observe toast changes to add appropriate icon
  const toastEl = document.getElementById('toast');
  if (toastEl) {
    new MutationObserver(() => {
      if (!toastEl.classList.contains('show')) return;
      const isError = toastEl.classList.contains('error');
      const icon = isError
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
      if (!toastEl.querySelector('svg')) {
        const span = document.createElement('span');
        span.innerHTML = icon;
        span.style.flexShrink = '0';
        toastEl.insertBefore(span, toastEl.firstChild);
      }
    }).observe(toastEl, { attributes: true });
  }

  /* ════════════════════════════════════════════════
     13. DROPZONE KEYBOARD SUPPORT
  ════════════════════════════════════════════════ */
  const ldDrop = document.getElementById('ldDrop');
  if (ldDrop) {
    ldDrop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        document.getElementById('ldFiles')?.click();
      }
    });
  }

  /* ════════════════════════════════════════════════
     14. ANIMATE KPI ON CSS
  ════════════════════════════════════════════════ */
  const kpiStyle = document.createElement('style');
  kpiStyle.textContent = `
    @keyframes kpiIn {
      from { opacity: 0.5; transform: scale(0.95); }
      to   { opacity: 1;   transform: scale(1); }
    }
  `;
  document.head.appendChild(kpiStyle);

  /* ════════════════════════════════════════════════
     15. UTILITY
  ════════════════════════════════════════════════ */
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ════════════════════════════════════════════════
     16. INIT
  ════════════════════════════════════════════════ */
  function init() {
    // Show welcome card initially
    const welcomeCard = document.getElementById('welcomeCard');
    if (welcomeCard) welcomeCard.style.display = 'block';

    // Initial KPI sync
    setTimeout(() => {
      syncBaseIndicator();
      // Show empty state for sugestoes
      const emptyCard = document.getElementById('emptyResultsCard');
      if (emptyCard) emptyCard.style.display = 'flex';
    }, 400);

    console.info('[Taxonomia Consag UI] Interface v1.3 inicializada.');
  }

  init();
})();
