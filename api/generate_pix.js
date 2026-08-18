// api/generate_pix.js
// Cria a cobranca Pix no BassPago e devolve o codigo copia e cola.
// POST /api/generate_pix  { amount, name, email, document, phone?, utm_* }

const bp = require('./_basspago')

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Metodo nao permitido.' })
    return
  }

  try {
    const data = await bp.lerBody(req)

    const amount = Math.round((parseFloat(data.amount) || 0) * 100) / 100
    if (amount < 0.01) {
      res.status(400).json({ success: false, error: 'Valor invalido.' })
      return
    }

    const nome = String(data.name || '').trim()
    const email = String(data.email || '').trim()
    const documento = String(data.document || '').replace(/\D/g, '')
    const phone = String(data.phone || '').replace(/\D/g, '')
    const descricao = String(data.descricao || bp.CONFIG.nomeProduto).slice(0, 140)

    const cobranca = {
      calendario: { expiracao: bp.CONFIG.expiracao },
      valor: { original: amount.toFixed(2) },
      chave: bp.CONFIG.chavePix,
      solicitacaoPagador: descricao,
    }

    // Envia o devedor apenas com CPF/CNPJ de tamanho valido
    if (nome && (documento.length === 11 || documento.length === 14)) {
      cobranca.devedor = { nome: nome.slice(0, 200) }
      if (documento.length === 11) {
        cobranca.devedor.cpf = documento
      } else {
        cobranca.devedor.cnpj = documento
      }
    }

    const resposta = await bp.criarCobranca(cobranca)
    const copyPaste = bp.extrairCopiaECola(resposta)
    const txid = resposta.txid || null

    if (!copyPaste || !txid) {
      res.status(502).json({
        success: false,
        error: 'BassPago nao retornou o codigo Pix.',
        details: resposta,
      })
      return
    }

    const trackData = {
      txid: txid,
      valor: (resposta.valor && resposta.valor.original) || amount.toFixed(2),
      descricao: descricao,
      status: 'waiting_paid',
      createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      nome: nome,
      email: email,
      document: documento,
      phone: phone,
      url: data.url || '',
      fbc: data.fbc || '',
      fbp: data.fbp || '',
      utm_source: data.utm_source || '',
      utm_medium: data.utm_medium || '',
      utm_campaign: data.utm_campaign || '',
      utm_content: data.utm_content || '',
      utm_term: data.utm_term || '',
      src: data.src || '',
      sck: data.sck || '',
    }

    await bp.saveTx(txid, trackData)
    await bp.sendUtmify('waiting_payment', trackData)

    res.status(200).json({
      success: true,
      txid: txid,
      id: txid,
      copy_paste: copyPaste,
      qr_code: '',
      amount: trackData.valor,
      expiracao: (resposta.calendario && resposta.calendario.expiracao) || bp.CONFIG.expiracao,
    })
  } catch (e) {
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500
    res.status(status).json({ success: false, error: e.message || 'Erro ao gerar Pix.' })
  }
}
