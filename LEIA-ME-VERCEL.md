# Checkout Elseve + Pix BassPago na Vercel

A Vercel **nao executa PHP**. Por isso a API do checkout foi reescrita em
**funcoes serverless Node** (sem nenhuma dependencia externa) e o site virou
conteudo estatico. O Pix do BassPago continua igual: OAuth2 + mTLS + webhook.

## Estrutura

```
/
  vercel.json              config de funcoes, rewrites e cache
  package.json             Node >= 18
  .env.example             todas as variaveis de ambiente
  api/
    _basspago.js           mTLS, token, armazenamento e UTMify (compartilhado)
    generate_pix.js        POST  /api/generate_pix
    check_payment.js       GET   /api/check_payment?txid=...
    webhook.js             POST  /api/webhook
    configurar_webhook.js  GET   /api/configurar_webhook?secret=...
    _certs/                certificados mTLS do BassPago
  public/
    index.html             pagina de venda
    index(1..10).html      variantes
    checkout/index.html    checkout (era checkout.php)
    elseve/                produtos, upsells, backredirects e videos
```

Arquivos e pastas com `_` no inicio nao viram rota publica na Vercel, entao
`_basspago.js` e `_certs/` ficam inacessiveis de fora.

## Deploy em 4 passos

1. **Suba o projeto**
   ```bash
   npm i -g vercel
   vercel
   vercel --prod
   ```
   Ou conecte o repositorio no painel da Vercel. Nao precisa configurar build:
   e site estatico + funcoes, detectado automaticamente.

2. **Crie o armazenamento (recomendado)**
   No painel do projeto: **Storage > Upstash Redis > Create**. As variaveis
   `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` sao injetadas sozinhas.
   Isso e necessario porque o disco da Vercel e efemero: sem Redis, os dados do
   cliente podem se perder entre execucoes. O **pagamento continua sendo
   confirmado** mesmo sem Redis, porque o `check_payment` consulta a cobranca
   direto no BassPago.

3. **Defina `SETUP_SECRET`** em Settings > Environment Variables (qualquer senha
   longa) e faca o redeploy.

4. **Registre o webhook uma unica vez**, abrindo no navegador:
   ```
   https://SEUPROJETO.vercel.app/api/configurar_webhook?secret=SEU_SETUP_SECRET
   ```
   Deve responder `"ok": true`. Para so conferir o que esta registrado, adicione
   `&consultar=1`. A URL do webhook e detectada pelo dominio automaticamente.

Pronto. O checkout fica em `https://SEUPROJETO.vercel.app/checkout`.

## Fluxo

```
public/checkout/index.html
   |  POST /api/generate_pix   { amount, name, email, document, phone, utm_* }
   v
generate_pix.js  -> OAuth2 + mTLS -> POST /cob -> salva no Redis -> UTMify(waiting_payment)
   |
   |  { success, txid, copy_paste }
   v
QR Code desenhado no navegador + polling a cada 5s em /api/check_payment?txid=...

BassPago --POST {"pix":[...]}--> /api/webhook -> status=paid -> UTMify(paid)
```

A confirmacao tem **caminho duplo**: o webhook marca como pago na hora, e o
polling tambem consulta a cobranca no BassPago. Se um falhar, o outro resolve.

## Sobre o mTLS na Vercel

Este era o ponto de risco que eu havia alertado, e esta resolvido: as funcoes
usam `node:https` com `https.Agent({ cert, key, ca })`, que suporta certificado
de cliente normalmente. O `fetch` global **nao** aceita agent, por isso o
codigo usa `https.request` direto.

A chave do BassPago e PKCS#8 sem senha, entao a passphrase so e enviada se a
chave estiver realmente criptografada.

## Rotas antigas

O `vercel.json` tem rewrites para os caminhos `.php` antigos
(`/checkout/checkout.php`, `/checkout/api/generate_pix.php` etc.), para nao
quebrar nenhum link ou anuncio que ainda aponte para eles.

## Pendencias suas

- **Rotacione as credenciais** do BassPago no painel e coloque as novas nas
  variaveis de ambiente. As atuais estao no codigo como fallback e ja
  circularam por anexo.
- Se quiser tirar os certificados do repositorio, gere
  `base64 -w 0 arquivo` para cada um, coloque em `BASSPAGO_CERT_B64`,
  `BASSPAGO_KEY_B64` e `BASSPAGO_CA_B64`, apague `api/_certs/` e descomente a
  linha correspondente no `.gitignore`.
- As paginas de upsell e backredirect (`public/elseve/up/*` e
  `public/elseve/back/*`) ainda tem **7 botoes apontando para checkouts
  hospedados na PenguimPay** (`app.penguimpay.com/checkout/...`). Sao links
  externos, cada um com produto e preco proprios. Se quiser que tudo passe pelo
  BassPago, esses botoes precisam apontar para `/checkout`.
- Os videos (`public/elseve/videos/`, ~31 MB) estao no repositorio. Funciona,
  mas o ideal e servir de um CDN/bucket para o deploy ficar leve.
