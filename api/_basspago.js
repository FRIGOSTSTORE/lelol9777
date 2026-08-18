// api/_basspago.js
// Biblioteca compartilhada: BassPago (OAuth2 + mTLS), armazenamento e UTMify.
// Roda em Node serverless (Vercel). Sem dependencias externas.

const https = require('node:https')
const tls = require('node:tls')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ---------------------------------------------------------------------------
// Configuracao (variaveis de ambiente com fallback para os valores do projeto)
// ---------------------------------------------------------------------------
const CONFIG = {
  urlApi: process.env.BASSPAGO_URL_API || 'https://api.pix.basspago.com.br',
  clientId: process.env.BASSPAGO_CLIENT_ID || '00011193760124794000127',
  clientSecret: process.env.BASSPAGO_CLIENT_SECRET || 'mNhMDcwNTItYTc4Ni00MjE1LThlOGEtZ',
  keyPass: process.env.BASSPAGO_KEY_PASS || 'd.WWxgdpH_r3nv2HCMJcYxH-K8xkJqPJJuAH7V2Tp2CNbugdDWc!nbvH7a2X',
  chavePix: process.env.BASSPAGO_CHAVE_PIX || 'fcd47d4c-bd68-440a-8480-9c5a6c184abc',
  utmifyToken: process.env.UTMIFY_API_TOKEN || 'Dfmu9abjTH3QZghTyMcCApc3biYCrKF2oMpr',
  nomeProduto: process.env.NOME_PRODUTO || 'Kit Elseve Collagen Lifter',
  idProduto: process.env.ID_PRODUTO || 'PROD01',
  expiracao: parseInt(process.env.EXPIRACAO_PIX || '3600', 10),
}

// ---------------------------------------------------------------------------
// Certificados mTLS
// Prioridade: variavel de ambiente (texto ou base64) > arquivo em api/_certs
// ---------------------------------------------------------------------------
const CERT_DIR = path.join(__dirname, '_certs')

function loadMaterial(envPlain, envBase64, fileName) {
  const plain = process.env[envPlain]
  if (plain && plain.trim() !== '') {
    // Permite colar o PEM com \n literais na variavel de ambiente
    return plain.includes('-----BEGIN') ? plain.replace(/\\n/g, '\n') : plain
  }

  const b64 = process.env[envBase64]
  if (b64 && b64.trim() !== '') {
    return Buffer.from(b64, 'base64').toString('utf8')
  }

  const file = path.join(CERT_DIR, fileName)
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8')
  }

  throw new Error(
    'Certificado ausente: defina ' + envPlain + ' (ou ' + envBase64 + ') ou inclua api/_certs/' + fileName
  )
}

let agentCache = null

function getAgent() {
  if (agentCache) return agentCache

  const cert = loadMaterial('BASSPAGO_CERT', 'BASSPAGO_CERT_B64', 'BASSPAGO_230.crt')
  const key = loadMaterial('BASSPAGO_KEY', 'BASSPAGO_KEY_B64', 'BASSPAGO_230.key')
  const ca = loadMaterial('BASSPAGO_CA', 'BASSPAGO_CA_B64', 'onz_ca.pem')

  // IMPORTANTE: a opcao "ca" do Node SUBSTITUI a lista padrao de CAs
  // publicas (nao soma a ela). Como onz_ca.pem normalmente e a CA usada
  // para validar o certificado mTLS do cliente (nao necessariamente a CA
  // que emitiu o certificado TLS do servidor da BassPago), precisamos
  // somar as CAs publicas padrao do Node + a CA customizada. Sem isso, a
  // verificacao do certificado do proprio servidor falha com
  // "unable to get local issuer certificate".
  const options = {
    cert: cert,
    key: key,
    ca: tls.rootCertificates.concat([ca]),
    keepAlive: true,
    rejectUnauthorized: true,
  }

  // Só envia a senha se a chave realmente estiver criptografada
  if (key.includes('ENCRYPTED')) {
    options.passphrase = CONFIG.keyPass
  }

  agentCache = new https.Agent(options)
  return agentCache
}

// ---------------------------------------------------------------------------
// Nucleo HTTP com mTLS (https.request, pois o fetch global nao aceita agent)
// ---------------------------------------------------------------------------
function rawRequest(method, fullUrl, payload, headers) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(fullUrl)

    const req = https.request(
      {
        method: method,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: headers,
        agent: getAgent(),
        timeout: 25000,
      },
      function (res) {
        let body = ''
        res.on('data', function (chunk) {
          body += chunk
        })
        res.on('end', function () {
          let json = null
          try {
            json = JSON.parse(body)
          } catch (e) {
            json = null
          }
          resolve({ status: res.statusCode, json: json, raw: body })
        })
      }
    )

    req.on('error', reject)
    req.on('timeout', function () {
      req.destroy(new Error('Timeout na chamada ao BassPago'))
    })

    if (payload) req.write(payload)
    req.end()
  })
}

let tokenCache = { value: null, expiry: 0 }

async function getToken() {
  const agora = Math.floor(Date.now() / 1000)
  if (tokenCache.value && agora < tokenCache.expiry - 30) {
    return tokenCache.value
  }

  const form = new URLSearchParams({
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    grant_type: 'client_credentials',
  }).toString()

  const res = await rawRequest('POST', CONFIG.urlApi + '/oauth/token', form, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(form),
  })

  if (!res.json || !res.json.access_token) {
    throw new Error('Falha ao obter token do BassPago: HTTP ' + res.status + ' ' + res.raw)
  }

  tokenCache = {
    value: res.json.access_token,
    expiry: agora + (parseInt(res.json.expires_in, 10) || 300),
  }

  return tokenCache.value
}

