/**
 * Taxonomia Consag v1.3 — Camada de apresentação (v3)
 *
 * Esta camada NÃO lê estado do DOM e NÃO usa MutationObserver.
 * Todo o estado chega pelo TaxonomiaBus, publicado pelo app.js:
 *   tax:lds        — LDs carregadas (contadores, badge, KPI)
 *   tax:results    — resultados da análise (filtros, paginação, KPIs, gráficos)
 *   tax:selection  — seleção de linhas (KPIs e resumo de exportação)
 *   tax:base       — números da base CONSAG ativa
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
  // Espelha os números da base a partir do evento tax:base. A versão anterior
  // observava mutações de #statTypes e relia o texto de #baseStatus para
  // descobrir se a base era personalizada — estado inferido do DOM.
  function syncBaseStatus(data) {
    const dot = document.querySelector('.base-dot');
    const label = document.getElementById('baseIndicatorMiniText');
    if (dot) dot.className = 'base-dot active';
    if (label) label.textContent = data.custom ? 'Base personalizada' : 'Base incorporada';

    const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
    const set = (ids, v) => ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = v; });
    set(['baseSideTypes', 'baseStat1'], fmt(data.types));
    set(['statExamples2', 'baseStat2'], fmt(data.examples));
    set(['baseStat3'], fmt(data.refs));
  }

  /* ══════════════════════════════════════
     DROPZONE KEYBOARD SUPPORT
  ══════════════════════════════════════ */
  const ldDrop = document.getElementById('ldDrop');
  ldDrop?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('ldFiles')?.click(); }
  });

  /* ══════════════════════════════════════
     LD STATE — recebido do app.js pelo TaxonomiaBus.

     ATENÇÃO (regressão corrigida): esta camada NÃO renderiza nem lê
     #ldList. A versão anterior observava #ldList com um MutationObserver
     e reescrevia o próprio nó observado; a escrita re-disparava o
     observer e, na segunda passagem, os itens `.file-item` produzidos
     pelo app.js já haviam sido substituídos por `.ld-item`, de modo que
     a lista era considerada vazia e o estado "Nenhuma LD carregada"
     apagava a LD recém-carregada. O painel agora tem um dono único
     (app.js) e esta camada apenas consome dados.
  ══════════════════════════════════════ */
  const bus = window.TaxonomiaBus;
  // As assinaturas ficam no fim do arquivo: o bus reentrega o último
  // payload de cada tópico no momento da inscrição, e assinar aqui
  // executaria os handlers antes de as constantes abaixo existirem.

  /* ══════════════════════════════════════
     RESULTS — dirigido por dados (tax:results), não pelo DOM.

     ATENÇÃO (regressão corrigida): antes, esta camada lia as linhas de
     #resultsBody e as reescrevia. Qualquer novo render do app.js (por
     exemplo "Selecionar aplicáveis") descartava esses elementos, mas o
     array local continuava apontando para nós já removidos do documento:
     os filtros passavam a contar linhas fantasmas — o rodapé exibia
     "0 resultados" enquanto todas as linhas seguiam visíveis. O app.js
     agora publica os dados a cada render e esta camada se reconstrói.
  ══════════════════════════════════════ */

  let rows      = [];   // projeção de dados vinda do app.js
  let rowEls    = [];   // <tr> correspondentes, por índice
  let filtered  = [];   // índices que passaram nos filtros
  let visibleSet = new Set();
  let page      = 1;
  const PER_PAGE = 50;

  function onResults(nextRows) {
    rows   = nextRows;
    rowEls = Array.from(document.querySelectorAll('#resultsBody tr'));
    visibleSet = new Set();
    page = 1;

    applyFilters();
    hideProgress();
    updateWorkflowStats();

    // KPIs e gráficos ficam fora do caminho crítico do primeiro paint.
    scheduleIdle(() => { syncKPIs(); renderCharts(); updateExportInfo(); });
  }

  const scheduleIdle = (fn) =>
    (window.requestIdleCallback ? requestIdleCallback(() => fn(), { timeout: 300 }) : setTimeout(fn, 60));

  function updateWorkflowStats() {
    const ws = document.getElementById('workflowStats');
    if (!ws) return;
    if (!rows.length) { ws.style.display = 'none'; return; }
    const total   = rows.length;
    const prontas = rows.filter(r => r.selected).length;
    const revisar = rows.filter(r => r.found && r.confidence > 0 && r.confidence < 70).length;
    ws.style.display = 'flex';
    const setWF = (id, t) => { const el = document.getElementById(id); if (el && el.textContent !== t) el.textContent = t; };
    setWF('wfStatTotal',   `${total.toLocaleString('pt-BR')} documento${total !== 1 ? 's' : ''}`);
    setWF('wfStatProntas', `${prontas.toLocaleString('pt-BR')} pronto${prontas !== 1 ? 's' : ''}`);
    setWF('wfStatRevisar', `${revisar.toLocaleString('pt-BR')} revisar`);
  }

  /* ── Filtros e paginação (sobre dados, não sobre o DOM) ── */
  const tableSearch  = document.getElementById('tableSearch');
  const filterStatus = document.getElementById('filterStatus');
  const filterConf   = document.getElementById('filterConfianca');

  tableSearch?.addEventListener('input',  debounce(applyFilters, 120));
  filterStatus?.addEventListener('change', applyFilters);
  filterConf?.addEventListener('change',   applyFilters);

  function statusMatches(r, wanted) {
    if (!wanted) return true;
    if (!r.found) return wanted === 'Não encontrado';
    return (r.status || '').includes(wanted);
  }

  function applyFilters() {
    const q      = (tableSearch?.value || '').toLowerCase().trim();
    const status = filterStatus?.value || '';
    const conf   = filterConf?.value   || '';

    filtered = [];
    for (const r of rows) {
      // r.search é pré-calculado no app.js: evita ler textContent de cada
      // <tr> a cada tecla — o custo dominante da busca na versão anterior.
      if (q && !r.search.includes(q)) continue;
      if (!statusMatches(r, status)) continue;
      if (conf) {
        const n = r.confidence;
        if (conf === 'alta'  && n < 95) continue;
        if (conf === 'boa'   && (n < 85 || n >= 95)) continue;
        if (conf === 'media' && (n < 70 || n >= 85)) continue;
        if (conf === 'baixa' && n >= 70) continue;
      }
      filtered.push(r.i);
    }

    page = 1;
    renderPage();
  }

  function renderPage() {
    const start = (page - 1) * PER_PAGE;
    const pageIdx = filtered.slice(start, start + PER_PAGE);
    const next = new Set(pageIdx);

    // Só escreve `style.display` no que realmente mudou. Antes, toda
    // renderização escrevia 2N vezes (esconder tudo, reexibir a página),
    // forçando recálculo de layout proporcional ao total de linhas.
    for (const i of visibleSet) if (!next.has(i)) { const el = rowEls[i]; if (el) el.style.display = 'none'; }
    for (const i of next) if (!visibleSet.has(i)) { const el = rowEls[i]; if (el) el.style.display = ''; }
    // Primeira renderização: esconde tudo que não está na página.
    if (!visibleSet.size) for (let i = 0; i < rowEls.length; i++) if (!next.has(i)) rowEls[i].style.display = 'none';
    visibleSet = next;

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

    const empty = document.getElementById('tableEmpty');
    if (empty) empty.hidden = total > 0 || !rows.length;
  }

  document.getElementById('pagePrev')?.addEventListener('click', () => { if (page > 1) { page--; renderPage(); } });
  document.getElementById('pageNext')?.addEventListener('click', () => {
    if (page < Math.ceil(filtered.length / PER_PAGE)) { page++; renderPage(); }
  });
  document.getElementById('tableClearFilters')?.addEventListener('click', () => {
    if (tableSearch) tableSearch.value = '';
    if (filterStatus) filterStatus.value = '';
    if (filterConf) filterConf.value = '';
    applyFilters();
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
    if (!rows.length) return;
    let preenchidas = 0, emBranco = 0, prontas = 0, revisar = 0, confSum = 0, confCount = 0;

    for (const r of rows) {
      if (!r.found) continue;
      if (r.confidence > 0) { confSum += r.confidence; confCount++; }
      if (r.emptyCount > 0) emBranco++;
      else if ((r.status || '').includes('preenchida')) preenchidas++;
      if (r.selected) prontas++;
      if (r.confidence > 0 && r.confidence < 70) revisar++;
    }

    updateKPI('kpiTotal',       rows.length);
    updateKPI('kpiPreenchidas', preenchidas);
    updateKPI('kpiBranco',      emBranco);
    updateKPI('kpiAprovadas',   prontas);
    updateKPI('kpiPendencias',  revisar);
    updateKPI('kpiConfianca',   (confCount ? Math.round(confSum / confCount) : 0) + '%');
  }

  function updateLDBadge(n) {
    const b = document.getElementById('navBadgeLDs');
    if (!b) return;
    b.textContent = n;
    b.style.display = n > 0 ? 'flex' : 'none';
    updateKPI('kpiLdsCarregadas', n);
  }

  function updateExportInfo() {
    const n = rows.length;
    const el = document.getElementById('exportRowCount');
    if (el) el.textContent = `${n.toLocaleString('pt-BR')} linha${n !== 1 ? 's' : ''} de resultado`;

    const sel = rows.filter(r => r.selected).length;
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

    if (!rows.length) { if (emptyEl) emptyEl.style.display = 'flex'; canvas.style.display = 'none'; return; }
    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = 'block';

    const buckets = [0, 0, 0, 0]; // alta, boa, media, baixa
    for (const r of rows) {
      const n = r.confidence;
      if (n >= 95) buckets[0]++;
      else if (n >= 85) buckets[1]++;
      else if (n >= 70) buckets[2]++;
      else buckets[3]++;
    }

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
    if (meta) meta.textContent = `${rows.length} docs`;
  }

  function renderDonut() {
    const canvas  = document.getElementById('chartStatus');
    const emptyEl = document.getElementById('chartStatusEmpty');
    const legend  = document.getElementById('donutLegend');
    if (!canvas) return;

    if (!rows.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      canvas.style.display = 'none';
      if (legend) legend.innerHTML = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = 'block';

    const cats  = { 'Em branco': 0, 'Preenchida': 0, 'Não encontrado': 0, 'Outros': 0 };
    const clrs  = { 'Em branco': '#F7B500', 'Preenchida': '#00A86B', 'Não encontrado': '#D62828', 'Outros': '#1565C0' };

    for (const r of rows) {
      if (!r.found) { cats['Não encontrado']++; continue; }
      if (r.emptyCount > 0) { cats['Em branco']++; continue; }
      if ((r.status || '').includes('preenchida')) { cats['Preenchida']++; continue; }
      cats['Outros']++;
    }

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
    if (meta) meta.textContent = `${rows.length} analisados`;
  }

  /* ══════════════════════════════════════
     EVIDENCE MODAL
  ══════════════════════════════════════ */
  const overlay = document.getElementById('evidenceOverlay');
  const modalPanel = overlay?.querySelector('.modal, .modal-panel, .modal-content') || overlay?.firstElementChild;
  let lastFocused = null;

  document.getElementById('evidenceClose')?.addEventListener('click', closeEvidence);
  overlay?.addEventListener('click', e => { if (e.target === overlay) closeEvidence(); });

  // Escape e Tab só são interceptados com o modal realmente aberto.
  document.addEventListener('keydown', e => {
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeEvidence(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function focusables() {
    if (!overlay) return [];
    return Array.from(overlay.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  /* app.js chama window._uiEvidence(index) via delegação de clique. */
  window._uiEvidence = openEvidence;

  function openEvidence(index) {
    const r = rows[index];
    if (!r) return;

    const titleEl = document.getElementById('evidenceTitle');
    const codeEl  = document.getElementById('evidenceCode');
    if (titleEl) titleEl.textContent = 'Evidências da Recomendação';
    if (codeEl)  codeEl.textContent  = r.code;

    const conf    = r.confidence;
    const confCls = conf >= 95 ? 'green' : conf >= 85 ? 'blue' : conf >= 70 ? 'yellow' : 'red';
    const confLbl = conf >= 95 ? 'Alta' : conf >= 85 ? 'Boa' : conf >= 70 ? 'Média' : 'Baixa';
    const color   = { green: '#00A86B', blue: '#1565C0', yellow: '#9b6206', red: '#D62828' }[confCls];

    // Segmentos vêm de r.details (produzido pelo motor de classificação),
    // com fallback para a decomposição da própria string de taxonomia.
    const segs = detailSegments(r);

    const body = document.getElementById('evidenceBody');
    if (!body) return;

    body.innerHTML = `
      <div class="ev-section">
        <div class="ev-section-title">Identificação</div>
        <div class="ev-summary-grid">
          <div class="ev-item"><div class="ev-item-lbl">Código</div><div class="ev-item-val">${esc(r.code)}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Confiança</div><div class="ev-item-val" style="color:${color}">${conf}% — ${confLbl}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Título</div><div class="ev-item-val ev-item-val--text">${esc(r.title || '—')}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Disciplina</div><div class="ev-item-val ev-item-val--text">${esc(r.disciplineText || '—')}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Status LD</div><div class="ev-item-val ev-item-val--text">${esc(r.found ? (r.status || '—') : 'Não encontrado')}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Origem</div><div class="ev-item-val ev-item-val--text">${esc(r.origin || '—')}</div></div>
        </div>
      </div>
      <div class="ev-section">
        <div class="ev-section-title">Taxonomias</div>
        <div class="ev-summary-grid">
          <div class="ev-item"><div class="ev-item-lbl">Taxonomia Atual</div><div class="ev-item-val">${esc(r.current || '(vazio)')}</div></div>
          <div class="ev-item"><div class="ev-item-lbl">Sugestão</div><div class="ev-item-val">${esc(r.taxonomy || '—')}</div></div>
        </div>
      </div>
      ${segs.length ? `
      <div class="ev-section">
        <div class="ev-section-title">Detalhamento por Segmento</div>
        <div class="ev-table-wrap">
          <table class="ev-table ev-table--segments">
            <thead><tr><th>#</th><th>Campo</th><th>Código</th><th>Significado</th></tr></thead>
            <tbody>${segs.map((sg, i) => `<tr>
              <td><span class="ev-pill">${i + 1}</span></td>
              <td class="ev-td-field">${esc(sg.label)}</td>
              <td><span class="ev-code">${esc(sg.value)}</span></td>
              <td>${esc(sg.meaning)}${sg.evidence ? `<span class="ev-evidence">${esc(sg.evidence)}</span>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
      ${r.fields && Object.keys(r.fields).length ? `
      <div class="ev-section">
        <div class="ev-section-title">Dados lidos da linha da LD</div>
        <div class="ev-table-wrap">
          <table class="ev-table ev-table--fields">
            <thead><tr><th>Coluna</th><th>Valor</th></tr></thead>
            <tbody>${Object.entries(r.fields).map(([k,v])=>`<tr>
              <td class="ev-td-field">${esc(k)}</td><td>${esc(v)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
      <div class="ev-section">
        <div class="ev-section-title">Critério de Classificação</div>
        <div class="ev-criterion">${esc(r.criterion || '—')}</div>
        ${r.baseValidation ? `<div class="ev-criterion ev-criterion--base">${esc(r.baseValidation)}</div>` : ''}
        <div class="ev-notice ${conf >= 85 ? 'ev-notice--ok' : conf >= 70 ? 'ev-notice--warn' : 'ev-notice--err'}">
          <strong>${conf >= 85 ? '✓ Conforme' : conf >= 70 ? '⚠ Revisar antes de aplicar' : '✗ Revisão manual necessária'}:</strong>
          ${conf >= 85
            ? 'Taxonomia compatível com a base oficial CONSAG.'
            : conf >= 70
            ? 'Baseada em padrões históricos. Confirmar na matriz Tipo × Setor.'
            : 'Evidências insuficientes. Classificação manual recomendada.'}
        </div>
      </div>`;

    lastFocused = document.activeElement;
    overlay?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    (focusables()[0] || modalPanel)?.focus?.();
  }

  function closeEvidence() {
    if (!overlay || overlay.classList.contains('hidden')) return;
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
    // Devolve o foco ao botão que abriu o modal.
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
  }

  function detailSegments(r) {
    const d = r.details;
    if (d) {
      return SEG_KEYS.map(([key, label], i) => ({
        label,
        value: d[key]?.code || '—',
        meaning: d[key]?.description || SEG_FIELDS[i].meaning,
        evidence: d[key]?.evidence || ''
      }));
    }
    return parseTax(r.taxonomy);
  }

  const SEG_KEYS = [
    ['project', 'Projeto/Obra'], ['type', 'Tipo Documental'], ['sector', 'Setor Emissor'],
    ['stage', 'Etapa'], ['front', 'Frente'], ['discipline', 'Disciplina'],
    ['language', 'Idioma'], ['sequence', 'Sequencial'],
  ];

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
     INIT — assinaturas do bus por último, quando todo o módulo já
     está inicializado (o bus reentrega o último payload na inscrição).
  ══════════════════════════════════════ */
  bus?.on('tax:lds', data => {
    updateLDBadge(data.total);
    updateKPI('kpiLdsCarregadas', data.total);
  });
  bus?.on('tax:results', data => onResults(data.rows || []));
  bus?.on('tax:selection', () => { syncKPIs(); updateExportInfo(); updateWorkflowStats(); });
  bus?.on('tax:base', syncBaseStatus);
  console.info('[Taxonomia UI v2] Fluxo unificado — sem pulos de aba.');
})();
