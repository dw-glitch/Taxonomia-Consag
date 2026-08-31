# Taxonomia Consag

Sistema web local para gerar e preencher a coluna **Taxonomia** das LDs usando como referência a planilha `CONSAG-PHC-ENG-DC-GERA-GES-PT-0001_19 1` e taxonomias já existentes nas LDs fornecidas.

## Como usar

1. Abra `index.html` no Google Chrome ou Microsoft Edge.
2. Para consultar, cole um ou vários códigos (um por linha) e clique em **Gerar taxonomias**.
3. Para gravar a taxonomia na LD, carregue uma ou mais LDs em **LDs de trabalho** antes de analisar.
4. Revise os itens marcados como **Média** ou **Revisar**. A sugestão pode ser editada diretamente na tabela.
5. Clique em **Aplicar nas LDs e baixar**. O sistema altera somente as células da coluna Taxonomia e gera novas cópias dos arquivos.
6. Se houver uma nova revisão da base CONSAG, use **Atualizar base CONSAG**. A estrutura extraída fica salva no navegador.

## Lógica de classificação

A taxonomia é tratada no padrão:

`OBRA-TIPO-SETOR-ETAPA-FRENTE-DISCIPLINA-IDIOMA-SEQUENCIAL`

A classificação usa, em ordem de prioridade:

- taxonomia já existente para o mesmo código;
- memória de documentos já taxonomizados nas LDs de referência;
- semelhança de título, disciplina/workflow e família do código;
- catálogo oficial de tipos documentais, setores, etapas, frentes e disciplinas da base CONSAG;
- controle de sequencial para evitar reutilização de um número já existente no mesmo prefixo taxonômico.

## Privacidade e preservação da LD

O processamento é feito no próprio navegador. Os arquivos não são enviados a servidor. Na gravação, o sistema reconstrói o pacote XLSX/XLSM preservando os demais arquivos internos e modifica apenas as planilhas/células necessárias da coluna Taxonomia.

## Compatibilidade

Recomendado: versões atuais do Google Chrome ou Microsoft Edge em Windows.


## Novidades da versão 1.1
- Detecta automaticamente documentos com a coluna **Taxonomia** em branco nas LDs carregadas.
- Botão **Detectar Taxonomias em branco** cria a relação de códigos e executa a análise.
- Quando o mesmo código já possui uma Taxonomia válida em outra LD/referência, esse valor é priorizado.
- Células com qualquer conteúdo existente são protegidas contra sobrescrita automática.
- A relação é exportada em **Taxonomia_Consag_Relacao.xlsx**, com cabeçalho, filtros, painel congelado, status, confiança, origem e critério.


## v1.2 — precisão e auditoria da base
- Prioriza o mesmo código e a mesma série documental antes de usar semelhança geral.
- Valida tipo documental e setor emissor contra a aba **TIPO DE DOCUMENTO POR SETOR**.
- Usa a aba **TAXONOMIA** para interpretar os oito segmentos na ordem oficial.
- A disciplina da LD não é copiada cegamente: o sistema verifica como a mesma série foi taxonomizada nas referências válidas.
- Divergência entre padrão histórico e matriz oficial recebe **Revisar** e não é selecionada automaticamente.
- O relatório `.xlsx` possui a aba **Dicionário da Base** e detalha cada segmento com código + descrição.
- Para novas taxonomias, o sequencial é gerado após o maior número já utilizado no mesmo prefixo, evitando duplicidade.


## Correção v1.3 — relatório Excel
A exportação da relação deixou de construir o pacote XLSX/XML do zero. O sistema usa um modelo XLSX válido gerado previamente e altera somente os dados da planilha da relação, preservando a estrutura interna do arquivo. Isso evita o aviso do Excel de que o arquivo precisa ser reparado.


## Correção v1.3.1 — a LD carregada não aparecia no painel

### Sintoma
O upload concluía com sucesso, mas o painel abaixo da área de upload voltava a exibir
**"Nenhuma LD carregada"**, mesmo com o arquivo lido corretamente.

