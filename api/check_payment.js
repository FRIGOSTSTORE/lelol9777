// api/check_payment.js
// Verifica se o Pix foi pago.
// GET /api/check_payment?txid=...   (aceita tambem ?id=...)

const bp = require('./_basspago')

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  const q = req.query || {}
  const txid = String(q.txid || q.id || '').replace(/[^a-zA-Z0-9]/g, '')

  if (!txid) {
    res.status(400).json({ success: false, error: 'txid ausente.' })
    return
  }

  const txData = await bp.loadTx(txid)

  // Se o webhook ja confirmou, responde direto
  if (txData && txData.status === 'paid') {
    res.status(200).json({
      success: true,
      paid: true,
      status: 'paid',
      amount: txData.valor || 0,
      name: txData.nome || 'Cliente',
    })
    return
  }

  // Fallback: consulta a cobranca no BassPago (funciona mesmo sem webhook)
  try {
    const cob = await bp.consultarCobranca(txid)
    const statusApi = String(cob.status || 'ATIVA').toUpperCase()
    const pagamentos = Array.isArray(cob.pix) ? cob.pix : []

    const pago =
      ['CONCLUIDA', 'COMPLETED', 'PAID'].indexOf(statusApi) !== -1 || pagamentos.length > 0

    let valor = (cob.valor && cob.valor.original) || (txData && txData.valor) || 0

    if (pago) {
      const pagamento = pagamentos[0] || {}
      if (pagamento.valor) valor = pagamento.valor

      const atualizado = Object.assign({}, txData, {
        txid: txid,
        valor: valor,
        status: 'paid',
        paidAt: pagamento.horario
          ? new Date(pagamento.horario).toISOString().slice(0, 19).replace('T', ' ')
          : new Date().toISOString().slice(0, 19).replace('T', ' '),
        endToEndId: pagamento.endToEndId || null,
      })

      await bp.saveTx(txid, atualizado)

      // Dispara paid na UTMify apenas na primeira confirmacao
      if (!txData || txData.status !== 'paid') {
        await bp.sendUtmify('paid', atualizado)
      }

      res.status(200).json({
        success: true,
        paid: true,
        status: 'paid',
        amount: valor,
        name: atualizado.nome || 'Cliente',
      })
      return
    }

    res.status(200).json({
      success: true,
      paid: false,
      status: statusApi.toLowerCase(),
      amount: valor,
      name: (txData && txData.nome) || 'Cliente',
    })
  } catch (e) {
    // Falha de consulta nao deve quebrar o polling do checkout
    res.status(200).json({
      success: true,
      paid: false,
      status: 'pending',
      amount: (txData && txData.valor) || 0,
      name: (txData && txData.nome) || 'Cliente',
    })
  }
}
