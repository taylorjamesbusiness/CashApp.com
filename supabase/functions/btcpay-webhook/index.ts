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

      // ── Step 1: BTCPay invoice create ──
      // lightning → Lightning only
      // onchain  → BTC on-chain only
      // usdc     → BTC on-chain only (Exolix needs on-chain address, bolt11 rejected)
      let paymentMethods: string[]
      if (paymentType === 'lightning') {
        paymentMethods = ['BTC-LightningNetwork']
      } else {
        paymentMethods = ['BTC']
      }

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
            const pmId = (pm.paymentMethodId || '').toUpperCase()
            if (dest.startsWith('lnbc') || dest.startsWith('lntb')) {
              lightningCode = dest
            }
            // On-chain: paymentMethodId = 'BTC-CHAIN' or 'BTC', dest is 26-62 chars
            if ((pmId === 'BTC-CHAIN' || pmId === 'BTC') && !dest.startsWith('lnbc') && dest.length >= 26 && dest.length <= 62) {
              btcAddress = dest
            }
          }
          // Fallback: any non-lightning 26-62 char address
          if (!btcAddress) {
            for (const pm of pmData) {
              const dest = (pm.destination || '').trim()
              if (!dest.startsWith('lnbc') && !dest.startsWith('lntb') && dest.length >= 26 && dest.length <= 62) {
                btcAddress = dest
                break
              }
            }
          }
          console.log('[Addresses] lightning:', lightningCode ? lightningCode.substring(0,20) : 'none', 'btc:', btcAddress || 'none')
        }
      } catch (pmErr) {
        console.error('[Payment methods error]', pmErr)
      }

      // If USDC and still no BTC address, try creating a separate BTC-only sub-request
      // by fetching the store's onchain wallet address directly
      if (paymentType === 'usdc' && !btcAddress) {
        try {
          const walletRes = await fetch(
            `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/payment-methods/BTC/wallet/address`,
            { method: 'POST', headers: { 'Authorization': `token ${btcpayApiKey}`, 'Content-Type': 'application/json' }, body: '{}' }
          )
          if (walletRes.ok) {
            const walletData = await walletRes.json()
            btcAddress = walletData.address || ''
            console.log('[BTC wallet address fallback]', btcAddress)
          } else {
            const t = await walletRes.text()
            console.error('[BTC wallet address error]', t)
          }
        } catch(we) {
          console.error('[BTC wallet fetch error]', we)
        }
      }

      // ── Step 3: USDC → Exolix API directly ──
      let usdcAddress = ''
      let exolixSwapId = ''

      if (paymentType === 'usdc') {
        // Exolix minimum swap: ~$49 USD. Warn if below.
        if (amount < 49) console.warn('[USDC] Amount', amount, 'may be below Exolix minimum (~$49)')
        // Exolix requires an amount-less withdrawal address.
        // Lightning bolt11 has a fixed amount → Exolix rejects it.
        // Solution: use BTC on-chain address as withdrawal → Exolix sends BTC on-chain → BTCPay settles invoice.
        const withdrawalAddr = btcAddress

        if (!withdrawalAddr) {
          console.error('[USDC] No BTC on-chain address from BTCPay')
        } else {
          try {
            // Exolix API: USDC (SOL) → BTC (on-chain)
            const exolixRes = await fetch(`${EXOLIX_API}/transactions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                coinFrom: 'USDC',
                networkFrom: 'SOL',
                coinTo: 'BTC',
                networkTo: 'BTC',
                amount: amount,          // USDC amount (1 USDC ≈ 1 USD)
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