### Causa raiz
`ui.js` registrava um `MutationObserver` sobre `#ldList` e, no próprio callback, reescrevia
`innerHTML` e `className` desse mesmo nó — que estava sendo observado. A escrita re-disparava
o observer; na segunda passagem, os itens `.file-item` gerados pelo `app.js` já haviam sido
substituídos por `.ld-item`, então a lista era considerada vazia e o estado vazio apagava a LD
recém-carregada. O upload, a leitura do arquivo e o estado da aplicação sempre estiveram corretos:
o dado era destruído na camada de apresentação, cerca de 160 ms depois de aparecer na tela.

### Correção
O DOM deixou de ser usado como transporte de estado entre as duas camadas:

- `app.js` é o dono único do estado e do nó `#ldList`, e publica os dados no `TaxonomiaBus`
  (`tax:lds`, `tax:results`, `tax:selection`, `tax:base`).
- `ui.js` apenas consome esses eventos. Não há mais nenhum `MutationObserver` no projeto.

### Também nesta versão
- Estados de **carregamento** (nome, tamanho, barra, percentual e status por arquivo),
  **sucesso** (nome, data, quantidade de documentos, situação) e **vazio** (ícone, texto e botão).
- Lista de LDs com pesquisa, ordenação, atualização e remoção.
- Filtros e paginação da tabela deixaram de contar linhas removidas do documento
  (o rodapé exibia "0 resultados" com todas as linhas visíveis).
- Delegação de eventos: a tabela não cria mais dois listeners por linha.
- Análise de 8.000 códigos ~3,6x mais rápida, com saída de classificação idêntica.
- Responsividade (o CSS não possuía nenhuma media query) e acessibilidade.


## Correção v1.3.2 — LDs com nomenclatura por WBS não eram lidas

### Sintoma
Ao carregar as LDs 03, 04 e 05, o painel mostrava **"0 registros"** e o botão
**Detectar Taxonomias em Branco** respondia *"Carregue ao menos uma LD para detectar
Taxonomias em branco"* — justamente as LDs que têm 100% da coluna Taxonomia em branco.

### Causa raiz
`looksLikeDocCode()` reconhecia apenas o padrão Petrobras
(`CR-5290.00-22313-911-C1O-001`). Como `extractLDRecords()` usa essa função para
decidir quais linhas da planilha são documentos, todas as linhas no formato por WBS
(`C1O_RNEST_U32_3.1.1.1_CVL_RIR_B-32014A`) eram descartadas em silêncio — a LD era
importada com zero registros.

Medido sobre os 23.413 registros de referência embutidos:

| LD | registros | reconhecidos antes | depois |
|----|-----------|--------------------|--------|
| LD_001 | 3.836 | 3.652 | 3.836 |
| LD_002 | 423 | 423 | 423 |
| LD_003 | 17.094 | **0** | 17.092 |
| LD_004 | 1.871 | **0** | 1.871 |
| LD_005 | 189 | **0** | 189 |
| **total** | **23.413** | **17,4%** | **100,0%** |

Os 2 restantes têm `/` no código (`..._U32-VENT-T31004/V`); o `normCode()` trata a
barra como separador de caminho e trunca o valor. É comportamento pré-existente da
normalização usada por todo o motor de correspondência e não foi alterado aqui.

### Também corrigido
Com as LDs finalmente sendo lidas, um segundo defeito ficava alcançável: um prefixo
taxonômico que atinge os **9999** sequenciais do padrão de 4 dígitos fazia
`reserveSequence()` lançar exceção, que subia até `analyze()` e **descartava a análise
inteira** — inclusive os milhares de documentos já classificados. Agora os documentos
afetados são marcados para revisão manual, com aviso explícito, e o restante da
análise é preservado. Também foi corrigida a duplicidade no limite (o número 9999
podia ser devolvido duas vezes) e a varredura do conjunto a cada reserva.

