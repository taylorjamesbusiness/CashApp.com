import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-btcpay-sig",
}

const BTCPAY_URL = 'https://btcpay805858.lndyn.com'
const BTCPAY_STORE_ID = '7tUk4vx8Ej74ETGsbujMPiSKTkisZZawFYfHwkEUqyUj'

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const rawBody = await req.text()

    if (!rawBody || rawBody.trim() === "") {
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const payload = JSON.parse(rawBody)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // ─────────────────────────────────────────
    // 1. STATUS CHECK (frontend polling)
    // ─────────────────────────────────────────
    if (payload.checkStatus && payload.invoiceId) {
      const { data } = await supabase
        .from('payments')
        .select('status')
        .eq('invoice_id', payload.invoiceId)
        .single()

      return new Response(JSON.stringify({ status: data?.status || 'new' }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ─────────────────────────────────────────
    // 2. CREATE INVOICE (frontend → Edge Fn)
    //    payload: { amount, source, email?, paymentType, city?, country? }
    //    paymentType: 'lightning' | 'onchain' | 'usdc'
    // ─────────────────────────────────────────
    if (payload.amount && payload.source && !payload.type) {
      const amount       = parseFloat(payload.amount)
      const source       = payload.source
      const email        = payload.email || ''
      const paymentType  = payload.paymentType || 'lightning'
      const cfCity       = req.headers.get('CF-IPCity')    || payload.city    || ''
      const cfCountry    = req.headers.get('CF-IPCountry') || payload.country || ''

      if (!amount || amount < 2) {
        return new Response(JSON.stringify({ error: 'Minimum amount is $2' }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const btcpayApiKey = Deno.env.get('BTCPAY_API_KEY') ?? ''
      if (!btcpayApiKey) {
        return new Response(JSON.stringify({ error: 'BTCPay API key not configured' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      // ── Decide payment methods for BTCPay ──
      // Lightning  → BTC-LightningNetwork
      // On-chain   → BTC
      // USDC       → Altcoins tab (Exolix handles USDC-SOL → BTC swap)
      let paymentMethods: string[]
      if (paymentType === 'lightning') {
        paymentMethods = ['BTC-LightningNetwork']
      } else if (paymentType === 'onchain') {
        paymentMethods = ['BTC']
      } else {
        // usdc — let BTCPay show Altcoins (Exolix USDC-SOL)
        paymentMethods = ['BTC-LightningNetwork', 'BTC', 'USDC_SOL']
      }

      // ── Create BTCPay Invoice ──
      const invoiceRes = await fetch(
        `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${btcpayApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            amount: amount.toString(),
            currency: 'USD',
            orderId: `order-${Date.now()}`,
            buyerEmail: email || undefined,
            notificationUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/btcpay-webhook`,
            redirectUrl: 'https://cpay-cash.app/success.html',
            checkout: {
              paymentMethods,
              redirectAutomatically: true,
            }
          })
        }
      )

      if (!invoiceRes.ok) {
        const errText = await invoiceRes.text()
        console.error('[BTCPay create invoice error]', errText)
        return new Response(JSON.stringify({ error: 'Failed to create invoice' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const invoiceData = await invoiceRes.json()
      const invoiceId   = invoiceData.id
      console.log('[Invoice created]', invoiceId, 'type:', paymentType)

      // ── Fetch payment methods from BTCPay ──
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
          console.log('[Payment methods]', JSON.stringify(pmData))

          for (const pm of pmData) {
            const dest = pm.destination || ''
            const pmId = (pm.paymentMethodId || pm.paymentMethod || '').toLowerCase()

            // Lightning bolt11
            if (dest.startsWith('lnbc') || dest.startsWith('lntb') || dest.startsWith('lnbcrt')) {
              lightningCode = dest
            }
            // On-chain BTC address
            else if (!dest.startsWith('ln') && dest.length >= 26 && dest.length <= 62 && !pmId.includes('usdc')) {
              btcAddress = dest
            }
            // USDC-SOL (Exolix swap address)
            if (pmId.includes('usdc') || pmId.includes('sol')) {
              usdcAddress = dest
            }
          }
        }
      } catch (pmErr) {
        console.error('[Payment methods fetch error]', pmErr)
      }

      // ── Final payCode based on type ──
      let payCode = ''
      if (paymentType === 'lightning') {
        payCode = lightningCode || invoiceData.checkoutLink
      } else if (paymentType === 'onchain') {
        payCode = btcAddress || invoiceData.checkoutLink
      } else {
        // usdc: return the Exolix swap address (or checkoutLink so user can open BTCPay)
        payCode = usdcAddress || invoiceData.checkoutLink
      }

      // ── Save to DB ──
      const { error: dbErr } = await supabase
        .from('payments')
        .insert({
          invoice_id:   invoiceId,
          amount:       amount,
          currency:     'USD',
          status:       'new',
          payment_type: paymentType,
          source:       source,
          email:        email,
          city:         cfCity,
          country:      cfCountry,
        })

      if (dbErr) {
        console.error('[DB insert error]', dbErr)
        return new Response(JSON.stringify({ error: 'Failed to save payment' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      return new Response(JSON.stringify({
        invoiceId,
        amount,
        paymentType,
        lightningCode,
        btcAddress,
        usdcAddress,
        payCode,
        checkoutLink: invoiceData.checkoutLink,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ─────────────────────────────────────────
    // 3. BTCPAY WEBHOOK (InvoiceSettled etc.)
    // ─────────────────────────────────────────
    if (payload.type) {
      console.log('[BTCPay webhook]', payload.type, payload.invoiceId)

      if (payload.type === 'InvoiceSettled' || payload.type === 'InvoicePaymentSettled') {
        const invoiceId = payload.invoiceId

        const { data: existing } = await supabase
          .from('payments')
          .select('id')
          .eq('invoice_id', invoiceId)
          .single()

        if (existing) {
          const { error } = await supabase
            .from('payments')
            .update({ status: 'settled' })
            .eq('invoice_id', invoiceId)
          if (error) console.error('[DB update error]', error)
          else console.log('[Settled]', invoiceId)
        } else {
          // Insert if not tracked (edge case)
          const { error } = await supabase
            .from('payments')
            .insert({
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
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error('[btcpay-webhook error]', err)
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  }
})
