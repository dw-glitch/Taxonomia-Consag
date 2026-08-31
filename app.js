(() => {
  'use strict';

  const EMBEDDED = window.TAXONOMIA_EMBEDDED_DATA || {};
  const TAX_RE = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{2,8}){6}-\d{4}$/;
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  const state = {
    data: EMBEDDED,
    loadedFiles: [],
    loadedRecords: [],
    results: [],
    model: null,
    modelDirty: true,
    customBase: null,
    busyDepth: 0,
    // Painel de LDs (fonte da verdade: state.loadedFiles; estes campos sao apenas de exibicao)
    ldQuery: '',
    ldSort: 'recent',
    ldBusy: false,
    ldUpload: []
  };

  /* ────────────────────────────────────────────────────────────────
     BUS DE ESTADO
     Canal explicito entre app.js (dono do estado) e ui.js (camada de
     apresentacao). Substitui a leitura de estado a partir do DOM, que
     era a causa da dessincronizacao do painel de LDs.
     Publica o ultimo payload de cada topico para assinantes tardios:
     ui.js e carregado depois de app.js e precisa receber o estado
     inicial mesmo tendo assinado apos a primeira emissao.
     ──────────────────────────────────────────────────────────────── */
  const busListeners = new Map();
  const busLast = new Map();
  function emit(type, detail) {
    busLast.set(type, detail);
    for (const fn of (busListeners.get(type) || []).slice()) {
      try { fn(detail); } catch (err) { console.error('[TaxonomiaBus]', type, err); }
    }
  }
  function busOn(type, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!busListeners.has(type)) busListeners.set(type, []);
    busListeners.get(type).push(fn);
    if (busLast.has(type)) { try { fn(busLast.get(type)); } catch (err) { console.error('[TaxonomiaBus]', type, err); } }
    return () => busOff(type, fn);
  }
  function busOff(type, fn) {
    const arr = busListeners.get(type); if (!arr) return;
    const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
  }
  window.TaxonomiaBus = { on: busOn, off: busOff };
  // Snapshot somente-leitura para depuração e para a camada de apresentação.
  window.TaxonomiaState = {
    get lds()      { return ldSnapshot(); },
    get results()  { return state.results.slice(); },
    get busy()     { return state.ldBusy || state.busyDepth > 0; }
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    statTypes: $('statTypes'), statExamples: $('statExamples'), statRefs: $('statRefs'),
    ldDrop: $('ldDrop'), ldFiles: $('ldFiles'), ldList: $('ldList'), blankAnalyzeBtn: $('blankAnalyzeBtn'),
    codesInput: $('codesInput'), clearCodes: $('clearCodes'), codeCount: $('codeCount'), analyzeBtn: $('analyzeBtn'),
    resultsPanel: $('resultsPanel'), resultsSummary: $('resultsSummary'), resultsBody: $('resultsBody'),
    selectAllBtn: $('selectAllBtn'), copyBtn: $('copyBtn'), xlsxBtn: $('xlsxBtn'), applyBtn: $('applyBtn'),
    baseStatus: $('baseStatus'), baseFile: $('baseFile'), toast: $('toast'), busy: $('busy'), busyText: $('busyText'),
    ldToolbar: $('ldToolbar'), ldSearch: $('ldSearch'), ldSort: $('ldSort'),
    ldRefresh: $('ldRefresh'), ldClearAll: $('ldClearAll'), ldCount: $('ldCount'),
    ldUpload: $('ldUploadProgress'), ldSuccess: $('ldSuccess')
  };

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  }

  /* ─────────────────────────────────────────────────────────────────
     Memoização dos normalizadores de string.

     normText/normCode/tokens são funções puras da string de entrada. No
     perfil de uma análise de 8.000 códigos elas respondiam por ~65% do
     tempo total: as ~1.000 descrições do catálogo oficial e os códigos das
     3.100 referências eram renormalizados a cada documento analisado — o
     mesmo valor, milhões de vezes. O cache tem teto para não virar
     vazamento de memória em sessões longas.
     ───────────────────────────────────────────────────────────────── */
  function memoString(fn, limit) {
    const cache = new Map();
    return (v) => {
      const k = typeof v === 'string' ? v : String(v ?? '');
      const hit = cache.get(k);
      if (hit !== undefined) return hit;
      const out = fn(k);
      if (cache.size >= limit) cache.clear();
      cache.set(k, out);
      return out;
    };
  }

  const normText = memoString(function normTextRaw(v) {
    return String(v ?? '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }, 60000);

  const normCode = memoString(function normCodeRaw(v) {
    let s = String(v ?? '').trim().replace(/^['"]|['"]$/g, '');
    s = s.split(/[\r\n\t]/)[0].trim();
    s = s.replace(/^.*[\\/]/, '').replace(/\.(XLSX|XLSM|PDF|DOCX?|ZIP)$/i, '');
    s = s.replace(/\s+\/\s+.*$/, '').trim();
    s = s.replace(/_\d{4}_.+$/i, '').replace(/_\d{4}$/i, '');
    const pattern = /(?:[A-Z]{1,8}-)?\d{4}\.\d{2}-\d{5}-[A-Z0-9]{2,5}-[A-Z0-9]{3}-\d{3}/i;
    const m = s.match(pattern);
    if (m) s = m[0];
    return s.toUpperCase().replace(/\s+/g, '');
  }, 60000);

  const compactCode = memoString((v) => normCode(v).replace(/[^A-Z0-9]/g, ''), 60000);
  function docFamily(code) { return (normCode(code).split('-')[0] || '').replace(/[^A-Z]/g, ''); }
  function codeSeriesKey(code) { const c=normCode(code); if(/-\d{3}$/.test(c))return c.replace(/-\d{3}$/,''); const i=c.indexOf('_RIR'); if(i>0)return c.slice(0,i+4); return ''; }

  const STOP = new Set('DE DA DO DAS DOS E EM PARA POR COM SEM A O AS OS UM UMA NO NA NOS NAS AO AOS AREA UNIDADE DOCUMENTO DOCUMENTACAO PROJETO CONSAG PETROBRAS RNEST UHDTD U'.split(' '));
  const tokens = memoString((v) => normText(v).split(' ').filter(x => x.length >= 2 && !STOP.has(x)), 60000);
  function tokenSet(v) { return new Set(tokens(v)); }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let i = 0; for (const x of a) if (b.has(x)) i++;
    return i / (a.size + b.size - i || 1);
  }

  function validTax(v) { return TAX_RE.test(String(v ?? '').trim().toUpperCase()); }
  function splitTax(v) {
    const p = String(v ?? '').trim().toUpperCase().split('-');
    if (p.length !== 8 || !/^\d{4}$/.test(p[7])) return null;
    return { project:p[0], type:p[1], sector:p[2], stage:p[3], front:p[4], discipline:p[5], language:p[6], sequence:p[7] };
  }

  function confidenceClass(n) { return n >= 95 ? 'high' : n >= 85 ? 'medium-high' : n >= 70 ? 'medium' : 'low'; }
  function confidenceLabel(n) { return n >= 95 ? 'Alta' : n >= 85 ? 'Boa' : n >= 70 ? 'Média' : 'Revisar'; }

  function toast(msg, kind='ok') {
    els.toast.textContent = msg;
    els.toast.className = `toast show ${kind}`;
    clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.className = 'toast', 3600);
  }
  function setBusy(on, text='Processando…') {
    state.busyDepth += on ? 1 : -1; state.busyDepth = Math.max(0, state.busyDepth);
    if (on) els.busyText.textContent = text;
    els.busy.classList.toggle('hidden', state.busyDepth === 0);
  }
  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  // ---------- ZIP/XLSX engine (100% local, no dependency) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1); t[n]=c>>>0; }
    return t;
  })();
  function crc32(bytes) {
    let c=0xffffffff; for(const b of bytes) c=CRC_TABLE[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0;
  }
  function u16(v,o){return v.getUint16(o,true)} function u32(v,o){return v.getUint32(o,true)}
  function pushU16(a,n){a.push(n&255,(n>>>8)&255)} function pushU32(a,n){a.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255)}
  function concatBytes(chunks) {
    let total=chunks.reduce((s,c)=>s+c.length,0), out=new Uint8Array(total), p=0;
    for(const c of chunks){out.set(c,p);p+=c.length;} return out;
  }

  class ZipArchive {
    constructor(buffer, name='arquivo.xlsx') {
      this.name=name; this.bytes=new Uint8Array(buffer); this.view=new DataView(this.bytes.buffer,this.bytes.byteOffset,this.bytes.byteLength); this.entries=new Map(); this.replacements=new Map(); this._parse();
    }
    _parse() {
      const b=this.bytes,v=this.view; let eocd=-1;
      for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){ if(u32(v,i)===0x06054b50){eocd=i;break;} }
      if(eocd<0) throw new Error('Arquivo ZIP/XLSX inválido (diretório central não encontrado).');
      const count=u16(v,eocd+10), cdOffset=u32(v,eocd+16); let p=cdOffset;
      for(let i=0;i<count;i++){
        if(u32(v,p)!==0x02014b50) throw new Error('Estrutura ZIP inválida.');
        const flags=u16(v,p+8), method=u16(v,p+10), time=u16(v,p+12), date=u16(v,p+14), crc=u32(v,p+16), compSize=u32(v,p+20), size=u32(v,p+24);
        const nl=u16(v,p+28), xl=u16(v,p+30), cl=u16(v,p+32), extAttr=u32(v,p+38), localOffset=u32(v,p+42);
        const nameBytes=b.slice(p+46,p+46+nl), name=decoder.decode(nameBytes);
        const lv=this.view; if(u32(lv,localOffset)!==0x04034b50) throw new Error('Entrada ZIP inválida: '+name);
        const lnl=u16(lv,localOffset+26), lxl=u16(lv,localOffset+28), dataStart=localOffset+30+lnl+lxl;
        const compressed=b.slice(dataStart,dataStart+compSize);
        this.entries.set(name,{name,nameBytes,flags,method,time,date,crc,compSize,size,extAttr,compressed});
        p += 46+nl+xl+cl;
      }
    }
    has(path){return this.entries.has(path)}
    async bytesOf(path) {
      if(this.replacements.has(path)) return this.replacements.get(path);
      const e=this.entries.get(path); if(!e) throw new Error('Entrada não encontrada: '+path);
      if(e.method===0) return e.compressed.slice();
      if(e.method===8) {
        if(typeof DecompressionStream==='undefined') throw new Error('Seu navegador não possui descompactação nativa. Use Chrome ou Edge atualizado.');
        const ds=new DecompressionStream('deflate-raw');
        const ab=await new Response(new Blob([e.compressed]).stream().pipeThrough(ds)).arrayBuffer();
        return new Uint8Array(ab);
      }
      throw new Error(`Método de compressão ${e.method} não suportado.`);
    }
    async text(path){return decoder.decode(await this.bytesOf(path))}
    replaceText(path,text){this.replacements.set(path,encoder.encode(text))}
    replaceBytes(path,bytes){this.replacements.set(path,bytes instanceof Uint8Array?bytes:new Uint8Array(bytes))}
    async build() {
      const localChunks=[], central=[], offsets=new Map(); let offset=0;
      for(const [name,e] of this.entries) {
        const changed=this.replacements.has(name); const raw=changed?this.replacements.get(name):null;
        const method=changed?0:e.method, data=changed?raw:e.compressed, size=changed?raw.length:e.size, crc=changed?crc32(raw):e.crc;
        const nb=e.nameBytes || encoder.encode(name); const local=[];
        pushU32(local,0x04034b50); pushU16(local,20); pushU16(local,changed?0:(e.flags&~8)); pushU16(local,method); pushU16(local,e.time||0); pushU16(local,e.date||0);
        pushU32(local,crc); pushU32(local,data.length); pushU32(local,size); pushU16(local,nb.length); pushU16(local,0);
        const lh=new Uint8Array(local.length+nb.length); lh.set(local,0); lh.set(nb,local.length);
        offsets.set(name,offset); localChunks.push(lh,data); offset += lh.length+data.length;
      }
      const cdOffset=offset;
      for(const [name,e] of this.entries) {
        const changed=this.replacements.has(name); const raw=changed?this.replacements.get(name):null;
        const method=changed?0:e.method, data=changed?raw:e.compressed, size=changed?raw.length:e.size, crc=changed?crc32(raw):e.crc;
        const nb=e.nameBytes || encoder.encode(name); const c=[];
        pushU32(c,0x02014b50); pushU16(c,20); pushU16(c,20); pushU16(c,changed?0:(e.flags&~8)); pushU16(c,method); pushU16(c,e.time||0); pushU16(c,e.date||0);
        pushU32(c,crc); pushU32(c,data.length); pushU32(c,size); pushU16(c,nb.length); pushU16(c,0); pushU16(c,0); pushU16(c,0); pushU16(c,0); pushU32(c,e.extAttr||0); pushU32(c,offsets.get(name));
        const ch=new Uint8Array(c.length+nb.length); ch.set(c,0);ch.set(nb,c.length); central.push(ch); offset+=ch.length;
      }
      const cdSize=offset-cdOffset, end=[]; pushU32(end,0x06054b50); pushU16(end,0);pushU16(end,0);pushU16(end,this.entries.size);pushU16(end,this.entries.size);pushU32(end,cdSize);pushU32(end,cdOffset);pushU16(end,0);
      return concatBytes([...localChunks,...central,new Uint8Array(end)]);
    }
  }

  function parseXml(text) {
    const doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.getElementsByTagName('parsererror').length) throw new Error('XML interno da planilha não pôde ser lido.');
    return doc;
  }
  function localNodes(parent,local){return Array.from(parent.getElementsByTagNameNS('*',local))}
  function colLetters(ref){return (String(ref).match(/[A-Z]+/i)||[''])[0].toUpperCase()}
  function colNum(letters){let n=0;for(const c of letters)n=n*26+(c.charCodeAt(0)-64);return n}
  function numCol(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}

  async function parseWorkbook(file) {
    const buf=await file.arrayBuffer(); const zip=new ZipArchive(buf,file.name);
    const shared=[];
    if(zip.has('xl/sharedStrings.xml')) {
      const doc=parseXml(await zip.text('xl/sharedStrings.xml'));
      for(const si of localNodes(doc,'si')) shared.push(localNodes(si,'t').map(t=>t.textContent||'').join(''));
    }
    const wb=parseXml(await zip.text('xl/workbook.xml'));
    const rel=parseXml(await zip.text('xl/_rels/workbook.xml.rels'));
    const rels=new Map(localNodes(rel,'Relationship').map(r=>[r.getAttribute('Id'),r.getAttribute('Target')]));
    const sheets=[];
    for(const s of localNodes(wb,'sheet')) {
      const rid=s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id') || s.getAttribute('r:id');
      let target=rels.get(rid)||''; target=target.replace(/^\//,'');
      if(!target.startsWith('xl/')) target='xl/'+target.replace(/^\.\//,'');
      target=target.replace(/\/[^/]+\/\.\./g,'');
      sheets.push({name:s.getAttribute('name')||'Planilha',path:target});
    }
    return {id:crypto.randomUUID(),name:file.name,file,zip,shared,sheets,records:[]};
  }

  function cellValue(cell, shared) {
    const t=cell.getAttribute('t');
    if(t==='inlineStr') return localNodes(cell,'t').map(n=>n.textContent||'').join('');
    const v=localNodes(cell,'v')[0]?.textContent ?? '';
    if(t==='s') return shared[Number(v)] ?? '';
    if(t==='str') return v;
    return v;
  }
  function rowValues(row,shared) {
    const m=new Map(); for(const c of localNodes(row,'c')) m.set(colLetters(c.getAttribute('r')),cellValue(c,shared)); return m;
  }
  const HEADER_CODE = ['CODIGO DO DOCUMENTO','CÓDIGO DO DOCUMENTO','CODIGO DOCUMENTO','CÓDIGO DOCUMENTO','CODIGO','CÓDIGO','DOCUMENTO','N DOCUMENTO','NUMERO DO DOCUMENTO','NÚMERO DO DOCUMENTO'];
  const HEADER_TITLE = ['TITULO','TÍTULO','TITULO DO DOCUMENTO','TÍTULO DO DOCUMENTO','DESCRICAO','DESCRIÇÃO'];
  /* DISCIPLINA e SETOR são segmentos DIFERENTES da taxonomia (6º e 3º).
     Antes os dois viviam na mesma lista e a primeira coluna encontrada
     vencia: numa LD com as duas colunas, o setor era lido como disciplina
     e a coluna de disciplina era ignorada por completo. */
  const HEADER_DISC   = ['DISCIPLINA','DISCIPLINA DO DOCUMENTO','DISCIPLINA TECNICA','DISCIPLINA TÉCNICA'];
  const HEADER_SECTOR = ['SETOR','SETOR EMISSOR','EMISSOR','AREA EMISSORA','ÁREA EMISSORA','DEPARTAMENTO','SETOR RESPONSAVEL','SETOR RESPONSÁVEL'];
  const HEADER_FRONT  = ['FRENTE','FRENTE DE SERVICO','FRENTE DE SERVIÇO','FASE DA PROPOSTA','SISTEMA'];
  const HEADER_STAGE  = ['ETAPA','FASE','ETAPA DO PROJETO','FASE DO PROJETO'];
  const HEADER_PROJ   = ['OBRA','EMPREENDIMENTO','ESTUDO','AG','OBRA ESTUDO AG'];
  const HEADER_LANG   = ['IDIOMA','LINGUA','LÍNGUA','LANGUAGE'];

  function findHeader(rows,shared) {
    let best=null;
    const has=(list,v)=>list.map(normText).includes(v);
    for(const row of rows.slice(0,80)) {
      const vals=rowValues(row,shared), norm=new Map([...vals].map(([k,v])=>[k,normText(v)]));
      let taxCol='', codeCol='', titleCol='', discCol='', sectorCol='', frontCol='', stageCol='', projCol='', langCol='';
      // Cabeçalho de TODAS as colunas: a linha inteira passa a ser preservada,
      // não só as quatro que o motor consumia.
      const headers=new Map();
      for(const [c,v] of norm) {
        if(v) headers.set(c,v);
        if(v==='TAXONOMIA'||v.includes('TAXONOMIA')) taxCol=c;
        if(!codeCol   && has(HEADER_CODE,v))   codeCol=c;
        if(!titleCol  && has(HEADER_TITLE,v))  titleCol=c;
        if(!discCol   && has(HEADER_DISC,v))   discCol=c;
        if(!sectorCol && has(HEADER_SECTOR,v)) sectorCol=c;
        if(!frontCol  && has(HEADER_FRONT,v))  frontCol=c;
        if(!stageCol  && has(HEADER_STAGE,v))  stageCol=c;
        if(!projCol   && has(HEADER_PROJ,v))   projCol=c;
        if(!langCol   && has(HEADER_LANG,v))   langCol=c;
      }
      if(taxCol) {
        const score=(codeCol?4:0)+(titleCol?2:0)+(discCol?1:0)+(sectorCol?1:0)+(frontCol?1:0)+(stageCol?1:0);
        if(!best||score>best.score) best={row:Number(row.getAttribute('r')||0),taxCol,codeCol,titleCol,discCol,sectorCol,frontCol,stageCol,projCol,langCol,headers,score};
      }
    }
    return best;
  }
  /* Famílias de código de documento aceitas nas LDs.

     A versão anterior reconhecia apenas o padrão Petrobras
     (CR-5290.00-22313-911-C1O-001) e descartava silenciosamente 100% das
     linhas das LDs que usam a nomenclatura por WBS
     (C1O_RNEST_U32_3.1.1.1_CVL_RIR_B-32014A). Como extractLDRecords() usa
     esta função para filtrar as linhas, essas LDs eram importadas com
     ZERO registros e "Detectar Taxonomias em Branco" acusava erro.
     Medido sobre os 23.413 registros de referência: 17,4% -> 100,0% de
     reconhecimento, sem nenhum falso positivo novo. */
  const DOC_CODE_PETROBRAS = /\d{4}\.\d{2}-\d{5}-/;
  const DOC_CODE_PETROBRAS_TAIL = /-\d{3}$/;
  // C1O_RNEST_U32_3.1.1.1_CVL_RIR_B-32014A  (obra_planta_unidade_WBS_disciplina_tipo_tag)
  // O tipo documental pode trazer dígito ou ponto (…_EST_CIME1_R-32501, …_EST_PAR.SPIE_V-32201).
  const DOC_CODE_WBS = /^[A-Z0-9]{2,8}(?:_[A-Z0-9]{2,12}){1,3}_\d+(?:\.\d+){1,5}_[A-Z]{2,12}[_-][A-Z0-9.]{2,12}[_-].+$/;
  // 5900.0130870.25.2-C1O-CV-CRS-0001
  const DOC_CODE_DOTTED = /^\d{4}\.\d{4,}(?:\.\d+)+(?:-[A-Z0-9]{2,6}){2,}-\d{3,4}$/;
  /* ─────────────────────────────────────────────────────────────────
     DECODIFICAÇÃO ESTRUTURAL DO CÓDIGO

     As duas famílias de código usadas nas LDs já carregam, no próprio
     código, o tipo documental e a disciplina — informação que o motor
     ignorava, inferindo tudo por semelhança de título:

       N-1710  CR-5290.00-22313-911-C1O-001
               ^prefixo            ^disciplina N-1710

       ET/WBS  C1O_RNEST_U32_3.1.1.1_CVL_RIR_B-32014A
                                     ^disc ^tipo

     Medido sobre os dados de referência: nas abas ET, 90,3% dos tokens
     de tipo são códigos válidos do catálogo oficial, e 99,7% deles têm
     o título corroborando a descrição oficial. Nas abas N-1710, a dupla
     prefixo+disciplina prevê o tipo com 97,0% de pureza.
     ───────────────────────────────────────────────────────────────── */
  const RE_N1710 = /^([A-Z]{2,3})-(\d{4}\.\d{2})-(\d{5})-([A-Z0-9]{3})-([A-Z0-9]{3})-(\d{3})$/;
  const RE_WBS_FIELDS = /^([A-Z0-9]{2,8})_(?:[A-Z0-9]{2,12}_){1,3}(\d+(?:\.\d+){1,5})_([A-Z]{2,12})[_-]([A-Z0-9.]{2,12})[_-](.+)$/;

  const decodeDocCode = memoString((v) => {
    const c = normCode(v);
    let m = c.match(RE_N1710);
    if (m) return { family:'N-1710', prefix:m[1], area:m[2], unit:m[3], disc:m[4], issuer:m[5], seq:m[6], key:`${m[1]}|${m[4]}` };
    m = c.match(RE_WBS_FIELDS);
    if (m) return { family:'ET', project:m[1], wbs:m[2], discToken:m[3], typeToken:m[4], tag:m[5], key:`${m[3]}|${m[4]}` };
    return { family:'', key:'' };
  }, 60000);

  function looksLikeDocCode(v){
    const s=normCode(v); if(!s) return false;
    if(DOC_CODE_PETROBRAS.test(s) && DOC_CODE_PETROBRAS_TAIL.test(s)) return true;
    return DOC_CODE_WBS.test(s) || DOC_CODE_DOTTED.test(s);
  }

  async function extractLDRecords(book) {
    const all=[];
    for(const sheet of book.sheets) {
      if(!book.zip.has(sheet.path)) continue;
      const xml=await book.zip.text(sheet.path); const doc=parseXml(xml); const rows=localNodes(doc,'row'); if(!rows.length) continue;
      const head=findHeader(rows,book.shared); if(!head) continue;
      let codeCol=head.codeCol;
      if(!codeCol) {
        // Infer the document-code column from the first rows after the Taxonomia header.
        const votes=new Map();
        for(const row of rows.filter(r=>Number(r.getAttribute('r'))>head.row).slice(0,150)) {
          for(const [c,v] of rowValues(row,book.shared)) if(looksLikeDocCode(v)) votes.set(c,(votes.get(c)||0)+1);
        }
        codeCol=[...votes].sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
      }
      if(!codeCol) continue;
      for(const row of rows) {
        const rn=Number(row.getAttribute('r')||0); if(rn<=head.row) continue;
        const vals=rowValues(row,book.shared); const rawCode=vals.get(codeCol)||''; if(!looksLikeDocCode(rawCode)) continue;
        const cell=(col)=>col?String(vals.get(col)||'').trim():'';
        // Preserva a linha inteira: qualquer coluna com cabeçalho vira evidência
        // disponível. Antes só quatro colunas sobreviviam à importação.
        const fields={};
        if(head.headers) for(const [col,name] of head.headers){ const v=cell(col); if(v) fields[name]=v; }
        const discText=cell(head.discCol), sectorText=cell(head.sectorCol);
        const rec={
          code:normCode(rawCode), rawCode:String(rawCode).trim(), title:cell(head.titleCol),
          // Sem coluna de disciplina, a de setor ainda serve de pista — era o
          // comportamento anterior e as LDs que só têm "SETOR" dependem dele.
          disciplineText:discText||sectorText,
          sectorText, frontText:cell(head.frontCol), stageText:cell(head.stageCol),
          projectText:cell(head.projCol), languageText:cell(head.langCol),
          fields, taxonomy:String(vals.get(head.taxCol)||'').trim().toUpperCase(),
          sourceLD:book.name, sheet:sheet.name, row:rn, taxCol:head.taxCol, sheetPath:sheet.path, fileId:book.id, loaded:true
        };
        all.push(rec); book.records.push(rec);
      }
    }
    return all;
  }

  // ---------- Classification model ----------
  const TAXONOMY_FIELDS = [
    {key:'project',label:'Estudo / Obra / AG',digits:'até 5 (CONSAG: 6)',base:'Aba TAXONOMIA · campo 1'},
    {key:'type',label:'Tipo de documento / registro',digits:'3',base:'Aba TIPO DE DOCUMENTO + TAXONOMIA · campo 2'},
    {key:'sector',label:'Setor emissor',digits:'3',base:'Aba TIPO DE DOCUMENTO POR SETOR + TAXONOMIA · campo 3'},
    {key:'stage',label:'Etapa do projeto',digits:'2',base:'Aba TAXONOMIA · campo 4'},
    {key:'front',label:'Frente de serviço / fase da proposta',digits:'4',base:'Aba TAXONOMIA · campo 5'},
    {key:'discipline',label:'Disciplina',digits:'3',base:'Aba TAXONOMIA · campo 6'},
    {key:'language',label:'Idioma',digits:'2',base:'Aba TAXONOMIA · campo 7'},
    {key:'sequence',label:'Sequencial',digits:'4',base:'Aba TAXONOMIA · campo 8'}
  ];

  const SECTOR_CATEGORY_BY_CODE = Object.freeze({
    CSG:'CONSAG', ENG:'ENGENHARIA', ENT:'SEÇÃO TÉCNICA', PLA:'PLANEJAMENTO', QTM:'QUALIDADE', SMS:'SMS',
    ADC:'ADM CONTRATUAL', SUB:'GESTÃO DE CONTRATOS', FIN:'PAGAMENTOS', CTB:'ARQUIVO FISCAL', TRB:'ARQUIVO FISCAL',
    RHU:'RH', ADM:'ADMINISTRAÇÃO', CDC:'CENTRO DE DOCUMENTAÇÃO'
  });

  /* Categoria da matriz oficial -> código de setor. Categorias servidas por
     mais de um código (ARQUIVO FISCAL: CTB e TRB) ficam de fora: ambíguas. */
  const SECTOR_CODE_BY_CATEGORY = (() => {
    const byCat = new Map();
    for (const [code, cat] of Object.entries(SECTOR_CATEGORY_BY_CODE)) {
      const k = normText(cat);
      if (byCat.has(k)) byCat.set(k, null); else byCat.set(k, code);
    }
    return byCat;
  })();

  /* A aba "TIPO DE DOCUMENTO POR SETOR" é a autoridade sobre quem emite cada
     tipo. Quando ela admite uma única categoria e essa categoria corresponde a
     um único código, o setor está determinado pela própria base — não é
     inferência. Cobre os tipos que nunca apareceram taxonomizados nas
     referências, caso das LDs da aba ET. */
  function sectorFromOfficialMatrix(type) {
    const allowed = state.model.allowed[type];
    if (!Array.isArray(allowed) || allowed.length !== 1) return null;
    const code = SECTOR_CODE_BY_CATEGORY.get(normText(allowed[0]));
    if (!code || !state.model.sectors.has(code)) return null;
    return { value:code, quality:93,
      evidence:`A matriz oficial “TIPO DE DOCUMENTO POR SETOR” admite um único setor emissor para ${type}: ${allowed[0]} (${code})` };
  }

  function modeStats(values) {
    const m=new Map(); for(const v of values){if(v)m.set(v,(m.get(v)||0)+1)}
    const sorted=[...m].sort((a,b)=>b[1]-a[1]); const total=sorted.reduce((n,x)=>n+x[1],0);
    return {value:sorted[0]?.[0]||'',count:sorted[0]?.[1]||0,total,share:total?((sorted[0]?.[1]||0)/total):0,all:sorted};
  }
  function profileAdd(map,key,val){if(!key||!val)return;if(!map.has(key))map.set(key,[]);map.get(key).push(val)}
  function dictFrom(items){return new Map((items||[]).map(x=>[String(x.code||'').toUpperCase(),x]))}
  const descriptionTokens = memoString((v) => tokens(v).filter(x=>x.length>=3), 60000);
  function phraseScore(text, description) {
    const a=normText(text), b=normText(description); if(!a||!b)return 0;
    if(a===b)return 1; if(b.length>=7&&a.includes(b))return 0.99; if(a.length>=10&&b.includes(a))return 0.93;
    const aa=new Set(descriptionTokens(a)),bb=new Set(descriptionTokens(b)); return jaccard(aa,bb);
  }

  /* Pool de sequenciais já utilizados. Reconstruído a cada análise para que
     duas execuções seguidas dos mesmos códigos produzam o mesmo resultado —
     reserveSequence() muta este mapa durante a análise. */
  function buildSequencePool(ex) {
    const used=new Map();
    // Cada prefixo guarda o conjunto de sequenciais usados E o maior deles:
    // sem o max, reserveSequence() varria o Set inteiro a cada reserva
    // (Math.max(...set)), custo quadrático e risco de estourar a pilha.
    const add=(tax)=>{
      const p=splitTax(tax); if(!p)return;
      const key=[p.project,p.type,p.sector,p.stage,p.front,p.discipline,p.language].join('-');
      let slot=used.get(key); if(!slot){slot={set:new Set(),max:0};used.set(key,slot);}
      const n=Number(p.sequence); if(!Number.isFinite(n))return;
      slot.set.add(n); if(n>slot.max)slot.max=n;
    };
    for(const e of ex) add(e.taxonomy);
    for(const r of state.loadedRecords) if(validTax(r.taxonomy)) add(r.taxonomy);
    return used;
  }

  /* Reconstrói o modelo apenas quando os dados de entrada mudaram.
     Antes, buildModel() (26 mil registros) rodava em toda análise mesmo
     sem nenhuma alteração de LD ou de base. */
  function ensureModel() {
    if(state.modelDirty || !state.model){ buildModel(); state.modelDirty=false; }
    return state.model;
  }

  function buildModel() {
    const d=state.data, examples=(d.examples||[]).filter(e=>validTax(e.taxonomy));
    const ex=examples.map((e,i)=>{const p=splitTax(e.taxonomy);return {...e,_i:i,_titleNorm:normText(e.title),_discNorm:normText(e.disciplineText),_titleSet:tokenSet(e.title),_discSet:tokenSet(e.disciplineText),_family:docFamily(e.code),_compact:compactCode(e.code),_tax:p};});
    const refIndex=new Map(), compactIndex=new Map();
    function addRef(r,loaded=false) {
      // O índice guarda CÓPIAS dos registros (o código é normalizado). Sem a
      // referência de volta em `_src`, gravar a taxonomia aplicada atingiria
      // apenas a cópia, e as estatísticas da LD continuariam mostrando as
      // células como em branco depois de "Aplicar nas LDs".
      const key=normCode(r.code); if(!key)return; const rr={...r,code:key,loaded:loaded||r.loaded,_src:r._src||r};
      if(!refIndex.has(key))refIndex.set(key,[]); refIndex.get(key).push(rr);
      const ck=compactCode(key); if(ck){if(!compactIndex.has(ck))compactIndex.set(ck,[]);compactIndex.get(ck).push(rr)}
    }
    for(const r of d.referenceRecords||[]) addRef(r,false);
    for(const r of state.loadedRecords) addRef(r,true);
    // Ordena uma vez aqui (registros carregados primeiro) em vez de copiar e
    // reordenar o array a cada consulta de código.
    const byLoaded=(a,b)=>(b.loaded?1:0)-(a.loaded?1:0);
    for(const arr of refIndex.values()) arr.sort(byLoaded);
    for(const arr of compactIndex.values()) arr.sort(byLoaded);

    const familyTypeValues=new Map(), seriesTypeValues=new Map(), seriesSectorValues=new Map(), seriesDisciplineValues=new Map(), seriesFrontValues=new Map(), seriesExamples=new Map(), familyExamples=new Map(), typeSectorValues=new Map(), typeDiscSectorValues=new Map(), comboFrontValues=new Map(), titleExamples=new Map(), discTextExamples=new Map();
    const projectValues=[],stageValues=[],frontValues=[],languageValues=[];
    for(const e of ex){
      profileAdd(familyTypeValues,e._family,e._tax.type);
      const series=codeSeriesKey(e.code); profileAdd(seriesTypeValues,series,e._tax.type); profileAdd(seriesSectorValues,series,e._tax.sector); profileAdd(seriesDisciplineValues,series,e._tax.discipline); profileAdd(seriesFrontValues,series,e._tax.front); profileAdd(seriesExamples,series,e); profileAdd(familyExamples,e._family,e);
      profileAdd(typeSectorValues,e._tax.type,e._tax.sector);
      profileAdd(typeDiscSectorValues,`${e._tax.type}|${e._tax.discipline}`,e._tax.sector);
      profileAdd(comboFrontValues,`${e._tax.type}|${e._tax.sector}|${e._tax.discipline}`,e._tax.front);
      profileAdd(titleExamples,e._titleNorm,e);
      profileAdd(discTextExamples,e._discNorm,e);
      projectValues.push(e._tax.project); stageValues.push(e._tax.stage); frontValues.push(e._tax.front); languageValues.push(e._tax.language);
    }
    const profileMap=m=>new Map([...m].map(([k,v])=>[k,modeStats(v)]));
    const familyProfiles=profileMap(familyTypeValues), seriesTypeProfiles=profileMap(seriesTypeValues), seriesSectorProfiles=profileMap(seriesSectorValues), seriesDisciplineProfiles=profileMap(seriesDisciplineValues), seriesFrontProfiles=profileMap(seriesFrontValues), typeSectorProfiles=profileMap(typeSectorValues), typeDiscSectorProfiles=profileMap(typeDiscSectorValues), comboFrontProfiles=profileMap(comboFrontValues);

    const used=buildSequencePool(ex);

    const docTypes=(state.customBase?.documentTypes||d.documentTypes||[]).map(x=>({...x,_set:tokenSet(x.description),_norm:normText(x.description)}));
    const sectorsArr=state.customBase?.sectors||d.sectors||[], disciplinesArr=state.customBase?.disciplines||d.disciplines||[];
    const projectsArr=state.customBase?.projects||d.projects||[], stagesArr=state.customBase?.stages||d.stages||[], frontsArr=state.customBase?.fronts||d.fronts||[], languagesArr=state.customBase?.languages||d.languages||[];
    const allowed=state.customBase?.allowedSectorNamesByType||d.allowedSectorNamesByType||{};
    state.model={ex,refIndex,compactIndex,used,docTypes,sectors:dictFrom(sectorsArr),disciplines:dictFrom(disciplinesArr),projects:dictFrom(projectsArr),stages:dictFrom(stagesArr),fronts:dictFrom(frontsArr),languages:dictFrom(languagesArr),allowed,
      familyProfiles,seriesTypeProfiles,seriesSectorProfiles,seriesDisciplineProfiles,seriesFrontProfiles,seriesExamples,familyExamples,typeSectorProfiles,typeDiscSectorProfiles,comboFrontProfiles,titleExamples,discTextExamples,
      globalProject:modeStats(projectValues),globalStage:modeStats(stageValues),globalFront:modeStats(frontValues),globalLanguage:modeStats(languageValues)};
  }

  function findRecordsForCode(input) {
    const m=state.model, key=normCode(input), ck=compactCode(input);
    return m.refIndex.get(key)||m.compactIndex.get(ck)||[];
  }

  function officialTypeByTitle(title) {
    let best={code:'',score:0,description:''};
    for(const t of state.model.docTypes){const sc=phraseScore(title,t.description);if(sc>best.score)best={code:t.code,score:sc,description:t.description};}
    return best;
  }
  function officialDisciplineByText(text) {
    const n=normText(text); if(!n)return {code:'',score:0,description:''}; let best={code:'',score:0,description:''};
    for(const [code,d] of state.model.disciplines){let sc=phraseScore(n,d.description);const dn=normText(d.description);if(dn.length>=4&&n.includes(dn))sc=Math.max(sc,0.99);if(new RegExp(`(^|\\s)${code}(\\s|$)`).test(n))sc=Math.max(sc,0.94);if(sc>best.score)best={code,score:sc,description:d.description};}
    const aliases=[['SST',['SEGURANCA DO TRABALHO','SEGURANCA','SST']],['QUA',['QUALIDADE']],['SOL',['SOLDAGEM','SOLDA']],['COM',['COMISSIONAMENTO']],['TUB',['TUBULACAO','PIPING']],['ELE',['ELETRICA','ELETRICO']],['INS',['INSTRUMENTACAO','INSTRUMENTO']],['MEC',['MECANICA']],['CIV',['CIVIL']],['HVA',['HVAC']],['GES',['GESTAO']],['GER',['GERAL']],['SPM',['SUPRIMENTOS']]];
    for(const [code,words] of aliases)if(words.some(w=>n.includes(normText(w)))){const d=state.model.disciplines.get(code);return {code,score:1,description:d?.description||words[0]};}
    return best.score>=0.62?best:{code:'',score:best.score,description:best.description};
  }
  function nearestExamples(rec,k=20) {
    const ts=tokenSet(rec.title), ds=tokenSet(rec.disciplineText), fam=docFamily(rec.code), compact=compactCode(rec.code), series=codeSeriesKey(rec.code); const scored=[];
    const seriesPool=series?(state.model.seriesExamples.get(series)||[]):[], familyPool=fam?(state.model.familyExamples.get(fam)||[]):[]; const pool=seriesPool.length>=3?seriesPool:(familyPool.length>=8?familyPool:state.model.ex);
    for(const e of pool){
      const t=jaccard(ts,e._titleSet), d=jaccard(ds,e._discSet), f=fam&&fam===e._family?1:0;
      const ec=e._compact, codeOverlap=compact&&ec ? (compact.slice(0,-3)===ec.slice(0,-3)?1:(compact.slice(0,12)===ec.slice(0,12)?0.35:0)) : 0;
      const score=t*0.64+d*0.19+f*0.12+codeOverlap*0.05;
      if(score>0.04) scored.push({score,e,t,d,f});
    }
    scored.sort((a,b)=>b.score-a.score); return scored.slice(0,k);
  }
  function voteWithDominance(neighbors,field,filter=null) {
    const votes=new Map();
    for(const n of neighbors){const val=n.e._tax[field];if(!val||filter&&!filter(val))continue;const w=Math.pow(Math.max(n.score,0.01),3);votes.set(val,(votes.get(val)||0)+w)}
    const arr=[...votes].sort((a,b)=>b[1]-a[1]),total=arr.reduce((s,x)=>s+x[1],0);return {value:arr[0]?.[0]||'',share:total?(arr[0]?.[1]||0)/total:0,total};
  }
  /* Resolve o valor de uma coluna da LD contra um catálogo oficial.
     Exige correspondência exata ou quase — o valor vem de uma coluna
     rotulada, então "parecido" não basta: aceitar aproximação aqui seria
     adivinhar com a aparência de evidência. Medição que motivou o rigor:
     casar catálogo com o TÍTULO livre acerta só 42% para frente, 0% para
     obra e nunca dispara para etapa, então o título não alimenta estes
     segmentos — apenas colunas explicitamente rotuladas. */
  function matchCatalog(map, text) {
    const n = normText(text); if(!n) return null;
    const up = String(text||'').trim().toUpperCase();
    if(map.has(up)) return {code:up, score:1, description:map.get(up).description, how:'é o código oficial'};
    let best={code:'',score:0,description:''};
    for(const [code,x] of map){
      const dn=normText(x.description); if(!dn) continue;
      let sc;
      if(dn===n) sc=1;
      else if(dn.length>=5 && n.includes(dn)) sc=0.97;
      else if(n.length>=5 && dn.includes(n)) sc=0.93;
      else sc=jaccard(new Set(descriptionTokens(n)), new Set(descriptionTokens(dn)));
      if(sc>best.score) best={code,score:sc,description:x.description};
    }
    return best.score>=0.90 ? {...best, how:'corresponde à descrição do catálogo'} : null;
  }

  /* Evidência declarada numa coluna da própria LD. */
  function fromColumn(map, text, label) {
    if(!text) return null;
    const m = matchCatalog(map, text);
    if(!m) return null;
    return {value:m.code, quality:97, evidence:`A coluna ${label} da LD traz “${String(text).trim()}”, que ${m.how} ${m.code} — ${m.description}`};
  }

  function sectorAllowedByOfficialMatrix(type,sector) {
    const allowed=state.model.allowed[type]; if(!Array.isArray(allowed)||!allowed.length)return {known:false,allowed:true,category:''};
    const category=SECTOR_CATEGORY_BY_CODE[sector]||''; if(!category)return {known:false,allowed:true,category:''};
    return {known:true,allowed:allowed.some(x=>normText(x)===normText(category)),category};
  }
  /* O tipo declarado no próprio código, quando é um código válido do
     catálogo oficial. A confiança acompanha a corroboração do título:
     código e título discordando vira hipótese para revisão, não certeza. */
  function typeFromCodeToken(rec) {
    const dec=decodeDocCode(rec.code); if(dec.family!=='ET'||!dec.typeToken) return null;
    const official=state.model.docTypes.find(t=>t.code===dec.typeToken); if(!official) return null;
    const corr=phraseScore(rec.title,official.description);
    if(corr>=0.25) return {value:official.code,quality:Math.round(93+Math.min(5,corr*5)),
      evidence:`Tipo declarado no código (${dec.typeToken}) confere com o catálogo oficial — ${official.description} — e o título corrobora (${Math.round(corr*100)}%)`};
    return {value:official.code,quality:66,requiresReview:true,
      evidence:`O código declara o tipo ${dec.typeToken} (${official.description}), mas o título “${rec.title}” não corrobora essa descrição. Confirme antes de aplicar`};
  }

  function chooseType(rec,near) {
    const series=codeSeriesKey(rec.code), sp=series?state.model.seriesTypeProfiles.get(series):null;
    if(sp&&sp.total>=4&&sp.share>=0.80)return {value:sp.value,quality:98,evidence:`Série documental ${series} usa ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
    const tok=typeFromCodeToken(rec); if(tok) return tok;
    const exact=(state.model.titleExamples.get(normText(rec.title))||[]).filter(e=>!series||codeSeriesKey(e.code)===series||e._family===docFamily(rec.code));
    if(exact.length){const st=modeStats(exact.map(e=>e._tax.type));if(st.share>=0.9)return {value:st.value,quality:96,evidence:`Título equivalente dentro da mesma família/série: ${st.value} (${Math.round(st.share*100)}%)`};}
    const off=officialTypeByTitle(rec.title); if(off.code&&off.score>=0.76)return {value:off.code,quality:Math.round(90+off.score*8),evidence:`Descrição oficial da base: ${off.code} — ${off.description}`};
    const fp=state.model.familyProfiles.get(docFamily(rec.code)); if(fp&&fp.total>=4&&fp.share>=0.97)return {value:fp.value,quality:94,evidence:`Família do código: ${fp.value} em ${Math.round(fp.share*100)}% de ${fp.total} referências`};
    const v=voteWithDominance(near,'type'); if(v.value&&v.share>=0.72&&near[0]?.score>=0.34)return {value:v.value,quality:Math.round(72+Math.min(16,near[0].score*20)),evidence:`Consenso de documentos equivalentes (${Math.round(v.share*100)}%)`};
    if(off.code&&off.score>=0.58)return {value:off.code,quality:68,evidence:`Melhor correspondência na lista oficial: ${off.code} — ${off.description}`};
    return {value:'',quality:0,evidence:'Tipo documental sem evidência suficiente na base'};
  }
  function chooseDiscipline(rec,near) {
    const series=codeSeriesKey(rec.code), sp=series?state.model.seriesDisciplineProfiles.get(series):null;
    if(sp&&sp.total>=4&&sp.share>=0.80)return {value:sp.value,quality:98,evidence:`A série ${series} usa a disciplina ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
    const dec=decodeDocCode(rec.code);
    if(dec.family==='ET'&&dec.discToken){
      const off=state.model.disciplines.get(dec.discToken);
      if(off) return {value:dec.discToken,quality:96,evidence:`Disciplina declarada no código (${dec.discToken}) é um código válido do catálogo oficial — ${off.description}`};
      /* O código declara uma disciplina que não existe no catálogo (EST =
         estáticos, DIN = dinâmicos, SEG = segurança). Aqui resolvemos APENAS
         pela descrição de disciplina da LD: usar o título sequestraria a
         escolha, porque em relatório de inspeção ele contém "INSPEÇÃO" e
         "RECEBIMENTO", que casam com disciplinas do catálogo e substituem a
         disciplina real do equipamento. Sem correspondência defensável, o
         documento vai para revisão em vez de receber um palpite. */
      /* O próprio token pode ser uma variante do código oficial (HVAC -> HVA),
         resolvida pelo catálogo/apelidos. Vem antes da descrição da LD porque
         nesses documentos a coluna de disciplina às vezes traz a classe do
         equipamento (ESTATICOS) em vez da disciplina técnica. */
      const byTok=officialDisciplineByText(dec.discToken);
      if(byTok.code&&byTok.score>=0.92) return {value:byTok.code,quality:92,evidence:`A disciplina ${dec.discToken} declarada no código corresponde a ${byTok.code} — ${byTok.description} no catálogo oficial`};
      const byLd=officialDisciplineByText(rec.disciplineText);
      if(byLd.code&&byLd.score>=0.92) return {value:byLd.code,quality:88,evidence:`Disciplina do código (${dec.discToken}) não consta do catálogo; a descrição de disciplina da LD indica ${byLd.code} — ${byLd.description}`};
      return {value:'',quality:0,evidence:`O código declara a disciplina ${dec.discToken}, que não existe no catálogo oficial, e a descrição “${rec.disciplineText}” não corresponde a nenhuma disciplina da base. Definição manual necessária`};
    }
    const exact=(state.model.titleExamples.get(normText(rec.title))||[]).filter(e=>!series||codeSeriesKey(e.code)===series||e._family===docFamily(rec.code));
    if(exact.length){const st=modeStats(exact.map(e=>e._tax.discipline));if(st.share>=0.9)return {value:st.value,quality:95,evidence:`Título equivalente na mesma família/série usa disciplina ${st.value} (${Math.round(st.share*100)}%)`};}
    const v=voteWithDominance(near,'discipline'); if(v.value&&v.share>=0.76&&near[0]?.score>=0.42)return {value:v.value,quality:88,evidence:`Documentos equivalentes convergem para ${v.value} (${Math.round(v.share*100)}%)`};
    const off=officialDisciplineByText(`${rec.disciplineText} ${rec.title}`); if(off.code&&off.score>=0.86)return {value:off.code,quality:84,evidence:`Disciplina explícita na LD/título: ${off.code} — ${off.description}`};
    const sameDisc=state.model.discTextExamples.get(normText(rec.disciplineText))||[]; if(sameDisc.length){const st=modeStats(sameDisc.map(e=>e._tax.discipline));if(st.share>=0.9)return {value:st.value,quality:82,evidence:`Mesma descrição de disciplina em ${st.total} referência(s) (${Math.round(st.share*100)}%)`};}
    return {value:'',quality:0,evidence:'Disciplina sem evidência suficiente na base/LD'};
  }
  function chooseSector(type,discipline,near,rec=null) {
    const col=rec?fromColumn(state.model.sectors,rec.sectorText,'de setor emissor'):null; if(col) return col;
    const series=rec?codeSeriesKey(rec.code):'', sp=series?state.model.seriesSectorProfiles.get(series):null; if(sp&&sp.total>=4&&sp.share>=0.80)return {value:sp.value,quality:98,evidence:`A série ${series} usa o setor ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
    let p=state.model.typeDiscSectorProfiles.get(`${type}|${discipline}`); if(p&&p.total>=3&&p.share>=0.68)return {value:p.value,quality:94,evidence:`Mesmo tipo + disciplina usam ${p.value} em ${Math.round(p.share*100)}% de ${p.total} referências`};
    p=state.model.typeSectorProfiles.get(type); if(p&&p.total>=4&&p.share>=0.78)return {value:p.value,quality:89,evidence:`Tipo ${type} usa ${p.value} em ${Math.round(p.share*100)}% de ${p.total} referências`};
    const mx=sectorFromOfficialMatrix(type); if(mx) return mx;
    const v=voteWithDominance(near,'sector'); if(v.value&&v.share>=0.70&&near[0]?.score>=0.32)return {value:v.value,quality:78,evidence:`Consenso do setor em documentos equivalentes (${Math.round(v.share*100)}%)`};
    if(p&&p.value&&p.share>=0.60)return {value:p.value,quality:69,evidence:`Setor mais recorrente para ${type} (${Math.round(p.share*100)}%)`};
    return {value:'',quality:0,evidence:'Setor emissor sem evidência suficiente'};
  }
  function chooseFront(type,sector,discipline,near,rec=null) {
    const col=rec?fromColumn(state.model.fronts,rec.frontText,'de frente'):null; if(col) return col;
    const series=rec?codeSeriesKey(rec.code):'', sp=series?state.model.seriesFrontProfiles.get(series):null; if(sp&&sp.total>=4&&sp.share>=0.90)return {value:sp.value,quality:98,evidence:`A série ${series} usa a frente ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
    const p=state.model.comboFrontProfiles.get(`${type}|${sector}|${discipline}`); if(p&&p.total>=2&&p.share>=0.80)return {value:p.value,quality:92,evidence:`Frente predominante para o mesmo tipo/setor/disciplina (${Math.round(p.share*100)}%)`};
    const v=voteWithDominance(near,'front'); if(v.value&&v.share>=0.82)return {value:v.value,quality:82,evidence:`Frente indicada pelas referências mais equivalentes (${Math.round(v.share*100)}%)`};
    const g=state.model.globalFront; if(g.share>=0.95)return {value:g.value,quality:78,evidence:`Frente padrão das LDs de referência (${Math.round(g.share*100)}% de ${g.total})`};
    return {value:'',quality:0,evidence:'Frente/fase sem evidência suficiente'};
  }
  const SEQ_MAX = 9999; // o padrão reserva 4 dígitos para o sequencial

  /* Reserva o próximo sequencial livre do prefixo.
     Retorna '' quando o prefixo esgotou os 9999 números — antes lançava
     uma exceção que subia até analyze() e DESCARTAVA a análise inteira,
     inclusive os milhares de documentos já classificados com sucesso.
     Também corrige a duplicidade no limite: o laço parava em 9999 mesmo
     com 9999 já ocupado e o número era devolvido uma segunda vez. */
  function reserveSequence(prefix) {
    let slot=state.model.used.get(prefix);
    if(!slot){slot={set:new Set(),max:0};state.model.used.set(prefix,slot);}
    let n=slot.max+1;
    while(n<=SEQ_MAX && slot.set.has(n)) n++;
    if(n>SEQ_MAX) return '';
    slot.set.add(n); slot.max=n;
    return String(n).padStart(4,'0');
  }

  function describeTaxonomy(taxonomy,fieldEvidence={}) {
    const p=splitTax(taxonomy); if(!p)return null;
    const desc=(map,code,fallback='')=>map.get(code)?.description||fallback||'Código presente na taxonomia; descrição não localizada na revisão carregada';
    return {
      project:{code:p.project,description:desc(state.model.projects,p.project,'Identificação da obra/estudo observada nas LDs de referência'),meaning:'Identifica o estudo, obra ou AG.',evidence:fieldEvidence.project||''},
      type:{code:p.type,description:desc(new Map(state.model.docTypes.map(x=>[x.code,x])),p.type),meaning:'Classifica o tipo de documento ou registro.',evidence:fieldEvidence.type||''},
      sector:{code:p.sector,description:desc(state.model.sectors,p.sector),meaning:'Identifica o setor responsável pela emissão.',evidence:fieldEvidence.sector||''},
      stage:{code:p.stage,description:desc(state.model.stages,p.stage),meaning:'Indica a etapa do projeto.',evidence:fieldEvidence.stage||''},
      front:{code:p.front,description:desc(state.model.fronts,p.front),meaning:'Indica a frente de serviço ou a fase da proposta.',evidence:fieldEvidence.front||''},
      discipline:{code:p.discipline,description:desc(state.model.disciplines,p.discipline),meaning:'Identifica a disciplina técnica do documento.',evidence:fieldEvidence.discipline||''},
      language:{code:p.language,description:desc(state.model.languages,p.language),meaning:'Indica o idioma do documento.',evidence:fieldEvidence.language||''},
      sequence:{code:p.sequence,description:'Sequencial de 4 dígitos',meaning:'Diferencia documentos dentro do mesmo prefixo de taxonomia.',evidence:fieldEvidence.sequence||''}
    };
  }

  function inferTaxonomy(rec, cache) {
    const current=String(rec.taxonomy||'').trim().toUpperCase();
    if(validTax(current)){const details=describeTaxonomy(current,{sequence:'Sequencial já existente e validado.'});return {taxonomy:current,confidence:100,criterion:'Taxonomia já validada na LD/base de referência.',mode:'existing',details,baseValidation:'Taxonomia existente preservada.'};}
    const key=normCode(rec.code); if(cache.has(key)){const old=cache.get(key);return {...old,criterion:old.criterion+' · mesmo código reutilizado'};}

    const sameCodeValid=(rec.allMatches||[]).map(x=>String(x.taxonomy||'').trim().toUpperCase()).find(validTax);
    if(sameCodeValid){const details=describeTaxonomy(sameCodeValid,{sequence:'Sequencial reutilizado do mesmo código já taxonomizado.'});const out={taxonomy:sameCodeValid,confidence:99,criterion:'Mesmo código já possui taxonomia validada em outra LD/referência; valor reutilizado integralmente.',mode:'same-code',details,baseValidation:'Correspondência exata de código.'};cache.set(key,out);return out;}

    const exactExamples=state.model.ex.filter(e=>normCode(e.code)===key);
    if(exactExamples.length){const tax=exactExamples[0].taxonomy,details=describeTaxonomy(tax,{sequence:'Sequencial da referência exata.'});const out={taxonomy:tax,confidence:98,criterion:'Mesmo código possui taxonomia validada nas LDs de referência.',mode:'exact',details,baseValidation:'Correspondência exata de código na memória validada.'};cache.set(key,out);return out;}

    const near=nearestExamples(rec); if(!near.length)return {taxonomy:'',confidence:0,criterion:'Sem referências equivalentes suficientes. O sistema não inventou uma taxonomia.',mode:'none',details:null,baseValidation:'Revisão obrigatória.'};
    const type=chooseType(rec,near), discipline=chooseDiscipline(rec,near);
    if(!type.value||!discipline.value){return {taxonomy:'',confidence:Math.min(type.quality||0,discipline.quality||0),criterion:`Classificação interrompida para evitar erro. ${type.evidence}. ${discipline.evidence}.`,mode:'none',details:null,baseValidation:'Revisão obrigatória: tipo ou disciplina não fechou com segurança.'};}
    const sector=chooseSector(type.value,discipline.value,near,rec); if(!sector.value)return {taxonomy:'',confidence:Math.min(type.quality,discipline.quality,55),criterion:`Classificação interrompida para evitar setor incorreto. ${sector.evidence}.`,mode:'none',details:null,baseValidation:'Revisão obrigatória: setor emissor não fechou com segurança.'};
    const front=chooseFront(type.value,sector.value,discipline.value,near,rec); if(!front.value)return {taxonomy:'',confidence:58,criterion:'Classificação interrompida: frente/fase não pôde ser definida com segurança.',mode:'none',details:null,baseValidation:'Revisão obrigatória: frente/fase.'};

    /* Obra, etapa e idioma vinham exclusivamente do consenso global das
       referências: a linha da LD não era consultada nem quando trazia a
       coluna correspondente. Agora a coluna rotulada, quando resolve contra
       o catálogo oficial, tem precedência sobre o consenso. */
    const projCol=fromColumn(state.model.projects,rec.projectText,'de obra');
    const stageCol=fromColumn(state.model.stages,rec.stageText,'de etapa');
    const langCol=fromColumn(state.model.languages,rec.languageText,'de idioma');
    const project=projCol?projCol.value:(state.model.globalProject.share>=0.95?state.model.globalProject.value:(state.data.defaultProject||''));
    const stage=stageCol?stageCol.value:(state.model.globalStage.share>=0.95?state.model.globalStage.value:(state.data.defaultStage||''));
    const language=langCol?langCol.value:(state.model.globalLanguage.share>=0.95?state.model.globalLanguage.value:(state.data.defaultLanguage||''));
    if(!project||!stage||!language)return {taxonomy:'',confidence:55,criterion:'Base de referência não apresentou consenso suficiente para obra, etapa ou idioma.',mode:'none',details:null,baseValidation:'Revisão obrigatória.'};

    const prefix=[project,type.value,sector.value,stage,front.value,discipline.value,language].join('-');
    const seq=reserveSequence(prefix);
    if(!seq) return {taxonomy:'',confidence:0,criterion:`O prefixo ${prefix} já utiliza os ${SEQ_MAX} sequenciais previstos no padrão de 4 dígitos. Um novo número duplicaria um documento existente, por isso a sugestão automática foi interrompida.`,mode:'none',details:null,baseValidation:'Revisão obrigatória: limite de sequenciais do prefixo atingido.',requiresReview:true,seqExhausted:prefix};
    const taxonomy=`${prefix}-${seq}`;
    const matrix=sectorAllowedByOfficialMatrix(type.value,sector.value);
    const fieldEvidence={project:projCol?projCol.evidence:`${Math.round(state.model.globalProject.share*100)}% das taxonomias de referência usam ${project}.`,type:type.evidence,sector:sector.evidence,stage:stageCol?stageCol.evidence:`${Math.round(state.model.globalStage.share*100)}% das referências usam ${stage}.`,front:front.evidence,discipline:discipline.evidence,language:langCol?langCol.evidence:`${Math.round(state.model.globalLanguage.share*100)}% das referências usam ${language}.`,sequence:'Próximo sequencial após o maior número já utilizado neste prefixo; números existentes não são reutilizados.'};
    let confidence=Math.round(type.quality*0.31+sector.quality*0.24+discipline.quality*0.27+front.quality*0.08+9.5);confidence=Math.max(60,Math.min(96,confidence));
    let validation='Compatibilidade baseada na estrutura oficial e nas taxonomias já validadas das LDs.';
    let requiresReview=!!type.requiresReview;
    if(requiresReview) validation=`${type.evidence}. Revisão manual recomendada antes de aplicar.`;
    if(matrix.known&&!matrix.allowed){const sk=codeSeriesKey(rec.code),st=sk?state.model.seriesTypeProfiles.get(sk):null,ss=sk?state.model.seriesSectorProfiles.get(sk):null,sd=sk?state.model.seriesDisciplineProfiles.get(sk):null;const strongSeries=!!(st&&ss&&sd&&st.total>=4&&ss.total>=4&&sd.total>=4&&st.share>=0.90&&ss.share>=0.90&&sd.share>=0.90);if(strongSeries){confidence=Math.min(confidence,64);requiresReview=true;validation=`A matriz geral “TIPO DE DOCUMENTO POR SETOR” não associa ${type.value} à categoria ${matrix.category}. A série ${sk} apresenta padrão histórico consistente (${Math.round(ss.share*100)}% no setor ${sector.value}), por isso a hipótese é exibida, mas a divergência com a base oficial exige revisão manual antes de aplicar.`;}else{confidence=Math.min(confidence,64);requiresReview=true;validation=`A matriz “TIPO DE DOCUMENTO POR SETOR” não associa ${type.value} à categoria ${matrix.category} e não há série suficientemente consolidada para justificar a exceção. Revisão manual obrigatória antes de aplicar.`;}}
    const details=describeTaxonomy(taxonomy,fieldEvidence);
    const similar=near[0].e.title||near[0].e.code;
    const criterion=`Base oficial + padrões validados. Referência mais próxima: “${similar}” (${Math.round(near[0].score*100)}%). ${type.evidence}; ${sector.evidence}; ${discipline.evidence}; ${front.evidence}.`;
    const out={taxonomy,confidence,criterion,mode:'inferred',details,baseValidation:validation,requiresReview};cache.set(key,out);return out;
  }

  // ---------- UI / workflow ----------
  function refreshStats() {
    const types=(state.customBase?.documentTypes||state.data.documentTypes||[]).length;
    const examples=(state.data.examples||[]).length;
    const refs=(state.data.referenceRecords||[]).length;
    els.statTypes.textContent=types.toLocaleString('pt-BR');
    els.statExamples.textContent=examples.toLocaleString('pt-BR');
    els.statRefs.textContent=refs.toLocaleString('pt-BR');
    const custom=state.customBase;
    els.baseStatus.innerHTML=custom
      ? `<strong>Base personalizada ativa</strong> · ${escapeHtml(custom.fileName)} · ${custom.documentTypes.length} tipos documentais.`
      : `<strong>Base incorporada ativa</strong> · ${escapeHtml(state.data.sourceFile||'CONSAG')} · revisão de referência ${escapeHtml(state.data.version||'')}.`;
    // Publica os números em vez de deixar a UI observar mutações de #statTypes.
    emit('tax:base', { custom:!!custom, fileName:custom?.fileName||'', types, examples, refs });
  }
  function refreshCodeCount(){const n=parseCodes().length;els.codeCount.textContent=`${n} ${n===1?'código':'códigos'}`}
  function parseCodes(){return els.codesInput.value.split(/[\n;]+/).map(s=>s.trim()).filter(Boolean)}

  /* ══════════════════════════════════════════════════════════════
     PAINEL DE LDs — renderizado a partir de state.loadedFiles.
     Este é o ÚNICO dono do nó #ldList. Nenhuma outra camada lê ou
     reescreve esse DOM: ui.js recebe os dados pelo TaxonomiaBus.
     ══════════════════════════════════════════════════════════════ */

  function fmtInt(n){ return Number(n||0).toLocaleString('pt-BR'); }
  function fmtBytes(n) {
    n = Number(n)||0; if(n <= 0) return '—';
    const u=['B','KB','MB','GB']; let i=0, v=n;
    while(v >= 1024 && i < u.length-1){ v/=1024; i++; }
    return `${v.toFixed(i>0 && v<10 ? 1 : 0)} ${u[i]}`;
  }
  function fmtDateTime(ts) {
    if(!ts) return '—';
    try { return new Date(ts).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
    catch { return '—'; }
  }

  // Estatísticas por LD, calculadas uma vez por carga (e após aplicar),
  // nunca dentro de laços de render.
  function computeBookStats(book) {
    let blanks=0, filled=0, invalid=0;
    for(const r of book.records) {
      const t=String(r.taxonomy||'').trim();
      if(!t) blanks++;
      else if(validTax(t)) filled++;
      else invalid++;
    }
    book.stats={ records:book.records.length, blanks, filled, invalid };
    return book.stats;
  }

  function ldSituation(st) {
    if(!st || !st.records) return {label:'Sem documentos reconhecidos', kind:'warn'};
    if(st.blanks === 0 && st.invalid === 0) return {label:'Totalmente taxonomizada', kind:'ok'};
    if(st.blanks === st.records) return {label:'Taxonomia totalmente em branco', kind:'blank'};
    if(st.blanks) return {label:`${fmtInt(st.blanks)} em branco`, kind:'blank'};
    return {label:`${fmtInt(st.invalid)} inválida(s)`, kind:'warn'};
  }

  function ldSnapshot() {
    return state.loadedFiles.map(f => {
      const st = f.stats || computeBookStats(f);
      return {
        id:f.id, name:f.name, size:f.size||0, uploadedAt:f.uploadedAt||0,
        records:st.records, blanks:st.blanks, filled:st.filled, invalid:st.invalid,
        sheets:(f.sheets||[]).length, origin:f.origin||'Upload local',
        situation:ldSituation(st)
      };
    });
  }

  function emitLDState() {
    const files = ldSnapshot();
    emit('tax:lds', {
      files,
      total: files.length,
      records: files.reduce((n,f)=>n+f.records, 0),
      blanks:  files.reduce((n,f)=>n+f.blanks, 0)
    });
  }

  function ldVisibleFiles() {
    const q = state.ldQuery.trim().toLowerCase();
    let list = q ? state.loadedFiles.filter(f => f.name.toLowerCase().includes(q)) : state.loadedFiles.slice();
    const s = state.ldSort;
    list.sort((a,b)=>{
      const sa=a.stats||computeBookStats(a), sb=b.stats||computeBookStats(b);
      if(s==='name')    return a.name.localeCompare(b.name,'pt-BR');
      if(s==='records') return sb.records - sa.records;
      if(s==='blanks')  return sb.blanks  - sa.blanks;
      return (b.uploadedAt||0) - (a.uploadedAt||0);
    });
    return list;
  }

  const LD_EMPTY_ICON = `<svg class="ld-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><line x1="9" y1="14" x2="15" y2="14"/><line x1="9" y1="17.5" x2="13" y2="17.5"/></svg>`;

  function renderLDPanel() {
    const total = state.loadedFiles.length;

    if(els.ldToolbar) els.ldToolbar.hidden = total === 0;
    if(els.ldCount) {
      const recs = state.loadedFiles.reduce((n,f)=>n+((f.stats||computeBookStats(f)).records),0);
      els.ldCount.textContent = total ? `${fmtInt(total)} LD${total!==1?'s':''} · ${fmtInt(recs)} registro${recs!==1?'s':''}` : '';
    }

    if(!total) {
      els.ldList.className = 'ld-empty';
      els.ldList.innerHTML = `
        ${LD_EMPTY_ICON}
        <p class="ld-empty-title">Nenhuma LD carregada</p>
        <p class="ld-empty-text">Carregue uma Lista de Documentos <strong>.xlsx</strong> ou <strong>.xlsm</strong> para detectar taxonomias em branco e gravar as sugestões no próprio arquivo.<br>A consulta por código continua funcionando com as referências incorporadas.</p>
        <button type="button" class="btn btn-primary btn-sm ld-empty-cta" data-ld-action="pick">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
          Carregar LD
        </button>`;
      emitLDState();
      return;
    }

    const list = ldVisibleFiles();

    if(!list.length) {
      els.ldList.className = 'ld-empty';
      els.ldList.innerHTML = `
        ${LD_EMPTY_ICON}
        <p class="ld-empty-title">Nenhuma LD corresponde à pesquisa</p>
        <p class="ld-empty-text">${fmtInt(total)} LD${total!==1?'s':''} carregada${total!==1?'s':''}, mas nenhuma contém “${escapeHtml(state.ldQuery)}”.</p>
        <button type="button" class="btn btn-outline btn-sm ld-empty-cta" data-ld-action="clear-search">Limpar pesquisa</button>`;
      emitLDState();
      return;
    }

    els.ldList.className = 'ld-loaded';
    els.ldList.innerHTML = list.map(f => {
      const st = f.stats || computeBookStats(f);
      const sit = ldSituation(st);
      const tags = [];
      if(st.blanks)  tags.push(`<span class="ld-tag ld-tag--blank">${fmtInt(st.blanks)} em branco</span>`);
      if(st.filled)  tags.push(`<span class="ld-tag ld-tag--ok">${fmtInt(st.filled)} preenchida${st.filled!==1?'s':''}</span>`);
      if(st.invalid) tags.push(`<span class="ld-tag ld-tag--warn">${fmtInt(st.invalid)} inválida${st.invalid!==1?'s':''}</span>`);
      tags.push(`<span class="ld-tag ld-tag--src">${escapeHtml(f.origin||'Upload local')}</span>`);
      return `
        <article class="ld-item" data-id="${escapeHtml(f.id)}">
          <div class="ld-item-icon ld-item-icon--${sit.kind}" aria-hidden="true">${sit.kind==='ok'?'✓':sit.kind==='blank'?'!':'•'}</div>
          <div class="ld-item-body">
            <div class="ld-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
            <div class="ld-item-meta">
              <span title="Data de upload">${fmtDateTime(f.uploadedAt)}</span>
              <span aria-hidden="true">·</span>
              <span title="Registros reconhecidos">${fmtInt(st.records)} registro${st.records!==1?'s':''}</span>
              <span aria-hidden="true">·</span>
              <span title="Tamanho do arquivo">${fmtBytes(f.size)}</span>
            </div>
            <div class="ld-item-tags">${tags.join('')}</div>
          </div>
          <button type="button" class="ld-item-rm" data-remove="${escapeHtml(f.id)}" title="Remover ${escapeHtml(f.name)} da análise" aria-label="Remover ${escapeHtml(f.name)} da análise">×</button>
        </article>`;
    }).join('');

    emitLDState();
  }

  /* ── Estado de carregamento (nome, tamanho, barra, %, status) ── */
  function renderLDUpload() {
    if(!els.ldUpload) return;
    const items = state.ldUpload;
    if(!items.length){ els.ldUpload.hidden = true; els.ldUpload.innerHTML=''; return; }

    const done  = items.filter(u=>u.state==='done').length;
    const fail  = items.filter(u=>u.state==='error').length;
    const overall = Math.round(items.reduce((n,u)=>n+u.pct,0) / items.length);
    const heading = fail ? 'Falha ao carregar LD'
      : done === items.length ? 'LDs processadas'
      : items.length > 1 ? `Carregando LDs… (${done+1} de ${items.length})` : 'Carregando LD…';

    els.ldUpload.hidden = false;
    els.ldUpload.innerHTML = `
      <div class="ld-up-head">
        <span class="ld-up-title">${escapeHtml(heading)}</span>
        <span class="ld-up-pct">${overall}%</span>
      </div>
      <div class="ld-up-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${overall}" aria-label="${escapeHtml(heading)}">
        <div class="ld-up-fill${fail?' is-error':''}" style="width:${overall}%"></div>
      </div>
      <ul class="ld-up-list">
        ${items.map(u=>`
          <li class="ld-up-row ld-up-row--${u.state}">
            <span class="ld-up-name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</span>
            <span class="ld-up-size">${fmtBytes(u.size)}</span>
            <span class="ld-up-mini"><span class="ld-up-mini-fill" style="width:${u.pct}%"></span></span>
            <span class="ld-up-status">${escapeHtml(u.status)}</span>
            <span class="ld-up-rowpct">${u.pct}%</span>
          </li>`).join('')}
      </ul>`;
  }

  function ldUploadStart(files) {
    state.ldUpload = files.map(f => ({ name:f.name, size:f.size, pct:0, status:'Na fila', state:'queued' }));
    els.ldDrop?.classList.add('is-busy');
    clearTimeout(ldUploadStart._t);
    renderLDUpload();
  }
  function ldUploadStep(i, pct, status, kind) {
    const u = state.ldUpload[i]; if(!u) return;
    u.pct = Math.max(u.pct, pct); u.status = status;
    u.state = kind || (u.pct >= 100 ? 'done' : 'active');
    renderLDUpload();
  }
  function ldUploadEnd(keepMs) {
    els.ldDrop?.classList.remove('is-busy');
    clearTimeout(ldUploadStart._t);
    ldUploadStart._t = setTimeout(() => { state.ldUpload = []; renderLDUpload(); }, keepMs);
  }

  /* ── Estado de sucesso ── */
  function showLDSuccess(books) {
    if(!els.ldSuccess || !books.length) return;
    const recs = books.reduce((n,b)=>n+b.stats.records,0);
    const blanks = books.reduce((n,b)=>n+b.stats.blanks,0);
    const one = books.length === 1 ? books[0] : null;
    els.ldSuccess.hidden = false;
    els.ldSuccess.className = 'ld-success';
    els.ldSuccess.innerHTML = `
      <div class="ld-success-icon" aria-hidden="true">✓</div>
      <div class="ld-success-body">
        <p class="ld-success-title">${books.length===1?'LD carregada com sucesso':`${books.length} LDs carregadas com sucesso`}</p>
        <dl class="ld-success-grid">
          <div><dt>Nome</dt><dd title="${escapeHtml(one?one.name:books.map(b=>b.name).join(', '))}">${escapeHtml(one ? one.name : `${books.length} arquivos`)}</dd></div>
          <div><dt>Data</dt><dd>${fmtDateTime(books[books.length-1].uploadedAt)}</dd></div>
          <div><dt>Documentos</dt><dd>${fmtInt(recs)}</dd></div>
          <div><dt>Situação</dt><dd>${blanks ? `${fmtInt(blanks)} com taxonomia em branco` : 'Todas as taxonomias preenchidas'}</dd></div>
        </dl>
      </div>
      <button type="button" class="ld-success-close" data-ld-action="dismiss-success" aria-label="Fechar aviso">×</button>`;
    clearTimeout(showLDSuccess._t);
    showLDSuccess._t = setTimeout(() => { if(els.ldSuccess) els.ldSuccess.hidden = true; }, 12000);
  }

  function removeLD(id) {
    const book = state.loadedFiles.find(f=>f.id===id); if(!book) return;
    state.loadedFiles = state.loadedFiles.filter(f=>f.id!==id);
    state.loadedRecords = state.loadedFiles.flatMap(f=>f.records);
    state.modelDirty = true;
    ensureModel();
    renderLDPanel();
    if(els.ldSuccess) els.ldSuccess.hidden = true;
    toast(`“${book.name}” removida da análise.`);
  }

  function clearAllLDs() {
    if(!state.loadedFiles.length) return;
    const n = state.loadedFiles.length;
    state.loadedFiles = []; state.loadedRecords = [];
    state.modelDirty = true;
    ensureModel();
    renderLDPanel();
    if(els.ldSuccess) els.ldSuccess.hidden = true;
    toast(`${n} ${n===1?'LD removida':'LDs removidas'} da análise.`);
  }

  async function loadLDFiles(fileList) {
    if(state.ldBusy){ toast('Aguarde o carregamento em andamento.','error'); return; }

    const incoming = [...fileList];
    if(!incoming.length) return;

    const accepted = incoming.filter(f => /\.(xlsx|xlsm)$/i.test(f.name));
    const rejected = incoming.length - accepted.length;
    if(!accepted.length){ toast('Formato não suportado. Envie arquivos .xlsx ou .xlsm.','error'); return; }

    // Deduplicação: mesmo nome + mesmo tamanho já carregado.
    const known = new Set(state.loadedFiles.map(f => `${f.name}|${f.size||0}`));
    const list = [], duplicates = [];
    for(const f of accepted){
      const key = `${f.name}|${f.size||0}`;
      if(known.has(key)){ duplicates.push(f.name); continue; }
      known.add(key); list.push(f);
    }
    if(!list.length){
      toast(duplicates.length===1 ? `“${duplicates[0]}” já está carregada.` : `${duplicates.length} LDs já estavam carregadas.`,'error');
      return;
    }

    state.ldBusy = true;
    if(els.ldSuccess) els.ldSuccess.hidden = true;
    ldUploadStart(list);

    const loadedNow = [];
    let failed = null;
    try {
      for(let i=0; i<list.length; i++){
        const file = list[i];
        ldUploadStep(i, 8, 'Lendo arquivo…', 'active');
        await yieldUI();
        const book = await parseWorkbook(file);
        ldUploadStep(i, 45, 'Indexando documentos…', 'active');
        await yieldUI();
        await extractLDRecords(book);
        book.uploadedAt = Date.now();
        book.size = file.size;
        book.origin = 'Upload local';
        computeBookStats(book);
        state.loadedFiles.push(book);
        loadedNow.push(book);
        ldUploadStep(i, 100, `${fmtInt(book.stats.records)} documentos reconhecidos`, 'done');
        // Render incremental: cada LA aparece assim que termina, sem esperar as demais.
        state.loadedRecords = state.loadedFiles.flatMap(f=>f.records);
        renderLDPanel();
        await yieldUI();
      }
      state.modelDirty = true;
      ensureModel();
      renderLDPanel();
      showLDSuccess(loadedNow);

      const msgs = [`${loadedNow.length} ${loadedNow.length===1?'LD carregada':'LDs carregadas'} com sucesso`];
      if(duplicates.length) msgs.push(`${duplicates.length} duplicada(s) ignorada(s)`);
      if(rejected) msgs.push(`${rejected} arquivo(s) fora do formato ignorado(s)`);
      toast(msgs.join(' · ') + '.');
    } catch(e) {
      console.error(e);
      failed = e;
      const i = loadedNow.length;
      ldUploadStep(i, 100, 'Falha: ' + e.message, 'error');
      // Mantém as LDs já lidas com sucesso; apenas a que falhou é descartada.
      state.loadedRecords = state.loadedFiles.flatMap(f=>f.records);
      state.modelDirty = true;
      ensureModel();
      renderLDPanel();
      toast('Não foi possível ler uma das LDs: ' + e.message, 'error');
    } finally {
      state.ldBusy = false;
      ldUploadEnd(failed ? 9000 : 1600);
    }
  }

  async function reloadLDFiles() {
    if(state.ldBusy){ toast('Aguarde o carregamento em andamento.','error'); return; }
    const books = state.loadedFiles.slice();
    if(!books.length){ toast('Nenhuma LD carregada para atualizar.','error'); return; }

    state.ldBusy = true;
    ldUploadStart(books.map(b=>({name:b.name,size:b.size})));
    const rebuilt = [];
    try {
      for(let i=0;i<books.length;i++){
        const old = books[i];
        ldUploadStep(i, 10, 'Relendo arquivo…', 'active');
        await yieldUI();
        const book = await parseWorkbook(old.file);
        ldUploadStep(i, 50, 'Indexando documentos…', 'active');
        await yieldUI();
        await extractLDRecords(book);
        book.uploadedAt = Date.now();
        book.size = old.file.size;
        book.origin = old.origin || 'Upload local';
        computeBookStats(book);
        rebuilt.push(book);
        ldUploadStep(i, 100, `${fmtInt(book.stats.records)} documentos reconhecidos`, 'done');
      }
      state.loadedFiles = rebuilt;
      state.loadedRecords = rebuilt.flatMap(f=>f.records);
      state.modelDirty = true;
      ensureModel();
      renderLDPanel();
      toast(`${rebuilt.length} ${rebuilt.length===1?'LD atualizada':'LDs atualizadas'} a partir do arquivo original.`);
    } catch(e) {
      console.error(e);
      ldUploadStep(rebuilt.length, 100, 'Falha: ' + e.message, 'error');
      toast('Não foi possível reler as LDs: ' + e.message + ' Carregue os arquivos novamente.', 'error');
    } finally {
      state.ldBusy = false;
      ldUploadEnd(1600);
    }
  }

  function resolveInput(code) {
    const records=findRecordsForCode(code); if(!records.length)return null;
    const loaded=records.filter(r=>r.loaded); const primary=loaded[0]||records[0];
    // Merge missing descriptive fields from any reference record of same code.
    const rich=records.find(r=>r.title)||primary;
    return {...primary,title:primary.title||rich.title||'',disciplineText:primary.disciplineText||rich.disciplineText||'',matches:loaded,allMatches:records};
  }

  async function analyze() {
    const codes=parseCodes(); if(!codes.length){toast('Cole ao menos um código de documento.','error');return;}
    setBusy(true,`Analisando ${codes.length} código${codes.length!==1?'s':''}…`);
    window._uiProgress?.show(`Preparando modelo para ${codes.length} documentos…`);
    try {
      ensureModel();
      // Zera apenas o pool de sequenciais (barato) em vez de reconstruir todo o modelo.
      state.model.used = buildSequencePool(state.model.ex);
      const cache=new Map(), out=[];
      for(let i=0;i<codes.length;i++) {
        if(i%10===0){await yieldUI();window._uiProgress?.set(Math.round(i/codes.length*95),`Analisando ${i+1} de ${codes.length}…`);}
        const raw=codes[i], rec=resolveInput(raw);
        if(!rec){out.push({input:raw,code:normCode(raw)||raw,found:false,taxonomy:'',confidence:0,criterion:'Código não localizado nas LDs carregadas nem nas referências incorporadas.',status:'Não encontrado',matches:[],selected:false});continue;}
        const inf=inferTaxonomy(rec,cache); const loadedMatches=rec.matches||[];
        const loadedCurrent=loadedMatches.find(r=>validTax(r.taxonomy))?.taxonomy||'';
        const current=loadedCurrent||rec.taxonomy||'';
        const emptyLoaded=loadedMatches.filter(r=>!String(r.taxonomy||'').trim());
        const invalidLoaded=loadedMatches.filter(r=>String(r.taxonomy||'').trim()&&!validTax(r.taxonomy));
        const currentDiff=validTax(current)&&current!==inf.taxonomy;
        let status='Somente referência';
        if(loadedMatches.length){
          if(emptyLoaded.length===loadedMatches.length) status='Taxonomia em branco';
          else if(emptyLoaded.length) status=`Parcialmente em branco (${emptyLoaded.length}/${loadedMatches.length})`;
          else if(invalidLoaded.length) status='Taxonomia preenchida, porém inválida';
          else status='Taxonomia preenchida';
        }
        const criterionPrefix=emptyLoaded.length ? (emptyLoaded.length===loadedMatches.length?'Taxonomia em branco detectada automaticamente. ':'Há ocorrência com Taxonomia em branco. ') : '';
        out.push({
          input:raw, code:rec.code, found:true, title:rec.title||'', disciplineText:rec.disciplineText||'', current,
          taxonomy:inf.taxonomy, confidence:inf.confidence, criterion:criterionPrefix+inf.criterion, mode:inf.mode, status, details:inf.details||null, baseValidation:inf.baseValidation||'', requiresReview:!!inf.requiresReview,
          emptyCount:emptyLoaded.length, invalidCount:invalidLoaded.length,
          matches:loadedMatches, seqExhausted:inf.seqExhausted||'', fields:rec.fields||null, origin:loadedMatches.length?`${new Set(loadedMatches.map(r=>r.sourceLD)).size} LD(s) carregada(s)`:`${rec.sourceLD||'Referência'} · ${rec.sheet||''}`,
          selected:loadedMatches.length>0 && emptyLoaded.length>0 && validTax(inf.taxonomy) && !currentDiff && !inf.requiresReview,
          writable:loadedMatches.length>0
        });
      }
      state.results=out;
      window._uiProgress?.set(100,'Concluído!');
      // renderResults() publica tax:results; a camada de apresentação
      // reage ao evento — não há mais hook manual a esquecer.
      renderResults();
      emitSelection();

      // Prefixos que esgotaram os 9999 sequenciais do padrão: a análise
      // continua e as linhas afetadas ficam para revisão manual, mas o
      // usuário precisa saber por que vieram sem sugestão.
      const exhausted=[...new Set(out.map(r=>r.seqExhausted).filter(Boolean))];
      if(exhausted.length){
        const n=out.filter(r=>r.seqExhausted).length;
        toast(`${n} documento(s) sem sugestão: o prefixo ${exhausted[0]}${exhausted.length>1?` (e mais ${exhausted.length-1})`:''} já usa os ${SEQ_MAX} sequenciais do padrão de 4 dígitos.`,'error');
      }
    } catch(e){console.error(e);toast('Erro durante a análise: '+e.message,'error');window._uiProgress?.hide();}
    finally{setBusy(false)}
  }

  function renderResults() {
    const rs=state.results; els.resultsPanel.classList.remove('hidden');
    const found=rs.filter(r=>r.found).length, writable=rs.filter(r=>r.selected).length, missing=rs.length-found, blanks=rs.filter(r=>r.emptyCount>0).length;
    els.resultsSummary.textContent=`${rs.length} analisados · ${found} localizados${blanks?` · ${blanks} com Taxonomia em branco`:''} · ${writable} prontos para preencher${missing?` · ${missing} não encontrados`:''}.`;

    function statusBadge(r) {
      if(!r.found) return `<span class="status-badge status-badge--notfound">Não encontrado</span>`;
      const s=r.status||'';
      if(s.includes('em branco')||s.includes('Taxonomia em branco')) return `<span class="status-badge status-badge--blank">Em branco</span>`;
      if(s.includes('Parcialmente')) return `<span class="status-badge status-badge--partial">${escapeHtml(s)}</span>`;
      if(s.includes('inválida')) return `<span class="status-badge status-badge--invalid">Inválida</span>`;
      if(s.includes('preenchida')) return `<span class="status-badge status-badge--filled">Preenchida</span>`;
      return `<span class="status-badge status-badge--ref">${escapeHtml(s||'Referência')}</span>`;
    }

    els.resultsBody.innerHTML=rs.map((r,i)=>{
      const rowCls=[r.found?'':'not-found', r.requiresReview?'row-requires-review':'', (r.found&&r.confidence>0&&r.confidence<70)?'row-review':''].filter(Boolean).join(' ');
      return `<tr class="${rowCls}" data-index="${i}">
        <td class="col-check"><input class="row-check" type="checkbox" aria-label="Selecionar ${escapeHtml(r.code)} para aplicação" ${r.selected?'checked':''} ${!r.writable||!validTax(r.taxonomy)?'disabled':''}></td>
        <td class="col-code"><strong class="doc-code">${escapeHtml(r.code)}</strong></td>
        <td class="col-title"><div class="title-cell"><strong>${escapeHtml(r.title||'—')}</strong><span>${escapeHtml(r.disciplineText||'')}</span></div></td>
        <td class="col-status">${statusBadge(r)}</td>
        <td class="col-current"><div class="current-stack">${r.current?`<span class="tax-current">${escapeHtml(r.current)}</span>`:''}${r.emptyCount>0?`<span class="blank-badge">Em branco${r.matches?.length>1?` · ${r.emptyCount}/${r.matches.length}`:''}</span>`:(!r.current?'<span class="tax-current empty">Vazio</span>':'')}</div></td>
        <td class="col-suggested">${r.found?`<input class="tax-input" value="${escapeHtml(r.taxonomy)}" spellcheck="false" aria-label="Taxonomia sugerida para ${escapeHtml(r.code)}" ${!r.taxonomy?'placeholder="Revisão necessária"':''}>`:'—'}</td>
        <td class="col-confidence">
          <div class="conf-bar cb--${confBarClass(r.confidence)}">
            <div class="conf-bar-top"><span class="conf-val">${r.confidence}%</span><span class="conf-lbl">${confBarLabel(r.confidence)}</span></div>
            <div class="conf-track"><div class="conf-track-fill" style="width:${r.confidence}%"></div></div>
          </div>
        </td>
        <td class="col-origin"><span class="origin-badge ${r.writable?'loaded':'reference'}">${escapeHtml(r.found?r.origin:'Não encontrado')}</span></td>
        <td class="col-criterion"><div class="criteria">${escapeHtml(r.criterion)}</div></td>
        <td class="col-action"><button type="button" class="btn-evidence" data-evidence="${i}" aria-label="Ver evidências de ${escapeHtml(r.code)}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Ver</button></td>
      </tr>`;
    }).join('');

    // Sem listeners por linha: a delegação é registrada uma única vez em bind().
    emitResults();
  }

  /* Projeção enxuta do estado para a camada de apresentação.
     ui.js passa a filtrar/ordenar/contar a partir DESTES dados, e não
     mais relendo o DOM — o que antes dessincronizava a cada re-render. */
  function emitResults() {
    emit('tax:results', {
      rows: state.results.map((r,i)=>({
        i, code:r.code, title:r.title||'', disciplineText:r.disciplineText||'',
        status:r.status||'', found:!!r.found, current:r.current||'', taxonomy:r.taxonomy||'',
        confidence:r.confidence||0, criterion:r.criterion||'', origin:r.origin||'',
        selected:!!r.selected, writable:!!r.writable, emptyCount:r.emptyCount||0,
        invalidCount:r.invalidCount||0, requiresReview:!!r.requiresReview,
        matches:(r.matches||[]).length, details:r.details||null, baseValidation:r.baseValidation||'',
        fields:r.fields||null,
        // Índice de busca pré-calculado: evita ler textContent de cada <tr>
        // a cada tecla digitada no campo de pesquisa.
        search:`${r.code} ${r.title||''} ${r.disciplineText||''} ${r.taxonomy||''} ${r.current||''} ${r.status||''} ${r.origin||''}`.toLowerCase()
      }))
    });
  }

  function emitSelection() {
    emit('tax:selection', {
      selected: state.results.filter(r=>r.selected).length,
      total: state.results.length
    });
  }

  function confBarClass(n){ return n>=95?'green':n>=85?'blue':n>=70?'yellow':'red'; }
  function confBarLabel(n){ return n>=95?'Alta':n>=85?'Boa':n>=70?'Média':'Baixa'; }

  function selectApplicable(){for(const r of state.results)r.selected=!!(r.writable&&r.emptyCount>0&&validTax(r.taxonomy)&&!r.requiresReview);renderResults()}
  function analyzeBlankTaxonomies(){
    if(!state.loadedRecords.length){toast('Carregue ao menos uma LD para detectar Taxonomias em branco.','error');return;}
    const codes=[...new Set(state.loadedRecords.filter(r=>!String(r.taxonomy||'').trim()).map(r=>normCode(r.code)).filter(Boolean))];
    if(!codes.length){toast('Nenhuma Taxonomia em branco foi encontrada nas LDs carregadas.');return;}
    els.codesInput.value=codes.join('\n');refreshCodeCount();toast(`${codes.length} documentos com Taxonomia em branco detectados.`);analyze();
  }
  function relationText() {return state.results.filter(r=>r.found&&r.taxonomy).map(r=>`${r.code}\t${r.taxonomy}\t${r.confidence}%`).join('\n')}
  async function copyRelation(){const t=relationText();if(!t){toast('Nenhuma taxonomia para copiar.','error');return}try{await navigator.clipboard.writeText(t);toast('Relação copiada para a área de transferência.')}catch{fallbackCopy(t)}}
  function fallbackCopy(t){const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();toast('Relação copiada.')}
  function base64ToBytes(b64){
    const bin=atob(b64),out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
    return out;
  }
  function templateTextCell(doc,row,ref,value,style){
    const c=doc.createElementNS(NS_MAIN,'x:c');
    c.setAttribute('r',ref); if(style!==undefined&&style!==null)c.setAttribute('s',String(style));
    const text=String(value??'');
    if(text!==''){
      c.setAttribute('t','str');
      const v=doc.createElementNS(NS_MAIN,'x:v'); v.textContent=text; c.appendChild(v);
    }
    row.appendChild(c); return c;
  }
  function replaceTemplateCellText(doc,ref,value){
    const cell=localNodes(doc,'c').find(c=>c.getAttribute('r')===ref); if(!cell)return;
    while(cell.firstChild)cell.removeChild(cell.firstChild);
    cell.setAttribute('t','str');
    const v=doc.createElementNS(NS_MAIN,'x:v');v.textContent=String(value??'');cell.appendChild(v);
  }
  async function makeRelationXlsx(){
    const rs=state.results;if(!rs.length)throw new Error('Nenhum resultado disponível para exportação.');
    const b64=globalThis.TAXONOMIA_CONSAG_REPORT_TEMPLATE_B64;
    if(!b64)throw new Error('Modelo interno do relatório não foi carregado.');
    const raw=base64ToBytes(b64);
    const ab=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
    const zip=new ZipArchive(ab,'Taxonomia_Consag_Relacao.xlsx');
    const path='xl/worksheets/sheet1.xml';
    const doc=parseXml(await zip.text(path));
    const sheetData=localNodes(doc,'sheetData')[0];
    if(!sheetData)throw new Error('Modelo do relatório inválido: dados da planilha não encontrados.');

    const now=new Date(),stamp=now.toLocaleString('pt-BR');
    replaceTemplateCellText(doc,'A2',`${rs.length} documentos analisados · exportado em ${stamp} · base: ${state.customBase?.fileName||state.data.sourceFile||'CONSAG'}`);

    const templateRow=Array.from(sheetData.children).find(row=>Number(row.getAttribute('r')||0)===5);
    const styleByCol={};
    if(templateRow){for(const c of localNodes(templateRow,'c'))styleByCol[colLetters(c.getAttribute('r'))]=c.getAttribute('s')||null;}
    for(const row of Array.from(sheetData.children)){
      if(Number(row.getAttribute('r')||0)>=5)row.remove();
    }
    const fieldText=(d,key)=>d?.[key]?`${d[key].code} — ${d[key].description}`:'';
    const cols='ABCDEFGHIJKLMNOPQR'.split('');
    rs.forEach((r,idx)=>{
      const rn=idx+5,status=r.status||(r.found?'Localizado':'Não encontrado');
      const details=validTax(r.taxonomy)?(r.details||describeTaxonomy(r.taxonomy)):null;
      const values=[
        r.code||r.input||'', r.title||'', r.disciplineText||'', status,
        r.current||'Vazio', r.taxonomy||'Revisão necessária', `${Number(r.confidence||0)}%`,
        r.origin||'Não encontrado', r.criterion||'', fieldText(details,'project'),
        fieldText(details,'type'), fieldText(details,'sector'), fieldText(details,'stage'),
        fieldText(details,'front'), fieldText(details,'discipline'), fieldText(details,'language'),
        fieldText(details,'sequence'), r.baseValidation||''
      ];
      const row=doc.createElementNS(NS_MAIN,'x:row'); row.setAttribute('r',String(rn));row.setAttribute('ht','46');row.setAttribute('customHeight','1');
      values.forEach((v,i)=>templateTextCell(doc,row,`${cols[i]}${rn}`,v,styleByCol[cols[i]]));
      sheetData.appendChild(row);
    });

    const last=Math.max(4,rs.length+4);
    const existingFilter=localNodes(doc,'autoFilter')[0]; if(existingFilter)existingFilter.remove();
    const filter=doc.createElementNS(NS_MAIN,'x:autoFilter'); filter.setAttribute('ref',`A4:R${last}`);
    const merge=localNodes(doc,'mergeCells')[0],margins=localNodes(doc,'pageMargins')[0];
    if(merge)merge.parentNode.insertBefore(filter,merge); else if(margins)margins.parentNode.insertBefore(filter,margins); else doc.documentElement.appendChild(filter);

    zip.replaceText(path,new XMLSerializer().serializeToString(doc));
    return await zip.build();
  }
  async function exportXLSX(){
    try{
      const bytes=await makeRelationXlsx();
      downloadBlob(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'Taxonomia_Consag_Relacao.xlsx');
      toast('Relação exportada em Excel (.xlsx) com estrutura validada.');
    }catch(e){console.error(e);toast('Falha ao exportar a relação: '+e.message,'error');}
  }

  function ensureCell(doc,row,col,rowNum) {
    const ref=col+rowNum; let existing=localNodes(row,'c').find(c=>c.getAttribute('r')===ref); if(existing)return existing;
    const c=doc.createElementNS(NS_MAIN,'c');c.setAttribute('r',ref);
    const target=colNum(col); let inserted=false;
    for(const other of localNodes(row,'c')){if(colNum(colLetters(other.getAttribute('r')))>target){row.insertBefore(c,other);inserted=true;break}}
    if(!inserted)row.appendChild(c); return c;
  }
  function setInlineCell(doc,cell,value) {
    const style=cell.getAttribute('s'); while(cell.firstChild)cell.removeChild(cell.firstChild); cell.setAttribute('t','inlineStr'); if(style)cell.setAttribute('s',style);
    const is=doc.createElementNS(NS_MAIN,'is'),t=doc.createElementNS(NS_MAIN,'t');t.textContent=value;is.appendChild(t);cell.appendChild(is);
  }

  async function applyAndDownload() {
    const selected=state.results.filter(r=>r.selected&&r.writable&&validTax(r.taxonomy)); if(!selected.length){toast('Selecione ao menos uma taxonomia aplicável às LDs carregadas.','error');return;}
    setBusy(true,'Aplicando taxonomias e preservando as planilhas…');
    try {
      const ops=new Map(), applied=[];
      for(const r of selected) for(const m of r.matches) {
        // Preencha somente células realmente vazias. Qualquer valor já existente é protegido.
        const existing=String(m.taxonomy||'').trim().toUpperCase();
        if(existing && existing!==r.taxonomy) continue;
        const key=`${m.fileId}|${m.sheetPath}`; if(!ops.has(key))ops.set(key,[]); ops.get(key).push({row:m.row,col:m.taxCol,tax:r.taxonomy});
        applied.push({rec:m,tax:r.taxonomy});
      }
      if(!ops.size){toast('Nenhuma célula vazia elegível para preenchimento.','error');return;}
      for(const [key,arr] of ops) {
        const [fileId,sheetPath]=key.split('|'); const book=state.loadedFiles.find(f=>f.id===fileId); if(!book)continue;
        const doc=parseXml(await book.zip.text(sheetPath)); const byRow=new Map(localNodes(doc,'row').map(r=>[Number(r.getAttribute('r')),r]));
        for(const op of arr){const row=byRow.get(op.row);if(!row)continue;const cell=ensureCell(doc,row,op.col,op.row);setInlineCell(doc,cell,op.tax);}
        book.zip.replaceText(sheetPath,new XMLSerializer().serializeToString(doc));
      }
      const outputs=[];
      for(const book of state.loadedFiles){if([...ops.keys()].some(k=>k.startsWith(book.id+'|'))){await yieldUI();const bytes=await book.zip.build();const ext=(book.name.match(/\.(xlsx|xlsm)$/i)||['.xlsx'])[0];const base=book.name.slice(0,-ext.length);outputs.push({name:`${base}_TAXONOMIA${ext}`,bytes});}}
      if(outputs.length===1) downloadBlob(new Blob([outputs[0].bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),outputs[0].name);
      else {const zipBytes=buildStoredZip(outputs);downloadBlob(new Blob([zipBytes],{type:'application/zip'}),'Taxonomia_Consag_LDs_atualizadas.zip');}
      // Reflete a gravação no estado em memória: o painel de LDs, as
      // estatísticas e uma nova análise passam a ver as células já preenchidas.
      for(const a of applied){ const src=a.rec._src||a.rec; src.taxonomy=a.tax; a.rec.taxonomy=a.tax; }
      for(const book of state.loadedFiles) computeBookStats(book);
      state.modelDirty = true;
      renderLDPanel();
      toast(`${outputs.length} ${outputs.length===1?'LD atualizada':'LDs atualizadas'} com sucesso.`);
    } catch(e){console.error(e);toast('Falha ao gerar a LD atualizada: '+e.message,'error');}
    finally{setBusy(false)}
  }

  function buildStoredZip(files) {
    const local=[],central=[],offsets=[];let offset=0;
    for(const f of files){const nb=encoder.encode(f.name),data=f.bytes instanceof Uint8Array?f.bytes:new Uint8Array(f.bytes),crc=crc32(data),h=[];offsets.push(offset);pushU32(h,0x04034b50);pushU16(h,20);pushU16(h,0);pushU16(h,0);pushU16(h,0);pushU16(h,0);pushU32(h,crc);pushU32(h,data.length);pushU32(h,data.length);pushU16(h,nb.length);pushU16(h,0);const hb=new Uint8Array(h.length+nb.length);hb.set(h);hb.set(nb,h.length);local.push(hb,data);offset+=hb.length+data.length;}
    const cdOffset=offset;
    files.forEach((f,i)=>{const nb=encoder.encode(f.name),data=f.bytes instanceof Uint8Array?f.bytes:new Uint8Array(f.bytes),crc=crc32(data),h=[];pushU32(h,0x02014b50);pushU16(h,20);pushU16(h,20);pushU16(h,0);pushU16(h,0);pushU16(h,0);pushU16(h,0);pushU32(h,crc);pushU32(h,data.length);pushU32(h,data.length);pushU16(h,nb.length);pushU16(h,0);pushU16(h,0);pushU16(h,0);pushU16(h,0);pushU32(h,0);pushU32(h,offsets[i]);const hb=new Uint8Array(h.length+nb.length);hb.set(h);hb.set(nb,h.length);central.push(hb);offset+=hb.length});
    const end=[];pushU32(end,0x06054b50);pushU16(end,0);pushU16(end,0);pushU16(end,files.length);pushU16(end,files.length);pushU32(end,offset-cdOffset);pushU32(end,cdOffset);pushU16(end,0);return concatBytes([...local,...central,new Uint8Array(end)]);
  }
  function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}

  // ---------- Updateable CONSAG base ----------
  async function parseBaseWorkbook(file) {
    const book=await parseWorkbook(file), result={fileName:file.name,documentTypes:[],projects:[],sectors:[],stages:[],fronts:[],disciplines:[],languages:[],allowedSectorNamesByType:{},updatedAt:new Date().toISOString()};
    const typeSheet=book.sheets.find(s=>normText(s.name)==='TIPO DE DOCUMENTO');
    if(typeSheet){const doc=parseXml(await book.zip.text(typeSheet.path));const seen=new Set();for(const row of localNodes(doc,'row')){const vals=rowValues(row,book.shared),code=String(vals.get('B')||'').trim().toUpperCase(),desc=String(vals.get('C')||'').trim();if(/^[A-Z0-9]{2,5}$/.test(code)&&desc&&!seen.has(code)){seen.add(code);result.documentTypes.push({code,description:desc})}}}
    const taxSheet=book.sheets.find(s=>normText(s.name)==='TAXONOMIA');
    if(taxSheet){
      const doc=parseXml(await book.zip.text(taxSheet.path));
      const maps={projects:new Map(),sectors:new Map(),stages:new Map(),fronts:new Map(),disciplines:new Map(),languages:new Map()};
      const put=(map,code,description,re)=>{code=String(code||'').trim().toUpperCase();description=String(description||'').trim();if(re.test(code)&&description&&!['EXEMPLOS','CODIGO','SIGLA'].includes(normText(code)))map.set(code,{code,description})};
      for(const row of localNodes(doc,'row')){const v=rowValues(row,book.shared);put(maps.projects,v.get('D'),v.get('E'),/^[A-Z0-9]{2,8}$/);put(maps.sectors,v.get('J'),v.get('K'),/^[A-Z0-9]{2,5}$/);put(maps.stages,v.get('M'),v.get('N'),/^[A-Z0-9]{2,4}$/);put(maps.fronts,v.get('P'),v.get('Q'),/^[A-Z0-9]{2,6}$/);put(maps.disciplines,v.get('S'),v.get('T'),/^[A-Z0-9]{2,5}$/);put(maps.languages,v.get('V'),v.get('W'),/^[A-Z0-9]{2,3}$/)}
      for(const k of Object.keys(maps))result[k]=[...maps[k].values()];
    }
    const matrixSheet=book.sheets.find(s=>normText(s.name)==='TIPO DE DOCUMENTO POR SETOR');
    if(matrixSheet){
      const doc=parseXml(await book.zip.text(matrixSheet.path)),rows=localNodes(doc,'row'),headerRow=rows.find(r=>Number(r.getAttribute('r'))===3); const headers=headerRow?rowValues(headerRow,book.shared):new Map();
      for(const row of rows){const rn=Number(row.getAttribute('r')||0);if(rn<=3)continue;const v=rowValues(row,book.shared),type=String(v.get('A')||'').trim().toUpperCase();if(!/^[A-Z0-9]{2,5}$/.test(type))continue;const allowed=[];for(const [col,name] of headers){if(colNum(col)<=2)continue;const mark=normText(v.get(col)||'');if(mark==='X'&&String(name||'').trim())allowed.push(String(name).trim())}if(allowed.length)result.allowedSectorNamesByType[type]=allowed}
    }
    if(!result.documentTypes.length)throw new Error('A aba “TIPO DE DOCUMENTO” não foi reconhecida.');
    for(const k of ['projects','sectors','stages','fronts','disciplines','languages'])if(!result[k].length)result[k]=state.data[k]||[];
    if(!Object.keys(result.allowedSectorNamesByType).length)result.allowedSectorNamesByType=state.data.allowedSectorNamesByType||{};
    return result;
  }
  async function updateBase(file) {
    if(!file)return;setBusy(true,'Lendo nova base CONSAG…');
    try{const b=await parseBaseWorkbook(file);state.customBase=b;try{localStorage.setItem('taxonomiaConsag.customBase',JSON.stringify(b))}catch{}state.modelDirty=true;ensureModel();refreshStats();toast('Nova base CONSAG ativada localmente.');}
    catch(e){console.error(e);toast('Não foi possível reconhecer a nova base: '+e.message,'error');}
    finally{setBusy(false);els.baseFile.value=''}
  }
  function loadCustomBase(){try{const raw=localStorage.getItem('taxonomiaConsag.customBase');if(raw)state.customBase=JSON.parse(raw)}catch{state.customBase=null}}

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function bind() {
    els.codesInput.addEventListener('input',refreshCodeCount); els.clearCodes.onclick=()=>{els.codesInput.value='';refreshCodeCount();els.codesInput.focus()}; els.analyzeBtn.onclick=analyze;
    els.ldFiles.onchange=e=>{loadLDFiles(e.target.files);e.target.value=''};

    // Contador de dragenter/dragleave: sem ele, arrastar sobre um filho do
    // dropzone dispara dragleave e a moldura pisca.
    let dragDepth = 0;
    els.ldDrop.addEventListener('dragenter', e => { e.preventDefault(); if(++dragDepth===1) els.ldDrop.classList.add('drag'); });
    els.ldDrop.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect='copy'; });
    els.ldDrop.addEventListener('dragleave', e => { e.preventDefault(); if(--dragDepth<=0){ dragDepth=0; els.ldDrop.classList.remove('drag'); } });
    els.ldDrop.addEventListener('drop', e => { e.preventDefault(); dragDepth=0; els.ldDrop.classList.remove('drag'); loadLDFiles(e.dataTransfer.files); });

    // ── Painel de LDs: delegação única, sobrevive a qualquer re-render ──
    els.ldList.addEventListener('click', e => {
      const rm = e.target.closest('[data-remove]');
      if(rm){ removeLD(rm.dataset.remove); return; }
      const act = e.target.closest('[data-ld-action]');
      if(!act) return;
      if(act.dataset.ldAction === 'pick') els.ldFiles.click();
      if(act.dataset.ldAction === 'clear-search'){ state.ldQuery=''; if(els.ldSearch) els.ldSearch.value=''; renderLDPanel(); }
    });
    els.ldSuccess?.addEventListener('click', e => {
      if(e.target.closest('[data-ld-action="dismiss-success"]')) els.ldSuccess.hidden = true;
    });
    els.ldSearch?.addEventListener('input', debounce(e => { state.ldQuery = e.target.value; renderLDPanel(); }, 120));
    els.ldSort?.addEventListener('change', e => { state.ldSort = e.target.value; renderLDPanel(); });
    els.ldRefresh?.addEventListener('click', reloadLDFiles);
    els.ldClearAll?.addEventListener('click', clearAllLDs);

    // ── Tabela de resultados: delegação única em vez de 2 listeners por linha ──
    els.resultsBody.addEventListener('change', e => {
      const chk = e.target.closest('.row-check'); if(!chk) return;
      const r = state.results[Number(chk.closest('tr')?.dataset.index)]; if(!r) return;
      r.selected = chk.checked; emitSelection();
    });
    els.resultsBody.addEventListener('input', e => {
      const inp = e.target.closest('.tax-input'); if(!inp) return;
      const tr = inp.closest('tr'); const r = state.results[Number(tr?.dataset.index)]; if(!r) return;
      r.taxonomy = inp.value.trim().toUpperCase(); inp.value = r.taxonomy;
      const ok = validTax(r.taxonomy);
      inp.classList.toggle('invalid', !ok);
      inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
      const chk = tr.querySelector('.row-check');
      if(chk){ chk.disabled = !r.writable || !ok; if(!ok){ chk.checked=false; r.selected=false; } }
      emitSelection();
    });
    els.resultsBody.addEventListener('click', e => {
      const btn = e.target.closest('[data-evidence]'); if(!btn) return;
      window._uiEvidence?.(Number(btn.dataset.evidence));
    });

    els.selectAllBtn.onclick=selectApplicable;els.copyBtn.onclick=copyRelation;els.xlsxBtn.onclick=exportXLSX;els.applyBtn.onclick=applyAndDownload;els.blankAnalyzeBtn.onclick=analyzeBlankTaxonomies;els.baseFile.onchange=e=>updateBase(e.target.files[0]);
  }

  function init() {
    loadCustomBase(); ensureModel(); refreshStats(); refreshCodeCount(); bind(); renderLDPanel();
    emitResults(); emitSelection();
    console.info(`[Taxonomia Consag] ${state.data.examples?.length||0} exemplos e ${state.data.referenceRecords?.length||0} documentos de referência carregados.`);
  }
  init();
})();
