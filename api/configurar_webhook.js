// api/configurar_webhook.js
// Rode UMA VEZ depois do deploy para registrar o webhook no BassPago.
// GET /api/configurar_webhook?secret=SEU_SETUP_SECRET
//
// A URL do webhook e detectada automaticamente pelo dominio da requisicao,
// ou pode ser fixada na variavel de ambiente WEBHOOK_URL.

const bp = require('./_basspago')

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  // Protecao simples: exige o segredo definido em SETUP_SECRET
  const segredo = process.env.SETUP_SECRET
  const q = req.query || {}

  if (!segredo) {
    res.status(403).json({
      ok: false,
      error: 'Defina a variavel de ambiente SETUP_SECRET na Vercel e chame com ?secret=...',
    })
    return
  }

  if (String(q.secret || '') !== segredo) {
    res.status(403).json({ ok: false, error: 'Segredo invalido.' })
    return
  }

  // Descobre o dominio publico do deploy
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const webhookUrl = process.env.WEBHOOK_URL || 'https://' + host + '/api/webhook'

  if (webhookUrl.indexOf('https://') !== 0) {
    res.status(400).json({ ok: false, error: 'O webhook precisa ser HTTPS.' })
    return
  }

  try {
    if (String(q.consultar || '') === '1') {
      const atual = await bp.consultarWebhook(bp.CONFIG.chavePix)
      res.status(200).json({ ok: true, acao: 'consulta', webhook: atual })
      return
    }

    const resultado = await bp.configurarWebhook(bp.CONFIG.chavePix, webhookUrl)

    res.status(200).json({
      ok: true,
      acao: 'registro',
      webhookUrl: webhookUrl,
      chavePix: bp.CONFIG.chavePix,
      armazenamento: bp.usandoRedis ? 'Upstash Redis' : '/tmp (efemero)',
      resposta: resultado,
      aviso: bp.usandoRedis
        ? null
        : 'Sem Redis configurado. O pagamento ainda e confirmado consultando o BassPago, mas os dados do cliente podem se perder entre execucoes.',
    })
  } catch (e) {
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500
    res.status(status).json({ ok: false, error: e.message })
  }
}