async function apiRequest(method, pathname, body) {
  const token = await getToken()
  const payload = body ? JSON.stringify(body) : null

  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
  }

  if (payload) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(payload)
  }

  const res = await rawRequest(method, CONFIG.urlApi + pathname, payload, headers)

  if (res.status >= 400) {
    const err = new Error('HTTP ' + res.status + ': ' + res.raw)
    err.statusCode = res.status
    throw err
  }

  return res.json || {}
}

// ---------------------------------------------------------------------------
// Operacoes Pix
// ---------------------------------------------------------------------------
function criarCobranca(dados) {
  return apiRequest('POST', '/cob', dados)
}

function consultarCobranca(txid) {
  if (!/^[a-zA-Z0-9]{26,35}$/.test(txid)) {
    throw new Error('txid invalido')
  }
  return apiRequest('GET', '/cob/' + txid)
}

function configurarWebhook(chave, webhookUrl) {
  return apiRequest('PUT', '/webhook/' + encodeURIComponent(chave), { webhookUrl: webhookUrl })
}

function consultarWebhook(chave) {
  return apiRequest('GET', '/webhook/' + encodeURIComponent(chave))
}

// ---------------------------------------------------------------------------
// Armazenamento das transacoes
// Upstash Redis (recomendado na Vercel, pois o disco e efemero) com fallback
// para /tmp. O pagamento continua sendo confirmado mesmo sem Redis, porque o
// check_payment consulta a cobranca direto no BassPago.
// ---------------------------------------------------------------------------
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
const usandoRedis = Boolean(UPSTASH_URL && UPSTASH_TOKEN)

function tmpFile(txid) {
  return path.join(os.tmpdir(), 'pix-' + txid + '.json')
}

async function saveTx(txid, data) {
  const chave = 'pix:' + txid
  const valor = JSON.stringify(data)

  if (usandoRedis) {
    try {
      // Expira em 7 dias
      await fetch(UPSTASH_URL + '/set/' + encodeURIComponent(chave) + '?EX=604800', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'text/plain' },
        body: valor,
      })
      return
    } catch (e) {
      // cai para o /tmp
    }
  }

  try {
    fs.writeFileSync(tmpFile(txid), valor)
  } catch (e) {
    // sem armazenamento: o fluxo continua via consulta ao BassPago
  }
}

async function loadTx(txid) {
  const chave = 'pix:' + txid

  if (usandoRedis) {
    try {
      const r = await fetch(UPSTASH_URL + '/get/' + encodeURIComponent(chave), {
        headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN },
      })
      const j = await r.json()
      if (j && j.result) return JSON.parse(j.result)
    } catch (e) {
      // cai para o /tmp
    }
  }

  try {
    const f = tmpFile(txid)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    // ignora
  }

  return {}
}

// ---------------------------------------------------------------------------
// UTMify
// ---------------------------------------------------------------------------
async function sendUtmify(status, data) {
  if (!CONFIG.utmifyToken) return

  const valor = parseFloat(data.valor || 0) || 0
  const centavos = Math.round(valor * 100)
  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const txid = data.txid || 'pix_' + Date.now()

  const opt = function (v) {
    return v && String(v).trim() !== '' ? String(v) : null
  }

  const body = {
    orderId: String(txid),
    platform: 'CheckoutProprio',
    paymentMethod: 'pix',
    status: status,
    createdAt: data.createdAt || agora,
    approvedDate: status === 'paid' ? data.paidAt || agora : null,
    refundedAt: null,
    customer: {
      name: opt(data.nome) || 'Cliente',
      email: opt(data.email) || 'pix.' + String(txid).slice(0, 20) + '@noreply.invalid',
      phone: opt(data.phone),
      document: opt(data.document),
    },
    products: [
      {
        id: CONFIG.idProduto,
        name: CONFIG.nomeProduto,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: centavos,
      },
    ],
    trackingParameters: {
      utm_source: opt(data.utm_source),
      utm_medium: opt(data.utm_medium),
      utm_campaign: opt(data.utm_campaign),
      utm_content: opt(data.utm_content),
      utm_term: opt(data.utm_term),
      src: opt(data.src),
      sck: opt(data.sck),
    },
    commission: {
      totalPriceInCents: centavos,
      gatewayFeeInCents: 0,
      userCommissionInCents: centavos,
    },
  }

  try {
    await fetch('https://api.utmify.com.br/api-credentials/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': CONFIG.utmifyToken },
      body: JSON.stringify(body),
    })
  } catch (e) {
    // tracking nunca deve derrubar o pagamento
  }
}

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------
function lerBody(req) {
  return new Promise(function (resolve) {
    // A Vercel normalmente ja entrega req.body pronto
    if (req.body && typeof req.body === 'object') return resolve(req.body)
    if (typeof req.body === 'string') {
      try {
        return resolve(JSON.parse(req.body))
      } catch (e) {
        return resolve({})
      }
    }

    let raw = ''
    req.on('data', function (c) {
      raw += c
    })
    req.on('end', function () {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function extrairCopiaECola(resp) {
  return (
    resp.pixCopiaECola ||
    resp.brcode ||
    resp.qrcode ||
    resp.emv ||
    (resp.loc && resp.loc.pixCopiaECola) ||
    null
  )
}

module.exports = {
  CONFIG: CONFIG,
  criarCobranca: criarCobranca,
  consultarCobranca: consultarCobranca,
  configurarWebhook: configurarWebhook,
  consultarWebhook: consultarWebhook,
  saveTx: saveTx,
  loadTx: loadTx,
  sendUtmify: sendUtmify,
  lerBody: lerBody,
  extrairCopiaECola: extrairCopiaECola,
  usandoRedis: usandoRedis,
}
