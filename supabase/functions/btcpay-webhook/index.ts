import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-btcpay-sig",
}

const BTCPAY_URL      = 'https://btcpay805858.lndyn.com'
const BTCPAY_STORE_ID = '7tUk4vx8Ej74ETGsbujMPiSKTkisZZawFYfHwkEUqyUj'

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const rawBody = await req.text()
    if (!rawBody || rawBody.trim() === "") {
      return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const payload = JSON.parse(rawBody)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // ══════════════════════════════════════════
    // 1. STATUS CHECK
    // ══════════════════════════════════════════
    if (payload.checkStatus && payload.invoiceId) {
      const { data } = await supabase
        .from('payments')
        .select('status')
        .eq('invoice_id', payload.invoiceId)
        .single()
      return new Response(JSON.stringify({ status: data?.status || 'new' }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ══════════════════════════════════════════
    // 2. CREATE INVOICE
    //    paymentType: 'lightning' | 'onchain' | 'usdc'
    // ══════════════════════════════════════════
    if (payload.amount && payload.source && !payload.type) {
      const amount      = parseFloat(payload.amount)
      const source      = payload.source
      const email       = payload.email || ''
      const paymentType = payload.paymentType || 'lightning'
      const cfCity      = req.headers.get('CF-IPCity')    || payload.city    || ''
      const cfCountry   = req.headers.get('CF-IPCountry') || payload.country || ''

      if (!amount || amount < 2) {
        return new Response(JSON.stringify({ error: 'Minimum amount is $2' }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const btcpayApiKey = Deno.env.get('BTCPAY_API_KEY') ?? ''
      if (!btcpayApiKey) {
        return new Response(JSON.stringify({ error: 'BTCPay API key not configured' }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      // ── PaymentMethods for BTCPay ──
      // USDC: Exolix plugin automatically adds altcoin options to every invoice.
      // We just need to allow BTC+Lightning — Exolix handles USDC-SOL tab on its own.
      // DO NOT pass 'USDC_SOL' or any Exolix-specific string — BTCPay rejects it.
      let paymentMethods: string[]
      if (paymentType === 'lightning') {
        paymentMethods = ['BTC-LightningNetwork']
      } else if (paymentType === 'onchain') {
        paymentMethods = ['BTC']
      } else {
        // usdc: include both so Exolix has room to attach its altcoin method
        paymentMethods = ['BTC-LightningNetwork', 'BTC']
      }

      // ── Create BTCPay Invoice ──
      const invoiceRes = await fetch(
        `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`,
        {
          method: 'POST',
          headers: { 'Authorization': `token ${btcpayApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: amount.toString(),
            currency: 'USD',
            orderId: `order-${Date.now()}`,
            buyerEmail: email || undefined,
            notificationUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/btcpay-webhook`,
            redirectUrl: 'https://cpay-cash.app/success.html',
            checkout: { paymentMethods }
          })
        }
      )

      if (!invoiceRes.ok) {
        const errText = await invoiceRes.text()
        console.error('[BTCPay create invoice error]', errText)
        return new Response(JSON.stringify({ error: 'Failed to create invoice' }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const invoiceData = await invoiceRes.json()
      const invoiceId   = invoiceData.id
      console.log('[Invoice created]', invoiceId, 'type:', paymentType)

      // ── Fetch payment-methods from BTCPay ──
      // Wait a moment so Exolix plugin can attach the USDC-SOL method
      if (paymentType === 'usdc') await new Promise(r => setTimeout(r, 1500))

      let lightningCode = ''
      let btcAddress    = ''
      let usdcAddress   = ''

      try {
        const pmRes = await fetch(
          `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoiceId}/payment-methods`,
          { headers: { 'Authorization': `token ${btcpayApiKey}` } }
        )
        if (pmRes.ok) {
          const pmData = await pmRes.json()
          console.log('[Payment methods raw]', JSON.stringify(pmData))

          for (const pm of pmData) {
            const dest = (pm.destination || '').trim()
            const pmId = (pm.paymentMethodId || pm.paymentMethod || pm.cryptoCode || '').toLowerCase()

            // Lightning bolt11
            if (dest.startsWith('lnbc') || dest.startsWith('lntb') || dest.startsWith('lnbcrt')) {
              lightningCode = dest
              console.log('[Lightning found]', dest.substring(0, 30))
              continue
            }

            // USDC / Exolix swap deposit address (long base58/hex, identified by pmId)
            if (pmId.includes('usdc') || pmId.includes('exolix') || pmId.includes('sol')) {
              usdcAddress = dest
              console.log('[USDC/Exolix addr found]', dest)
              continue
            }

            // On-chain BTC (26–62 chars, not lightning, not usdc)
            if (dest.length >= 26 && dest.length <= 62) {
              btcAddress = dest
              console.log('[BTC onchain found]', dest)
            }
          }

          // Fallback: if usdcAddress not found by pmId, try Solana address heuristic
          // Solana addresses are base58, 32–44 chars
          if (!usdcAddress && paymentType === 'usdc') {
            for (const pm of pmData) {
              const dest = (pm.destination || '').trim()
              if (dest.length >= 32 && dest.length <= 44 && !dest.startsWith('lnbc') && dest !== btcAddress) {
                usdcAddress = dest
                console.log('[USDC fallback addr]', dest)
                break
              }
            }
          }
        }
      } catch (pmErr) {
        console.error('[Payment methods fetch error]', pmErr)
      }

      // ── Save to DB ──
      const { error: dbErr } = await supabase
        .from('payments')
        .insert({
          invoice_id:   invoiceId,
          amount,
          currency:     'USD',
          status:       'new',
          payment_type: paymentType,
          source,
          email,
          city:         cfCity,
          country:      cfCountry,
        })
      if (dbErr) {
        console.error('[DB insert error]', dbErr)
        return new Response(JSON.stringify({ error: 'Failed to save payment' }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      return new Response(JSON.stringify({
        invoiceId,
        amount,
        paymentType,
        lightningCode,
        btcAddress,
        usdcAddress,
        checkoutLink: invoiceData.checkoutLink,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ══════════════════════════════════════════
    // 3. BTCPAY WEBHOOK (InvoiceSettled)
    // ══════════════════════════════════════════
    if (payload.type) {
      console.log('[BTCPay webhook]', payload.type, payload.invoiceId)

      if (payload.type === 'InvoiceSettled' || payload.type === 'InvoicePaymentSettled') {
        const invoiceId = payload.invoiceId

        const { data: existing } = await supabase
          .from('payments').select('id').eq('invoice_id', invoiceId).single()

        if (existing) {
          const { error } = await supabase
            .from('payments').update({ status: 'settled' }).eq('invoice_id', invoiceId)
          if (error) console.error('[DB update error]', error)
          else console.log('[Settled]', invoiceId)
        } else {
          const { error } = await supabase
            .from('payments').insert({
              invoice_id:   invoiceId,
              amount:       payload.payment?.value || 0,
              currency:     'USD',
              status:       'settled',
              payment_type: 'unknown',
              source:       'webhook',
            })
          if (error) console.error('[DB insert error on webhook]', error)
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error('[btcpay-webhook error]', err)
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  }
})
