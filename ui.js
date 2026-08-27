/**
 * Taxonomia Consag v1.3 — UI Layer (v2)
 * Fluxo unificado. Sem MutationObserver recursivo. Sem pulos de aba.
 */
(() => {
  'use strict';

  /* ══════════════════════════════════════
     NAVEGAÇÃO SIDEBAR
  ══════════════════════════════════════ */
  const sidebar   = document.getElementById('sidebar');
  const sbToggle  = document.getElementById('sidebarToggle');
  const navItems  = document.querySelectorAll('.nav-item[data-view]');
  const views     = document.querySelectorAll('.view');
  const breadcrumb = document.getElementById('topbarBreadcrumb');

  const LABELS = {
    dashboard: 'Dashboard', base: 'Base CONSAG',
    workflow: 'Fluxo de Trabalho', relatorios: 'Relatórios', configuracoes: 'Configurações',
  };

  function switchView(name) {
    navItems.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    views.forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
    if (breadcrumb) breadcrumb.textContent = LABELS[name] || name;
    if (name === 'dashboard') { renderCharts(); syncKPIs(); }
  }

  navItems.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

  // Sidebar collapse
  function setSBCollapsed(v) {
    sidebar.classList.toggle('collapsed', v);
    document.body.classList.toggle('sb-collapsed', v);
    try { localStorage.setItem('tax.sbc', v ? '1' : '0'); } catch {}
  }
  sbToggle?.addEventListener('click', () => setSBCollapsed(!sidebar.classList.contains('collapsed')));
  try { if (localStorage.getItem('tax.sbc') === '1') setSBCollapsed(true); } catch {}

  /* ══════════════════════════════════════
     SYNC BASE INDICATOR
  ══════════════════════════════════════ */
  function syncBaseStatus() {
    const bsEl = document.getElementById('baseStatus');
    const text = bsEl ? bsEl.textContent : '';
    const isCustom = text.toLowerCase().includes('personalizada');
    const dot  = document.querySelector('.base-dot');
    const label = document.getElementById('baseIndicatorMiniText');
    if (dot)  dot.className = 'base-dot active';
    if (label) label.textContent = isCustom ? 'Base personalizada' : 'Base incorporada';

    // Sync stat cells
    const t = document.getElementById('statTypes');
    const e = document.getElementById('statExamples');
    const r = document.getElementById('statRefs');
    ['baseSideTypes','baseStat1'].forEach(id => { const el = document.getElementById(id); if (el && t) el.textContent = t.textContent; });
    ['statExamples2','baseStat2'].forEach(id => { const el = document.getElementById(id); if (el && e) el.textContent = e.textContent; });
    ['baseStat3'].forEach(id => { const el = document.getElementById(id); if (el && r) el.textContent = r.textContent; });
  }

  // Mirror stat changes (app.js sets statTypes on init)
  const statTypesEl = document.getElementById('statTypes');
  if (statTypesEl) {
    new MutationObserver(syncBaseStatus).observe(statTypesEl, { childList: true, subtree: true, characterData: true });
  }
  setTimeout(syncBaseStatus, 500);

  /* ══════════════════════════════════════
     DROPZONE KEYBOARD SUPPORT
  ══════════════════════════════════════ */
  const ldDrop = document.getElementById('ldDrop');
  ldDrop?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('ldFiles')?.click(); }
  });

  /* ══════════════════════════════════════
     LD LIST — reformata em cards visuais
     Fired by app.js after loading files
  ══════════════════════════════════════ */
  function reformatLDList() {
    const list = document.getElementById('ldList');
    if (!list) return;

    // app.js renders items with class "file-item" inside ldList
    const items = Array.from(list.querySelectorAll('.file-item'));

    if (!items.length) {
      list.className = 'ld-empty';
      list.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
          <polyline points="13 2 13 9 20 9"/>
        </svg>
        <p>Nenhuma LD carregada.<br>A análise usa as referências incorporadas.</p>`;
      updateLDBadge(0);
      return;
    }

    const html = items.map(item => {
      const name = item.querySelector('strong')?.textContent || '';
      const meta = item.querySelector('small,span:not(.badge)')?.textContent || '';
      return `
        <div class="ld-item">
          <div class="ld-item-icon">✓</div>
          <div class="ld-item-body">
            <div class="ld-item-name" title="${esc(name)}">${esc(name)}</div>
            <div class="ld-item-meta">${esc(meta)}</div>
          </div>
          <span class="ld-item-ok">✓ Carregado</span>
        </div>`;
    }).join('');

    list.className = 'ld-loaded';
    list.innerHTML = html;
    updateLDBadge(items.length);
    updateKPI('kpiLdsCarregadas', items.length);
  }

  // Watch ldList for changes from app.js
  const ldListEl = document.getElementById('ldList');
  if (ldListEl) {
    let ldTimer;
    new MutationObserver(() => {
      clearTimeout(ldTimer);
      ldTimer = setTimeout(reformatLDList, 80);
    }).observe(ldListEl, { childList: true, subtree: true, attributes: true });
  }

  /* ══════════════════════════════════════
     RESULTS — chamado pelo app.js via
     ponto de extensão (veja final do arquivo)
  ══════════════════════════════════════ */

  // Estado interno de paginação/filtragem
  let allRows    = [];
  let filtered   = [];
  let page       = 1;
  const PER_PAGE = 50;

  /**
   * Ponto de entrada principal.
   * Chamado UMA VEZ após renderResults() do app.js terminar de injetar o DOM.
   */
  function onResultsReady() {
    allRows  = Array.from(document.querySelectorAll('#resultsBody tr'));
    filtered = allRows.slice();

    // 1. Enhance badges (confiança → barra visual, ação → botão)
    enhanceRows(allRows);

    // 2. Aplicar filtros/paginação
    applyFilters();

    // 3. KPIs + gráficos (diferido para não travar)
    setTimeout(() => { syncKPIs(); renderCharts(); updateExportInfo(); }, 100);

    // 4. Hide progress bar
    hideProgress();

    // 5. Stats row
    const total   = allRows.length;
    const prontas = allRows.filter(r => r.querySelector('.row-check:not(:disabled)')?.checked).length;
    const revisar = allRows.filter(r => {
      const cv = r.querySelector('.conf-val');
      return cv && parseInt(cv.textContent) < 70;
    }).length;
    const ws = document.getElementById('workflowStats');
    if (ws) {
      ws.style.display = 'flex';
      const setWF = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
      setWF('wfStatTotal',  `${total} documentos`);
      setWF('wfStatProntas', `${prontas} prontos`);
      setWF('wfStatRevisar', `${revisar} revisar`);
    }
  }

  /* ── Enhance individual rows ── */
  function enhanceRows(rows) {
    rows.forEach((tr, idx) => {
      if (tr.dataset.uiDone) return;
      tr.dataset.uiDone = '1';

      // Confiança badge → barra
      const badge = tr.querySelector('.confidence-badge');
      if (badge) {
        const text = badge.textContent.trim();
        const m = text.match(/(\d+)%/);
        const n = m ? parseInt(m[1]) : 0;
        const cls = n >= 95 ? 'green' : n >= 85 ? 'blue' : n >= 70 ? 'yellow' : 'red';
        const lbl = n >= 95 ? 'Alta' : n >= 85 ? 'Boa' : n >= 70 ? 'Média' : 'Baixa';
        const td = badge.closest('td');
        if (td) {
          td.innerHTML = `
            <div class="conf-bar cb--${cls}">
              <div class="conf-bar-top">
                <span class="conf-val">${n}%</span>
                <span class="conf-lbl">${lbl}</span>
              </div>
              <div class="conf-track">
                <div class="conf-track-fill" style="width:${n}%"></div>
              </div>
            </div>`;
        }
      }

      // Ação → botão evidências
      const actionTd = tr.querySelector('td.col-action, td:last-child');
      if (actionTd && !actionTd.querySelector('.btn-evidence')) {
        const rowIndex = parseInt(tr.dataset.index ?? idx);
        const btn = document.createElement('button');
        btn.className = 'btn-evidence';
        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Ver`;
        btn.addEventListener('click', () => openEvidence(tr, rowIndex));
        actionTd.appendChild(btn);
      }

      // Row review highlight
      const confVal = tr.querySelector('.conf-val');
      if (confVal && parseInt(confVal.textContent) < 70 && !tr.classList.contains('not-found')) {
        tr.classList.add('row-review');
      }
    });
  }

  /* ── Filters ── */
  const tableSearch  = document.getElementById('tableSearch');
  const filterStatus = document.getElementById('filterStatus');
  const filterConf   = document.getElementById('filterConfianca');

  tableSearch?.addEventListener('input',  debounce(applyFilters, 120));
  filterStatus?.addEventListener('change', applyFilters);
  filterConf?.addEventListener('change',   applyFilters);

  function applyFilters() {
    const q      = (tableSearch?.value || '').toLowerCase().trim();
    const status = filterStatus?.value || '';
    const conf   = filterConf?.value   || '';

    filtered = allRows.filter(tr => {
      if (q && !tr.textContent.toLowerCase().includes(q)) return false;
      if (status) {
        const sb = tr.querySelector('.status-badge');
        if (!sb || !sb.textContent.includes(status)) return false;
      }
      if (conf) {
        const cv = tr.querySelector('.conf-val');
        const n  = cv ? parseInt(cv.textContent) : 0;
        if (conf === 'alta'   && n < 95)  return false;
        if (conf === 'boa'    && (n < 85 || n >= 95)) return false;
        if (conf === 'media'  && (n < 70 || n >= 85)) return false;
        if (conf === 'baixa'  && n >= 70) return false;
      }
      return true;
    });

    page = 1;
    renderPage();
  }

  function renderPage() {
    allRows.forEach(tr => tr.style.display = 'none');

    const start = (page - 1) * PER_PAGE;
    filtered.slice(start, start + PER_PAGE).forEach(tr => tr.style.display = '');

    const total = filtered.length;
    const pages = Math.ceil(total / PER_PAGE) || 1;

    const info = document.getElementById('tableInfo');
    if (info) info.textContent = `${total.toLocaleString('pt-BR')} resultado${total !== 1 ? 's' : ''}`;

    const pag = document.getElementById('tablePagination');
    if (pag) pag.style.display = total > PER_PAGE ? 'flex' : 'none';

    const pi = document.getElementById('pageInfo');
    const pp = document.getElementById('pagePrev');
    const pn = document.getElementById('pageNext');
    if (pi) pi.textContent = `Página ${page} de ${pages}`;
    if (pp) pp.disabled = page <= 1;
    if (pn) pn.disabled = page >= pages;
  }

  document.getElementById('pagePrev')?.addEventListener('click', () => { if (page > 1) { page--; renderPage(); } });
  document.getElementById('pageNext')?.addEventListener('click', () => {
    if (page < Math.ceil(filtered.length / PER_PAGE)) { page++; renderPage(); }
  });

  /* ══════════════════════════════════════
     KPIS
  ══════════════════════════════════════ */
  function updateKPI(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    const s = typeof val === 'number' ? val.toLocaleString('pt-BR') : String(val);
    if (el.textContent !== s) el.textContent = s;
  }

  function syncKPIs() {
    const rows = allRows;
    if (!rows.length) return;

    let preenchidas = 0, emBranco = 0, prontas = 0, revisar = 0, confSum = 0, confCount = 0;

    rows.forEach(tr => {
      if (tr.classList.contains('not-found')) return;

      const cvEl = tr.querySelector('.conf-val');
      const n = cvEl ? parseInt(cvEl.textContent) : 0;
      if (n > 0) { confSum += n; confCount++; }

      const text = tr.textContent;
      const hasBranco = tr.querySelector('.blank-badge, .status-badge--blank');
      if (hasBranco) emBranco++;

      const isFilled = tr.querySelector('.status-badge--filled');
      if (isFilled) preenchidas++;

      const chk = tr.querySelector('.row-check');
      if (chk?.checked) prontas++;
      if (n > 0 && n < 70) revisar++;
    });

    const total = rows.length;
    const confMedia = confCount ? Math.round(confSum / confCount) : 0;

    updateKPI('kpiTotal',      total);
    updateKPI('kpiPreenchidas', preenchidas);
    updateKPI('kpiBranco',     emBranco);
    updateKPI('kpiAprovadas',  prontas);
    updateKPI('kpiPendencias', revisar);
    updateKPI('kpiConfianca',  confMedia + '%');
  }

  function updateLDBadge(n) {
    const b = document.getElementById('navBadgeLDs');
    if (!b) return;
    b.textContent = n;
    b.style.display = n > 0 ? 'flex' : 'none';
    updateKPI('kpiLdsCarregadas', n);
  }

  function updateExportInfo() {
    const n = allRows.length;
    const el = document.getElementById('exportRowCount');
    if (el) el.textContent = `${n.toLocaleString('pt-BR')} linha${n !== 1 ? 's' : ''} de resultado`;

    const sel = allRows.filter(r => r.querySelector('.row-check')?.checked).length;
    const info = document.getElementById('applyCountInfo');
    if (info) {
      info.textContent = sel > 0
        ? `${sel} sugestão${sel !== 1 ? 'ões' : ''} selecionada${sel !== 1 ? 's' : ''} para aplicação`
        : 'Selecione sugestões no Fluxo de Trabalho antes de aplicar';
    }
  }

  /* ══════════════════════════════════════
     PROGRESS BAR (durante análise)
  ══════════════════════════════════════ */
  function showProgress(label) {
    const w = document.getElementById('progressWrap');
    if (w) w.style.display = 'block';
    const l = document.getElementById('progressLabel');
    if (l) l.textContent = label || 'Processando…';
  }

  function setProgress(pct, label) {
    const f = document.getElementById('progressFill');
    if (f) f.style.width = pct + '%';
    const l = document.getElementById('progressLabel');
    if (l && label) l.textContent = label;
  }

  function hideProgress() {
    const w = document.getElementById('progressWrap');
    if (w) {
      const f = document.getElementById('progressFill');
      if (f) f.style.width = '100%';
      setTimeout(() => { w.style.display = 'none'; }, 600);
    }
  }

  /* Expor para app.js usar */
  window._uiProgress = { show: showProgress, set: setProgress, hide: hideProgress };

  /* ══════════════════════════════════════
     CHARTS (somente quando Dashboard aberto)
  ══════════════════════════════════════ */
  function renderCharts() {
    renderBarChart();
    renderDonut();
  }

  function renderBarChart() {
    const canvas = document.getElementById('chartConfianca');
    const emptyEl = document.getElementById('chartConfEmpty');
    if (!canvas) return;

    if (!allRows.length) { if (emptyEl) emptyEl.style.display = 'flex'; canvas.style.display = 'none'; return; }
    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = 'block';

    const buckets = [0, 0, 0, 0]; // alta, boa, media, baixa
    allRows.forEach(tr => {
      const cv = tr.querySelector('.conf-val');
      const n = cv ? parseInt(cv.textContent) : 0;
      if (n >= 95) buckets[0]++;
      else if (n >= 85) buckets[1]++;
      else if (n >= 70) buckets[2]++;
      else buckets[3]++;
    });

    const colors = ['#00A86B','#1565C0','#F7B500','#D62828'];
    const labels = ['Alta','Boa','Média','Baixa'];
    const parent = canvas.parentElement;
    canvas.width  = (parent?.clientWidth || 360) - 4;
    canvas.height = 190;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const max = Math.max(...buckets, 1);
    const bw  = Math.floor((canvas.width - 60) / 4) - 10;
    const ch  = canvas.height - 40;
    const by  = canvas.height - 26;

    buckets.forEach((val, i) => {
      const x = 22 + i * (bw + 10);
      const h = Math.round((val / max) * ch);
      const y = by - h;
      ctx.fillStyle = colors[i] + '22';
      ctx.fillRect(x, y, bw, h);
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, bw, h, [4, 4, 0, 0]);
      else ctx.rect(x, y, bw, h);
      ctx.fill();
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 12px Inter,Segoe UI,Arial';
      ctx.textAlign = 'center';
      if (val > 0) ctx.fillText(val, x + bw / 2, y - 5);
      ctx.fillStyle = '#64748B';
      ctx.font = '10px Inter,Segoe UI,Arial';
      ctx.fillText(labels[i], x + bw / 2, by + 13);
    });

    const meta = document.getElementById('chartConfMeta');
    if (meta) meta.textContent = `${allRows.length} docs`;
  }

  function renderDonut() {
    const canvas  = document.getElementById('chartStatus');
    const emptyEl = document.getElementById('chartStatusEmpty');
    const legend  = document.getElementById('donutLegend');
    if (!canvas) return;

    if (!allRows.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      canvas.style.display = 'none';
      if (legend) legend.innerHTML = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = 'block';

    const cats  = { 'Em branco': 0, 'Preenchida': 0, 'Não encontrado': 0, 'Outros': 0 };
    const clrs  = { 'Em branco': '#F7B500', 'Preenchida': '#00A86B', 'Não encontrado': '#D62828', 'Outros': '#1565C0' };

    allRows.forEach(tr => {
      if (tr.classList.contains('not-found')) { cats['Não encontrado']++; return; }
      if (tr.querySelector('.status-badge--blank'))  { cats['Em branco']++; return; }
      if (tr.querySelector('.status-badge--filled'))  { cats['Preenchida']++; return; }
      cats['Outros']++;
    });

    const total = Object.values(cats).reduce((s, v) => s + v, 0) || 1;
    const parent = canvas.parentElement;
    canvas.width  = Math.min((parent?.clientWidth || 200) - 4, 180);
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2, cy = canvas.height / 2;
    const r  = Math.min(cx, cy) - 8;
    const ri = r * 0.54;
    let ang = -Math.PI / 2;

    Object.entries(cats).forEach(([label, val]) => {
      const slice = (val / total) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang, ang + slice);
      ctx.closePath(); ctx.fillStyle = clrs[label]; ctx.fill();
      ang += slice;
    });

    ctx.beginPath(); ctx.arc(cx, cy, ri, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();

    ctx.fillStyle = '#0F172A'; ctx.font = 'bold 18px Inter,Segoe UI,Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(total, cx, cy - 4);
    ctx.fillStyle = '#64748B'; ctx.font = '10px Inter,Segoe UI,Arial';
    ctx.fillText('docs', cx, cy + 11);
    ctx.textBaseline = 'alphabetic';

    if (legend) {
      legend.innerHTML = Object.entries(cats).map(([lbl, val]) =>
        `<div class="donut-legend-item">
          <span class="donut-dot" style="background:${clrs[lbl]}"></span>
          <span class="donut-lbl">${lbl}</span>
          <span class="donut-val">${val}</span>
        </div>`).join('');
    }
    const meta = document.getElementById('chartStatusMeta');
    if (meta) meta.textContent = `${allRows.length} analisados`;
  }

  /* ══════════════════════════════════════
     EVIDENCE MODAL
  ══════════════════════════════════════ */
  const overlay = document.getElementById('evidenceOverlay');
  document.getElementById('evidenceClose')?.addEventListener('click', closeEvidence);
  overlay?.addEventListener('click', e => { if (e.target === overlay) closeEvidence(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEvidence(); });

  function openEvidence(tr, rowIdx) {
    const cells = Array.from(tr.querySelectorAll('td'));
    const code  = tr.querySelector('.doc-code')?.textContent || `Doc ${rowIdx + 1}`;
    const title = cells[2]?.querySelector('strong')?.textContent || '—';
    const disc  = cells[2]?.querySelector('span')?.textContent  || '—';
    const stEl  = cells[3]?.querySelector('.status-badge');
    const status = stEl ? stEl.textContent.trim() : (cells[3]?.textContent.trim() || '—');
    const curTax = cells[4]?.querySelector('.tax-current')?.textContent?.trim() || '(vazio)';
    const sugInput = cells[5]?.querySelector('.tax-input');
    const sugTax   = sugInput ? sugInput.value : (cells[5]?.textContent?.trim() || '—');
    const confEl   = tr.querySelector('.conf-val');
    const conf     = confEl ? parseInt(confEl.textContent) : 0;
    const origin   = cells[7]?.querySelector('.origin-badge')?.textContent?.trim() || '—';
    const crit     = cells[8]?.querySelector('.criteria')?.textContent?.trim() || cells[8]?.textContent?.trim() || '—';

    const titleEl = document.getElementById('evidenceTitle');
    const codeEl  = document.getElementById('evidenceCode');
    if (titleEl) titleEl.textContent = 'Evidências da Recomendação';
    if (codeEl)  codeEl.textContent  = code;

    const confCls = conf >= 95 ? 'green' : conf >= 85 ? 'blue' : conf >= 70 ? 'yellow' : 'red';
    const confLbl = conf >= 95 ? 'Alta' : conf >= 85 ? 'Boa' : conf >= 70 ? 'Média' : 'Baixa';
    const colorMap = { green: '#00A86B', blue: '#1565C0', yellow: '#9b6206', red: '#D62828' };
    const color = colorMap[confCls];

    const segs = parseTax(sugTax);

    const body = document.getElementById('evidenceBody');
    if (!body) return;

    body.innerHTML = `
      <div class="ev-section">
        <div class="ev-section-title">Identificação</div>
        <div class="ev-summary-grid">
          <div class="ev-item"><div class="ev-item-lbl">Código</div><div class="ev-item-val">${esc(code)}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Confiança</div><div class="ev-item-val" style="color:${color}">${conf}% — ${confLbl}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Título</div><div class="ev-item-val" style="font-family:inherit;font-size:12px">${esc(title)}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Disciplina</div><div class="ev-item-val" style="font-family:inherit;font-size:12px">${esc(disc)}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Status LD</div><div class="ev-item-val" style="font-family:inherit;font-size:12px">${esc(status)}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Origem</div><div class="ev-item-val" style="font-family:inherit;font-size:12px">${esc(origin)}</div></div>
        </div>
      </div>
      <div class="ev-section">
        <div class="ev-section-title">Taxonomias</div>
        <div class="ev-summary-grid">
          <div class="ev-item"><div class="ev-item-lbl">Taxonomia Atual</div><div class="ev-item-val">${esc(curTax)}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Sugestão</div><div class="ev-item-val">${esc(sugTax)}</div></div>
        </div>
      </div>
      ${segs.length ? `
      <div class="ev-section">
        <div class="ev-section-title">Detalhamento por Segmento</div>
        <table class="ev-table">
          <thead><tr><th>#</th><th>Campo</th><th>Código</th><th>Significado</th></tr></thead>
          <tbody>${segs.map((s, i) => `<tr>
            <td><span class="ev-pill">${i+1}</span></td>
            <td style="font-weight:700;color:#0B2447">${esc(s.label)}</td>
            <td><span class="ev-code">${esc(s.value)}</span></td>
            <td>${esc(s.meaning)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
      <div class="ev-section">
        <div class="ev-section-title">Critério de Classificação</div>
        <div style="padding:10px 12px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;font-size:12px;color:#334155;line-height:1.6">${esc(crit)}</div>
        <div class="ev-notice ${conf >= 85 ? 'ev-notice--ok' : conf >= 70 ? 'ev-notice--warn' : 'ev-notice--err'}">
          <strong>${conf >= 85 ? '✓ Conforme' : conf >= 70 ? '⚠ Revisar antes de aplicar' : '✗ Revisão manual necessária'}:</strong>
          ${conf >= 85
            ? 'Taxonomia compatível com a base oficial CONSAG.'
            : conf >= 70
            ? 'Baseada em padrões históricos. Confirmar na matriz Tipo × Setor.'
            : 'Evidências insuficientes. Classificação manual recomendada.'}
        </div>
      </div>`;

    overlay?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeEvidence() {
    overlay?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  const SEG_FIELDS = [
    { label: 'Projeto/Obra',    meaning: 'Identifica a obra ou AG.' },
    { label: 'Tipo Documental', meaning: 'Tipo ou categoria do documento.' },
    { label: 'Setor Emissor',   meaning: 'Setor responsável pela emissão.' },
    { label: 'Etapa',           meaning: 'Etapa do projeto.' },
    { label: 'Frente',          meaning: 'Frente de serviço ou fase da proposta.' },
    { label: 'Disciplina',      meaning: 'Disciplina técnica do documento.' },
    { label: 'Idioma',          meaning: 'Idioma do documento.' },
    { label: 'Sequencial',      meaning: 'Número único dentro do prefixo taxonômico.' },
  ];
  function parseTax(tax) {
    if (!tax || typeof tax !== 'string') return [];
    const p = tax.split('-');
    if (p.length !== 8) return [];
    return p.map((v, i) => ({ value: v, ...SEG_FIELDS[i] }));
  }

  /* ══════════════════════════════════════
     UTILITÁRIOS
  ══════════════════════════════════════ */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* ══════════════════════════════════════
     PONTO DE EXTENSÃO — EXPOR onResultsReady
     app.js chama window._uiOnResults() após renderResults()
  ══════════════════════════════════════ */
  window._uiOnResults = onResultsReady;

  /* ══════════════════════════════════════
     INIT
  ══════════════════════════════════════ */
  setTimeout(syncBaseStatus, 400);
  console.info('[Taxonomia UI v2] Fluxo unificado — sem pulos de aba.');
})();