### Limitação conhecida
Nas LDs 03/04/05, cerca de 73% dos documentos voltam sem sugestão automática
("Revisão obrigatória"). Isso **não é um defeito**: são as travas do classificador,
que se recusa a inferir tipo, disciplina ou setor sem evidência suficiente. Essas LDs
não possuem nenhuma taxonomia própria e usam uma família de códigos distinta das LDs
de referência que possuem taxonomia validada.


## v1.3.3 — precisão por família de documento (abas ET e N-1710)

As LDs usam duas famílias de código, uma por aba, e o motor tratava as duas do
mesmo jeito: inferindo tipo e disciplina por semelhança de título, ignorando que
**o próprio código já declara essa informação**.

| aba | LDs | documentos | código |
|---|---|---|---|
| `ET` | 003, 004, 005 | 19.013 | `C1O_RNEST_U32_3.1.1.1_CVL_RIR_B-32014A` |
| `N-1710` | 001, 002 | 3.726 | `CR-5290.00-22313-911-C1O-001` |

### Aba ET — cobertura de 26,5% para 88,4%

| | antes | depois |
|---|---|---|
| com sugestão automática | 5.036 (26,5%) | **16.817 (88,4%)** |
| falha de tipo | 11.223 | 1.836 |
| falha de setor | 2.577 | **0** |

Três mudanças, todas ancoradas na base oficial:

1. **Tipo pelo código.** 90,3% dos tokens de tipo das LDs ET são códigos válidos
   do catálogo oficial (`RIR` = RELATÓRIO DE INSPEÇÃO NO RECEBIMENTO). A
   confiança acompanha a corroboração do título: 99,7% dos casos têm o título
   confirmando a descrição oficial; quando não confirma, o documento é proposto
   com confiança baixa e marcado para revisão, não afirmado.
2. **Disciplina pelo código.** `TUB`, `INS`, `ELE`, `TEL` são códigos do catálogo;
   `CVL` e `HVAC` resolvem para `CIV` e `HVA` pelos apelidos oficiais.
3. **Setor pela matriz oficial.** A aba `TIPO DE DOCUMENTO POR SETOR` passa a ser
   consultada: quando admite um único setor para o tipo (245 dos 327 tipos), o
   setor está determinado pela base, não inferido. `RIR` → `QUALIDADE` → `QTM`.

### O que deliberadamente NÃO foi feito

Os tokens `EST` (estáticos, 583 docs) e `DIN` (dinâmicos, 112) não têm
equivalente no catálogo — que separa estrutura por material (`MET`, `COC`,
`MAD`, `PMO`). Eles vão para **revisão manual**.

Isso não é omissão: numa versão intermediária esses 374 documentos recebiam
disciplina `INP` (INSPEÇÃO), capturada da palavra "INSPEÇÃO" **no título** do
relatório — não da disciplina real do equipamento. Taxonomia errada gravada na
LD é pior que ausência de sugestão, então a inferência por título foi bloqueada
quando o código declara uma disciplina que a base não reconhece.

Os 1.836 documentos que ainda falham no tipo (`REP`, `RUFF`, `PPT`…) usam tipos
que **não existem** no catálogo oficial. Só uma atualização da base CONSAG
resolve.

### Aba N-1710 — inalterada e verificada

A saída é **byte a byte idêntica** à da versão anterior. Uma tentativa de usar
`prefixo|disciplina` do código como evidência foi medida, **não apresentou ganho**
e alterava o desempate código-vs-título sem gabarito que a validasse — foi
removida.

Precisão medida em 627 documentos retidos da base (removidos do modelo antes da
análise, para que o código exato não pudesse ser reconhecido):

| segmento | acerto |
|---|---|
| prefixo completo (7 segmentos) | 87,3% |
| tipo | 96,3% |
| setor | 95,5% |
| disciplina | 92,2% |
| frente | 97,8% |
| obra / etapa / idioma | 100,0% |

A maior fonte de erro remanescente é o **perfil da série do código** (25 dos 47
erros de disciplina): ele agrupa documentos que só diferem no sequencial e fica
confiante demais quando a série mistura disciplinas.
