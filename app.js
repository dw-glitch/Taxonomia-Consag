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
    customBase: null,
    busyDepth: 0
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    statTypes: $('statTypes'), statExamples: $('statExamples'), statRefs: $('statRefs'),
    ldDrop: $('ldDrop'), ldFiles: $('ldFiles'), ldList: $('ldList'), blankAnalyzeBtn: $('blankAnalyzeBtn'),
    codesInput: $('codesInput'), clearCodes: $('clearCodes'), codeCount: $('codeCount'), analyzeBtn: $('analyzeBtn'),
    resultsPanel: $('resultsPanel'), resultsSummary: $('resultsSummary'), resultsBody: $('resultsBody'),
    selectAllBtn: $('selectAllBtn'), copyBtn: $('copyBtn'), xlsxBtn: $('xlsxBtn'), applyBtn: $('applyBtn'),
    baseStatus: $('baseStatus'), baseFile: $('baseFile'), toast: $('toast'), busy: $('busy'), busyText: $('busyText')
  };

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  }

  function normText(v) {
    return String(v ?? '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function normCode(v) {
    let s = String(v ?? '').trim().replace(/^['"]|['"]$/g, '');
    s = s.split(/[\r\n\t]/)[0].trim();
    s = s.replace(/^.*[\\/]/, '').replace(/\.(XLSX|XLSM|PDF|DOCX?|ZIP)$/i, '');
    s = s.replace(/\s+\/\s+.*$/, '').trim();
    s = s.replace(/_\d{4}_.+$/i, '').replace(/_\d{4}$/i, '');
    const pattern = /(?:[A-Z]{1,8}-)?\d{4}\.\d{2}-\d{5}-[A-Z0-9]{2,5}-[A-Z0-9]{3}-\d{3}/i;
    const m = s.match(pattern);
    if (m) s = m[0];
    return s.toUpperCase().replace(/\s+/g, '');
  }

  function compactCode(v) { return normCode(v).replace(/[^A-Z0-9]/g, ''); }
  function docFamily(code) { return (normCode(code).split('-')[0] || '').replace(/[^A-Z]/g, ''); }
  function codeSeriesKey(code) { const c=normCode(code); if(/-\d{3}$/.test(c))return c.replace(/-\d{3}$/,''); const i=c.indexOf('_RIR'); if(i>0)return c.slice(0,i+4); return ''; }

  const STOP = new Set('DE DA DO DAS DOS E EM PARA POR COM SEM A O AS OS UM UMA NO NA NOS NAS AO AOS AREA UNIDADE DOCUMENTO DOCUMENTACAO PROJETO CONSAG PETROBRAS RNEST UHDTD U'.split(' '));
  function tokens(v) {
    return normText(v).split(' ').filter(x => x.length >= 2 && !STOP.has(x));
  }
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
  const HEADER_DISC = ['DISCIPLINA','DISCIPLINA DO DOCUMENTO','SETOR EMISSOR','EMISSOR','SETOR'];
  function findHeader(rows,shared) {
    let best=null;
    for(const row of rows.slice(0,80)) {
      const vals=rowValues(row,shared), norm=new Map([...vals].map(([k,v])=>[k,normText(v)]));
      let taxCol='', codeCol='', titleCol='', discCol='';
      for(const [c,v] of norm) {
        if(v==='TAXONOMIA'||v.includes('TAXONOMIA')) taxCol=c;
        if(!codeCol && HEADER_CODE.map(normText).includes(v)) codeCol=c;
        if(!titleCol && HEADER_TITLE.map(normText).includes(v)) titleCol=c;
        if(!discCol && HEADER_DISC.map(normText).includes(v)) discCol=c;
      }
      if(taxCol) {
        const score=(codeCol?4:0)+(titleCol?2:0)+(discCol?1:0);
        if(!best||score>best.score) best={row:Number(row.getAttribute('r')||0),taxCol,codeCol,titleCol,discCol,score};
      }
    }
    return best;
  }
  function looksLikeDocCode(v){ const s=normCode(v); return /\d{4}\.\d{2}-\d{5}-/.test(s)&&/-\d{3}$/.test(s); }

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
        const rec={
          code:normCode(rawCode), rawCode:String(rawCode).trim(), title:head.titleCol?String(vals.get(head.titleCol)||'').trim():'',
          disciplineText:head.discCol?String(vals.get(head.discCol)||'').trim():'', taxonomy:String(vals.get(head.taxCol)||'').trim().toUpperCase(),
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

  function modeStats(values) {
    const m=new Map(); for(const v of values){if(v)m.set(v,(m.get(v)||0)+1)}
    const sorted=[...m].sort((a,b)=>b[1]-a[1]); const total=sorted.reduce((n,x)=>n+x[1],0);
    return {value:sorted[0]?.[0]||'',count:sorted[0]?.[1]||0,total,share:total?((sorted[0]?.[1]||0)/total):0,all:sorted};
  }
  function profileAdd(map,key,val){if(!key||!val)return;if(!map.has(key))map.set(key,[]);map.get(key).push(val)}
  function dictFrom(items){return new Map((items||[]).map(x=>[String(x.code||'').toUpperCase(),x]))}
  function descriptionTokens(v){return tokens(v).filter(x=>x.length>=3)}
  function phraseScore(text, description) {
    const a=normText(text), b=normText(description); if(!a||!b)return 0;
    if(a===b)return 1; if(b.length>=7&&a.includes(b))return 0.99; if(a.length>=10&&b.includes(a))return 0.93;
    const aa=new Set(descriptionTokens(a)),bb=new Set(descriptionTokens(b)); return jaccard(aa,bb);
  }

  function buildModel() {
    const d=state.data, examples=(d.examples||[]).filter(e=>validTax(e.taxonomy));
    const ex=examples.map((e,i)=>{const p=splitTax(e.taxonomy);return {...e,_i:i,_titleNorm:normText(e.title),_discNorm:normText(e.disciplineText),_titleSet:tokenSet(e.title),_discSet:tokenSet(e.disciplineText),_family:docFamily(e.code),_tax:p};});
    const refIndex=new Map(), compactIndex=new Map();
    function addRef(r,loaded=false) {
      const key=normCode(r.code); if(!key)return; const rr={...r,code:key,loaded:loaded||r.loaded};
      if(!refIndex.has(key))refIndex.set(key,[]); refIndex.get(key).push(rr);
      const ck=compactCode(key); if(ck){if(!compactIndex.has(ck))compactIndex.set(ck,[]);compactIndex.get(ck).push(rr)}
    }
    for(const r of d.referenceRecords||[]) addRef(r,false);
    for(const r of state.loadedRecords) addRef(r,true);

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

    const used=new Map();
    for(const e of ex){const p=splitTax(e.taxonomy), key=[p.project,p.type,p.sector,p.stage,p.front,p.discipline,p.language].join('-');if(!used.has(key))used.set(key,new Set());used.get(key).add(Number(p.sequence));}
    for(const r of state.loadedRecords){if(validTax(r.taxonomy)){const p=splitTax(r.taxonomy),key=[p.project,p.type,p.sector,p.stage,p.front,p.discipline,p.language].join('-');if(!used.has(key))used.set(key,new Set());used.get(key).add(Number(p.sequence));}}

    const docTypes=(state.customBase?.documentTypes||d.documentTypes||[]).map(x=>({...x,_set:tokenSet(x.description),_norm:normText(x.description)}));
    const sectorsArr=state.customBase?.sectors||d.sectors||[], disciplinesArr=state.customBase?.disciplines||d.disciplines||[];
    const projectsArr=state.customBase?.projects||d.projects||[], stagesArr=state.customBase?.stages||d.stages||[], frontsArr=state.customBase?.fronts||d.fronts||[], languagesArr=state.customBase?.languages||d.languages||[];
    const allowed=state.customBase?.allowedSectorNamesByType||d.allowedSectorNamesByType||{};
    state.model={ex,refIndex,compactIndex,used,docTypes,sectors:dictFrom(sectorsArr),disciplines:dictFrom(disciplinesArr),projects:dictFrom(projectsArr),stages:dictFrom(stagesArr),fronts:dictFrom(frontsArr),languages:dictFrom(languagesArr),allowed,
      familyProfiles,seriesTypeProfiles,seriesSectorProfiles,seriesDisciplineProfiles,seriesFrontProfiles,seriesExamples,familyExamples,typeSectorProfiles,typeDiscSectorProfiles,comboFrontProfiles,titleExamples,discTextExamples,
      globalProject:modeStats(projectValues),globalStage:modeStats(stageValues),globalFront:modeStats(frontValues),globalLanguage:modeStats(languageValues)};
  }

  function findRecordsForCode(input) {
    const m=state.model, key=normCode(input), ck=compactCode(input); let arr=m.refIndex.get(key)||m.compactIndex.get(ck)||[];
    return [...arr].sort((a,b)=>(b.loaded?1:0)-(a.loaded?1:0));
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
      const ec=compactCode(e.code), codeOverlap=compact&&ec ? (compact.slice(0,-3)===ec.slice(0,-3)?1:(compact.slice(0,12)===ec.slice(0,12)?0.35:0)) : 0;
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
  function sectorAllowedByOfficialMatrix(type,sector) {
    const allowed=state.model.allowed[type]; if(!Array.isArray(allowed)||!allowed.length)return {known:false,allowed:true,category:''};
    const category=SECTOR_CATEGORY_BY_CODE[sector]||''; if(!category)return {known:false,allowed:true,category:''};
    return {known:true,allowed:allowed.some(x=>normText(x)===normText(category)),category};
  }
  function chooseType(rec,near) {
    const series=codeSeriesKey(rec.code), sp=series?state.model.seriesTypeProfiles.get(series):null;
    if(sp&&sp.total>=4&&sp.share>=0.80)return {value:sp.value,quality:98,evidence:`Série documental ${series} usa ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
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
    const exact=(state.model.titleExamples.get(normText(rec.title))||[]).filter(e=>!series||codeSeriesKey(e.code)===series||e._family===docFamily(rec.code));
    if(exact.length){const st=modeStats(exact.map(e=>e._tax.discipline));if(st.share>=0.9)return {value:st.value,quality:95,evidence:`Título equivalente na mesma família/série usa disciplina ${st.value} (${Math.round(st.share*100)}%)`};}
    const v=voteWithDominance(near,'discipline'); if(v.value&&v.share>=0.76&&near[0]?.score>=0.42)return {value:v.value,quality:88,evidence:`Documentos equivalentes convergem para ${v.value} (${Math.round(v.share*100)}%)`};
    const off=officialDisciplineByText(`${rec.disciplineText} ${rec.title}`); if(off.code&&off.score>=0.86)return {value:off.code,quality:84,evidence:`Disciplina explícita na LD/título: ${off.code} — ${off.description}`};
    const sameDisc=state.model.discTextExamples.get(normText(rec.disciplineText))||[]; if(sameDisc.length){const st=modeStats(sameDisc.map(e=>e._tax.discipline));if(st.share>=0.9)return {value:st.value,quality:82,evidence:`Mesma descrição de disciplina em ${st.total} referência(s) (${Math.round(st.share*100)}%)`};}
    return {value:'',quality:0,evidence:'Disciplina sem evidência suficiente na base/LD'};
  }
  function chooseSector(type,discipline,near,rec=null) {
    const series=rec?codeSeriesKey(rec.code):'', sp=series?state.model.seriesSectorProfiles.get(series):null; if(sp&&sp.total>=4&&sp.share>=0.80)return {value:sp.value,quality:98,evidence:`A série ${series} usa o setor ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
    let p=state.model.typeDiscSectorProfiles.get(`${type}|${discipline}`); if(p&&p.total>=3&&p.share>=0.68)return {value:p.value,quality:94,evidence:`Mesmo tipo + disciplina usam ${p.value} em ${Math.round(p.share*100)}% de ${p.total} referências`};
    p=state.model.typeSectorProfiles.get(type); if(p&&p.total>=4&&p.share>=0.78)return {value:p.value,quality:89,evidence:`Tipo ${type} usa ${p.value} em ${Math.round(p.share*100)}% de ${p.total} referências`};
    const v=voteWithDominance(near,'sector'); if(v.value&&v.share>=0.70&&near[0]?.score>=0.32)return {value:v.value,quality:78,evidence:`Consenso do setor em documentos equivalentes (${Math.round(v.share*100)}%)`};
    if(p&&p.value&&p.share>=0.60)return {value:p.value,quality:69,evidence:`Setor mais recorrente para ${type} (${Math.round(p.share*100)}%)`};
    return {value:'',quality:0,evidence:'Setor emissor sem evidência suficiente'};
  }
  function chooseFront(type,sector,discipline,near,rec=null) {
    const series=rec?codeSeriesKey(rec.code):'', sp=series?state.model.seriesFrontProfiles.get(series):null; if(sp&&sp.total>=4&&sp.share>=0.90)return {value:sp.value,quality:98,evidence:`A série ${series} usa a frente ${sp.value} em ${Math.round(sp.share*100)}% de ${sp.total} referências`};
    const p=state.model.comboFrontProfiles.get(`${type}|${sector}|${discipline}`); if(p&&p.total>=2&&p.share>=0.80)return {value:p.value,quality:92,evidence:`Frente predominante para o mesmo tipo/setor/disciplina (${Math.round(p.share*100)}%)`};
    const v=voteWithDominance(near,'front'); if(v.value&&v.share>=0.82)return {value:v.value,quality:82,evidence:`Frente indicada pelas referências mais equivalentes (${Math.round(v.share*100)}%)`};
    const g=state.model.globalFront; if(g.share>=0.95)return {value:g.value,quality:78,evidence:`Frente padrão das LDs de referência (${Math.round(g.share*100)}% de ${g.total})`};
    return {value:'',quality:0,evidence:'Frente/fase sem evidência suficiente'};
  }
  function reserveSequence(prefix) {if(!state.model.used.has(prefix))state.model.used.set(prefix,new Set());const used=state.model.used.get(prefix);let n=used.size?Math.max(...used)+1:1;while(used.has(n)&&n<9999)n++;if(n>9999)throw new Error('Sequencial esgotado para '+prefix);used.add(n);return String(n).padStart(4,'0')}

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

    const project=state.model.globalProject.share>=0.95?state.model.globalProject.value:(state.data.defaultProject||'');
    const stage=state.model.globalStage.share>=0.95?state.model.globalStage.value:(state.data.defaultStage||'');
    const language=state.model.globalLanguage.share>=0.95?state.model.globalLanguage.value:(state.data.defaultLanguage||'');
    if(!project||!stage||!language)return {taxonomy:'',confidence:55,criterion:'Base de referência não apresentou consenso suficiente para obra, etapa ou idioma.',mode:'none',details:null,baseValidation:'Revisão obrigatória.'};

    const prefix=[project,type.value,sector.value,stage,front.value,discipline.value,language].join('-'), seq=reserveSequence(prefix), taxonomy=`${prefix}-${seq}`;
    const matrix=sectorAllowedByOfficialMatrix(type.value,sector.value);
    const fieldEvidence={project:`${Math.round(state.model.globalProject.share*100)}% das taxonomias de referência usam ${project}.`,type:type.evidence,sector:sector.evidence,stage:`${Math.round(state.model.globalStage.share*100)}% das referências usam ${stage}.`,front:front.evidence,discipline:discipline.evidence,language:`${Math.round(state.model.globalLanguage.share*100)}% das referências usam ${language}.`,sequence:'Próximo sequencial após o maior número já utilizado neste prefixo; números existentes não são reutilizados.'};
    let confidence=Math.round(type.quality*0.31+sector.quality*0.24+discipline.quality*0.27+front.quality*0.08+9.5);confidence=Math.max(60,Math.min(96,confidence));
    let validation='Compatibilidade baseada na estrutura oficial e nas taxonomias já validadas das LDs.';
    let requiresReview=false; if(matrix.known&&!matrix.allowed){const sk=codeSeriesKey(rec.code),st=sk?state.model.seriesTypeProfiles.get(sk):null,ss=sk?state.model.seriesSectorProfiles.get(sk):null,sd=sk?state.model.seriesDisciplineProfiles.get(sk):null;const strongSeries=!!(st&&ss&&sd&&st.total>=4&&ss.total>=4&&sd.total>=4&&st.share>=0.90&&ss.share>=0.90&&sd.share>=0.90);if(strongSeries){confidence=Math.min(confidence,64);requiresReview=true;validation=`A matriz geral “TIPO DE DOCUMENTO POR SETOR” não associa ${type.value} à categoria ${matrix.category}. A série ${sk} apresenta padrão histórico consistente (${Math.round(ss.share*100)}% no setor ${sector.value}), por isso a hipótese é exibida, mas a divergência com a base oficial exige revisão manual antes de aplicar.`;}else{confidence=Math.min(confidence,64);requiresReview=true;validation=`A matriz “TIPO DE DOCUMENTO POR SETOR” não associa ${type.value} à categoria ${matrix.category} e não há série suficientemente consolidada para justificar a exceção. Revisão manual obrigatória antes de aplicar.`;}}
    const details=describeTaxonomy(taxonomy,fieldEvidence);
    const similar=near[0].e.title||near[0].e.code;
    const criterion=`Base oficial + padrões validados. Referência mais próxima: “${similar}” (${Math.round(near[0].score*100)}%). ${type.evidence}; ${sector.evidence}; ${discipline.evidence}; ${front.evidence}.`;
    const out={taxonomy,confidence,criterion,mode:'inferred',details,baseValidation:validation,requiresReview};cache.set(key,out);return out;
  }

  // ---------- UI / workflow ----------
  function refreshStats() {
    els.statTypes.textContent=(state.customBase?.documentTypes||state.data.documentTypes||[]).length.toLocaleString('pt-BR');
    els.statExamples.textContent=(state.data.examples||[]).length.toLocaleString('pt-BR');
    els.statRefs.textContent=(state.data.referenceRecords||[]).length.toLocaleString('pt-BR');
    const custom=state.customBase;
    els.baseStatus.innerHTML=custom
      ? `<strong>Base personalizada ativa</strong> · ${escapeHtml(custom.fileName)} · ${custom.documentTypes.length} tipos documentais.`
      : `<strong>Base incorporada ativa</strong> · ${escapeHtml(state.data.sourceFile||'CONSAG')} · revisão de referência ${escapeHtml(state.data.version||'')}.`;
  }
  function refreshCodeCount(){const n=parseCodes().length;els.codeCount.textContent=`${n} ${n===1?'código':'códigos'}`}
  function parseCodes(){return els.codesInput.value.split(/[\n;]+/).map(s=>s.trim()).filter(Boolean)}

  function refreshLDList() {
    if(!state.loadedFiles.length){els.ldList.className='file-list empty-state';els.ldList.textContent='Nenhuma LD carregada. A consulta ainda funciona com as 5 LDs de referência incorporadas.';return;}
    els.ldList.className='file-list';
    els.ldList.innerHTML=state.loadedFiles.map(f=>`<div class="file-item"><span>✓</span><div><strong>${escapeHtml(f.name)}</strong><small>${f.records.length.toLocaleString('pt-BR')} documentos reconhecidos</small></div><button type="button" data-remove="${f.id}" title="Remover">×</button></div>`).join('');
    els.ldList.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>removeLD(b.dataset.remove));
  }
  function removeLD(id){state.loadedFiles=state.loadedFiles.filter(f=>f.id!==id);state.loadedRecords=state.loadedFiles.flatMap(f=>f.records);buildModel();refreshLDList();toast('LD removida da análise.');}

  async function loadLDFiles(files) {
    const list=[...files].filter(f=>/\.(xlsx|xlsm)$/i.test(f.name)); if(!list.length)return;
    setBusy(true,'Lendo LDs e indexando documentos…');
    try {
      for(const file of list){await yieldUI(); const book=await parseWorkbook(file); await extractLDRecords(book); state.loadedFiles.push(book);}
      state.loadedRecords=state.loadedFiles.flatMap(f=>f.records); buildModel(); refreshLDList(); toast(`${list.length} ${list.length===1?'LD carregada':'LDs carregadas'} com sucesso.`);
    } catch(e){console.error(e);toast('Não foi possível ler uma das LDs: '+e.message,'error');}
    finally{setBusy(false)}
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
      buildModel(); const cache=new Map(), out=[];
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
          matches:loadedMatches, origin:loadedMatches.length?`${new Set(loadedMatches.map(r=>r.sourceLD)).size} LD(s) carregada(s)`:`${rec.sourceLD||'Referência'} · ${rec.sheet||''}`,
          selected:loadedMatches.length>0 && emptyLoaded.length>0 && validTax(inf.taxonomy) && !currentDiff && !inf.requiresReview,
          writable:loadedMatches.length>0
        });
      }
      state.results=out; renderResults();
      window._uiProgress?.set(100,'Concluído!');
      setTimeout(()=>{ window._uiOnResults?.(); }, 0);
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
      const cc=confidenceClass(r.confidence);
      return `<tr class="${r.found?'':'not-found'}${r.requiresReview?' row-requires-review':''}" data-index="${i}">
        <td class="col-check"><input class="row-check" type="checkbox" ${r.selected?'checked':''} ${!r.writable||!validTax(r.taxonomy)?'disabled':''}></td>
        <td class="col-code"><strong class="doc-code">${escapeHtml(r.code)}</strong></td>
        <td class="col-title"><div class="title-cell"><strong>${escapeHtml(r.title||'—')}</strong><span>${escapeHtml(r.disciplineText||'')}</span></div></td>
        <td class="col-status">${statusBadge(r)}</td>
        <td class="col-current"><div class="current-stack">${r.current?`<span class="tax-current">${escapeHtml(r.current)}</span>`:''}${r.emptyCount>0?`<span class="blank-badge">Em branco${r.matches?.length>1?` · ${r.emptyCount}/${r.matches.length}`:''}</span>`:(!r.current?'<span class="tax-current empty">Vazio</span>':'')}</div></td>
        <td class="col-suggested">${r.found?`<input class="tax-input" value="${escapeHtml(r.taxonomy)}" spellcheck="false" ${!r.taxonomy?'placeholder="Revisão necessária"':''}>`:'—'}</td>
        <td class="col-confidence"><span class="confidence-badge ${cc}"><i></i>${confidenceLabel(r.confidence)} · ${r.confidence}%</span></td>
        <td class="col-origin"><span class="origin-badge ${r.writable?'loaded':'reference'}">${escapeHtml(r.found?r.origin:'Não encontrado')}</span></td>
        <td class="col-criterion"><div class="criteria">${escapeHtml(r.criterion)}</div></td>
        <td class="col-action"></td>
      </tr>`;
    }).join('');

    els.resultsBody.querySelectorAll('tr').forEach(tr=>{
      const i=Number(tr.dataset.index), r=state.results[i], chk=tr.querySelector('.row-check'), inp=tr.querySelector('.tax-input');
      if(chk)chk.addEventListener('change',()=>{r.selected=chk.checked});
      if(inp)inp.addEventListener('input',()=>{r.taxonomy=inp.value.trim().toUpperCase();inp.value=r.taxonomy;const ok=validTax(r.taxonomy);inp.classList.toggle('invalid',!ok);if(chk){chk.disabled=!r.writable||!ok;if(!ok){chk.checked=false;r.selected=false}}});
    });
    // Navigation to sugestoes view is handled by ui.js MutationObserver
  }

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
      const ops=new Map();
      for(const r of selected) for(const m of r.matches) {
        // Preencha somente células realmente vazias. Qualquer valor já existente é protegido.
        const existing=String(m.taxonomy||'').trim().toUpperCase();
        if(existing && existing!==r.taxonomy) continue;
        const key=`${m.fileId}|${m.sheetPath}`; if(!ops.has(key))ops.set(key,[]); ops.get(key).push({row:m.row,col:m.taxCol,tax:r.taxonomy});
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
    try{const b=await parseBaseWorkbook(file);state.customBase=b;try{localStorage.setItem('taxonomiaConsag.customBase',JSON.stringify(b))}catch{}buildModel();refreshStats();toast('Nova base CONSAG ativada localmente.');}
    catch(e){console.error(e);toast('Não foi possível reconhecer a nova base: '+e.message,'error');}
    finally{setBusy(false);els.baseFile.value=''}
  }
  function loadCustomBase(){try{const raw=localStorage.getItem('taxonomiaConsag.customBase');if(raw)state.customBase=JSON.parse(raw)}catch{state.customBase=null}}

  function bind() {
    els.codesInput.addEventListener('input',refreshCodeCount); els.clearCodes.onclick=()=>{els.codesInput.value='';refreshCodeCount();els.codesInput.focus()}; els.analyzeBtn.onclick=analyze;
    els.ldFiles.onchange=e=>{loadLDFiles(e.target.files);e.target.value=''};
    ['dragenter','dragover'].forEach(ev=>els.ldDrop.addEventListener(ev,e=>{e.preventDefault();els.ldDrop.classList.add('drag')}));
    ['dragleave','drop'].forEach(ev=>els.ldDrop.addEventListener(ev,e=>{e.preventDefault();els.ldDrop.classList.remove('drag')}));
    els.ldDrop.addEventListener('drop',e=>loadLDFiles(e.dataTransfer.files));
    els.selectAllBtn.onclick=selectApplicable;els.copyBtn.onclick=copyRelation;els.xlsxBtn.onclick=exportXLSX;els.applyBtn.onclick=applyAndDownload;els.blankAnalyzeBtn.onclick=analyzeBlankTaxonomies;els.baseFile.onchange=e=>updateBase(e.target.files[0]);
  }

  function init() {
    loadCustomBase(); buildModel(); refreshStats(); refreshCodeCount(); refreshLDList(); bind();
    console.info(`[Taxonomia Consag] ${state.data.examples?.length||0} exemplos e ${state.data.referenceRecords?.length||0} documentos de referência carregados.`);
  }
  init();
})();
