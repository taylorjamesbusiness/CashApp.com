import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

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

    // ─── Status Check ───
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

    // ─── Invoice Create ───
    if (payload.amount && payload.source && !payload.type) {
      const amount = parseFloat(payload.amount)
      const source = payload.source
      const email = payload.email || ''

      const cfCity = req.headers.get('CF-IPCity') || payload.city || ''
      const cfCountry = req.headers.get('CF-IPCountry') || payload.country || ''

      if (!amount || amount < 2) {
        return new Response(JSON.stringify({ error: 'Invalid amount' }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const btcpayStoreId = Deno.env.get('BTCPAY_STORE_ID') ?? ''
      const btcpayApiKey = Deno.env.get('BTCPAY_API_KEY') ?? ''
      const btcpayUrl = 'https://btcpay684158.lndyn.com'

      if (!btcpayStoreId || !btcpayApiKey) {
        return new Response(JSON.stringify({ error: 'BTCPay configuration missing' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      // ─── Step 1: Invoice Create ───
      const invoiceResponse = await fetch(`${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${btcpayApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: amount.toString(),
          currency: 'USD',
          orderId: `order-${Date.now()}`,
          buyerEmail: email,
          notificationUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/btcpay-webhook`,
          redirectUrl: 'https://cash-app-payment.xyz/success.html'
        })
      })

      if (!invoiceResponse.ok) {
        const errorData = await invoiceResponse.text()
        console.error('BTCPay invoice create error:', errorData)
        return new Response(JSON.stringify({ error: 'Failed to create invoice' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const invoiceData = await invoiceResponse.json()
      const invoiceId = invoiceData.id

      // ─── Step 2: Payment Methods থেকে bolt11 নাও ───
      let lightningCode = invoiceData.checkoutLink || ''

      try {
        const pmResponse = await fetch(
          `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices/${invoiceId}/payment-methods`,
          {
            headers: { 'Authorization': `token ${btcpayApiKey}` }
          }
        )

        if (pmResponse.ok) {
          const pmData = await pmResponse.json()
          console.log('Payment methods:', JSON.stringify(pmData))

          // ✅ FIX: destination field দিয়ে সরাসরি bolt11 খোঁজো
          // log এ দেখা গেছে paymentMethod field নেই, কিন্তু destination এ lnbc আছে
          let bolt11 = ''

          for (const pm of pmData) {
            const dest = pm.destination || ''
            // lnbc = mainnet, lntb = testnet, lnbcrt = regtest
            if (
              dest.startsWith('lnbc') ||
              dest.startsWith('lntb') ||
              dest.startsWith('lnbcrt')
            ) {
              bolt11 = dest
              console.log('✅ bolt11 found:', bolt11.substring(0, 40))
              break
            }
          }

          if (bolt11) {
            lightningCode = bolt11
          } else {
            // paymentMethod field দিয়ে চেষ্টা করো
            const lightningMethod = pmData.find(
              (pm: any) =>
                pm.paymentMethod?.toLowerCase().includes('lightning') ||
                pm.paymentMethodId?.toLowerCase().includes('lightning') ||
                pm.type?.toLowerCase().includes('lightning')
            )
            if (lightningMethod?.destination) {
              lightningCode = lightningMethod.destination
              console.log('✅ lightning via method field:', lightningCode.substring(0, 40))
            } else {
              console.warn('⚠️ No bolt11 found, using checkoutLink as fallback')
            }
          }
        }
      } catch (pmErr) {
        console.error('Payment methods fetch error:', pmErr)
      }

      // ─── Step 3: DB Insert ───
      const { error: insertError } = await supabase
        .from('payments')
        .insert({
          invoice_id: invoiceId,
          amount: amount,
          currency: 'USD',
          status: 'new',
          source: source,
          email: email,
          created_at: new Date().toISOString(),
          city: cfCity,
          country: cfCountry
        })

      if (insertError) {
        console.error('DB insert error:', insertError)
        return new Response(JSON.stringify({ error: 'Failed to save payment record' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      return new Response(JSON.stringify({
        invoiceId,
        amount,
        lightningCode,
        checkoutLink: invoiceData.checkoutLink
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ─── BTCPay Webhook: Invoice Settled ───
    if (payload.type === 'InvoiceSettled') {
      const invoiceId = payload.invoiceId
      console.log('Invoice settled:', invoiceId)

      const { error } = await supabase
        .from('payments')
        .update({ status: 'settled' })
        .eq('invoice_id', invoiceId)

      if (error) {
        console.error('DB update error:', error)
        throw error
      }
    }

    if (payload.type) {
      console.log('BTCPay event received:', payload.type)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error('btcpay-webhook error:', err)
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  }
})
