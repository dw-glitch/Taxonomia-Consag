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
