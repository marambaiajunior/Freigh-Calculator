# Abby Transport — Weekly Freight Lane Rate Updater

Este pacote adiciona atualização semanal automática para a matriz de rates da sua calculadora.

## Arquivos incluídos

- `.github/workflows/update-lane-rates.yml`
- `scripts/update-lane-rates.mjs`
- `data/lane-rates.json`
- `data/lane-rates-history.json`

## Como instalar

1. Descompacte este ZIP.
2. Copie as pastas `.github`, `scripts` e `data` para a raiz do seu repositório `Freigh-Calculator`.
3. Faça commit e push para o GitHub.
4. Vá em GitHub → seu repositório → Actions.
5. Abra o workflow `Update Freight Lane Rates`.
6. Clique em `Run workflow` para testar manualmente.

Depois disso, ele roda automaticamente toda segunda-feira às 13:15 UTC.

## O que ele altera

O workflow executa `scripts/update-lane-rates.mjs`. Esse script:

1. tenta buscar rates públicos em DAT Trendlines e Scale Funding;
2. opcionalmente usa uma API paga se você configurar `DAT_API_URL` e `DAT_API_KEY` nos Secrets;
3. calcula uma nova matriz regional `REGION_RATES`;
4. substitui dentro do `index.html` os valores de:
   - `DEFAULT_COST_PER_MILE`
   - `REGION_RATES`
   - o `value="..."` visível do campo `Cost Per Mile`
5. salva um registro auditável em `data/lane-rates.json` e `data/lane-rates-history.json`.

## Sobre DAT/API paga

Sem credenciais oficiais, o script usa leitura pública aproximada. Isso é bom para acompanhar a direção do mercado, mas não é lane-level profissional.

Para dados realmente precisos por lane, configure uma API paga depois:

- Repository → Settings → Secrets and variables → Actions → New repository secret
- `DAT_API_URL`
- `DAT_API_KEY`

O endpoint pode retornar JSON em um destes formatos:

```json
{
  "flatbed": {
    "nationalAverage": 2.92,
    "midwest": 3.14,
    "west": 2.39
  }
}
```

ou:

```json
{
  "defaultCostPerMile": 2.92,
  "regionRates": {
    "NOR": { "NOR": 2.97, "SOU": 3.13 }
  }
}
```

## Limitação importante

Sites públicos podem mudar estrutura e quebrar parsing. Quando isso acontece, o script mantém os últimos valores bons em vez de destruir o sistema. Pequena vitória contra o caos, o que já é mais do que muitos ERPs conseguem fazer.
