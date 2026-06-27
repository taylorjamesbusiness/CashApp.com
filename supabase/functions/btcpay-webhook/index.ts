import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-btcpay-sig",
}

const BTCPAY_URL      = 'https://btcpay805858.lndyn.com'
const BTCPAY_STORE_ID = '7tUk4vx8Ej74ETGsbujMPiSKTkisZZawFYfHwkEUqyUj'
const EXOLIX_API      = 'https://exolix.com/api/v2'

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
    // ══════════════════════════════════════════
    if (payload.amount && payload.source && !payload.type) {
      const amount      = parseFloat(payload.amount)
      const source      = payload.source
      const email       = payload.email || ''
      const paymentType = payload.paymentType || 'lightning'
      const cfCity      = req.headers.get('CF-IPCity')    || payload.city    || ''
      const cfCountry   = req.headers.get('CF-IPCountry') || payload.country || ''

      if (!amount || amount < 10) {
        return new Response(JSON.stringify({ error: 'Minimum amount is $10 for USDC swap' }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const btcpayApiKey = Deno.env.get('BTCPAY_API_KEY') ?? ''
      if (!btcpayApiKey) {
        return new Response(JSON.stringify({ error: 'BTCPay API key not configured' }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      // ── Step 1: BTCPay invoice create ──
      const paymentMethods = paymentType === 'onchain'
        ? ['BTC']
        : ['BTC-LightningNetwork', 'BTC']

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

      // ── Step 2: Get BTCPay payment methods ──
      let lightningCode = ''
      let btcAddress    = ''

      try {
        const pmRes = await fetch(
          `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoiceId}/payment-methods`,
          { headers: { 'Authorization': `token ${btcpayApiKey}` } }
        )
        if (pmRes.ok) {
          const pmData = await pmRes.json()
          console.log('[Payment methods]', JSON.stringify(pmData))
          for (const pm of pmData) {
            const dest = (pm.destination || '').trim()
            if (dest.startsWith('lnbc') || dest.startsWith('lntb')) {
              lightningCode = dest
            } else if (dest.length >= 26 && dest.length <= 62) {
              btcAddress = dest
            }
          }
        }
      } catch (pmErr) {
        console.error('[Payment methods error]', pmErr)
      }

      // ── Step 3: USDC → Exolix API directly ──
      let usdcAddress = ''
      let exolixSwapId = ''

      if (paymentType === 'usdc') {
        // withdrawal address = lightning invoice (Exolix pays out via Lightning)
        const withdrawalAddr = lightningCode || btcAddress
        const withdrawalNetwork = lightningCode ? 'LIGHTNING' : 'BTC'

        if (!withdrawalAddr) {
          console.error('[USDC] No withdrawal address from BTCPay')
        } else {
          try {
            // Exolix API: create exchange
            // USDC (SOL) → BTC (Lightning)
            const exolixRes = await fetch(`${EXOLIX_API}/transactions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                coinFrom: 'USDC',
                networkFrom: 'SOL',
                coinTo: 'BTC',
                networkTo: withdrawalNetwork,
                amount: amount,        // USD amount = USDC amount (1:1)
                withdrawalAddress: withdrawalAddr,
                rateType: 'float',
              })
            })

            if (exolixRes.ok) {
              const exolixData = await exolixRes.json()
              console.log('[Exolix swap]', JSON.stringify(exolixData))
              usdcAddress  = exolixData.depositAddress || ''
              exolixSwapId = exolixData.id || ''
              console.log('[Exolix deposit addr]', usdcAddress, 'swapId:', exolixSwapId)
            } else {
              const errText = await exolixRes.text()
              console.error('[Exolix API error]', errText)
            }
          } catch (exErr) {
            console.error('[Exolix fetch error]', exErr)
          }
        }
      }

      // ── Step 4: Save to DB ──
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
          swap_id:      exolixSwapId || null,
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
        exolixSwapId,
        checkoutLink: invoiceData.checkoutLink,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ══════════════════════════════════════════
    // 3. BTCPAY WEBHOOK
    // ══════════════════════════════════════════
    if (payload.type) {
      console.log('[BTCPay webhook]', payload.type, payload.invoiceId)

      if (payload.type === 'InvoiceSettled' || payload.type === 'InvoicePaymentSettled') {
        const invoiceId = payload.invoiceId
        const { data: existing } = await supabase
          .from('payments').select('id').eq('invoice_id', invoiceId).single()

        if (existing) {
          await supabase.from('payments').update({ status: 'settled' }).eq('invoice_id', invoiceId)
          console.log('[Settled]', invoiceId)
        } else {
          await supabase.from('payments').insert({
            invoice_id: invoiceId,
            amount: payload.payment?.value || 0,
            currency: 'USD',
            status: 'settled',
            payment_type: 'unknown',
            source: 'webhook',
          })
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
