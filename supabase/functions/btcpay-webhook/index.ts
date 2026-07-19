import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, btcpay-sig",
}

const BTCPAY_URL = 'https://btcpay805858.lndyn.com'
const BTCPAY_STORE_ID = '7tUk4vx8Ej74ETGsbujMPiSKTkisZZawFYfHwkEUqyUj'

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const rawBody = await req.text()
    const payload = rawBody ? JSON.parse(rawBody) : {}

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    )

    // ✅ STATUS CHECK
    if (payload.checkStatus && payload.invoiceId) {
      const { data } = await supabase
        .from('payments')
        .select('status')
        .eq('invoice_id', payload.invoiceId)
        .single()

      return new Response(
        JSON.stringify({ status: data?.status || 'pending' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // ✅ CREATE INVOICE
    if (payload.amount && payload.source && !payload.type) {

      const amount = parseFloat(payload.amount)
      const source = payload.source
      const brand = payload.brand
      const email = payload.email || ''
      const paymentType = payload.paymentType || 'lightning'

      const cfCity = req.headers.get('CF-IPCity') || payload.city || ''
      const cfCountry = req.headers.get('CF-IPCountry') || payload.country || ''

      if (!brand) {
        return new Response(JSON.stringify({ error: 'Brand required' }), { status: 400 })
      }

      // ✅ BRAND LOOKUP
      const { data: brandRow } = await supabase
        .from('brands')
        .select('id')
        .eq('name', brand)
        .single()

      if (!brandRow) {
        return new Response(JSON.stringify({ error: 'Invalid brand' }), { status: 400 })
      }

      if (!amount || amount < 2) {
        return new Response(JSON.stringify({ error: 'Minimum amount is $2' }), { status: 400 })
      }

      const btcpayApiKey = Deno.env.get('BTCPAY_API_KEY') ?? ''

      let paymentMethods: string[] = ['BTC-LN', 'BTC-LightningNetwork']

      const invoiceRes = await fetch(`${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`, {
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
          redirectUrl: source,
          checkout: { paymentMethods, expirationMinutes: 60 }
        })
      })

      const invoiceData = await invoiceRes.json()
      const invoiceId = invoiceData.id

      // ✅ LIGHTNING CODE
      let lightningCode = ''

      try {
        const pmRes = await fetch(`${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoiceId}/payment-methods`, {
          headers: { 'Authorization': `token ${btcpayApiKey}` }
        })

        if (pmRes.ok) {
          const pmData = await pmRes.json()
          for (const pm of pmData) {
            const dest = (pm.destination || '').trim()
            if (dest.startsWith('lnbc') || dest.startsWith('lntb')) {
              lightningCode = dest
            }
          }
        }
      } catch (e) {}

      // ✅ INSERT PAYMENT
      await supabase.from('payments').insert({
        payment_uuid: crypto.randomUUID(),
        invoice_id: invoiceId,
        amount,
        currency: 'USD',
        status: 'pending',
        approval_status: 'pending',
        payment_type: paymentType,
        source,
        brand,
        brand_id: brandRow.id,
        email,
        city: cfCity,
        country: cfCountry
      })

      return new Response(JSON.stringify({
        invoiceId,
        amount,
        paymentType,
        lightningCode,
        checkoutLink: invoiceData.checkoutLink
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ✅ WEBHOOK EVENTS
    if (payload.type) {

      if (payload.type === 'InvoiceSettled' || payload.type === 'InvoicePaymentSettled') {

        await supabase
          .from('payments')
          .update({
            status: 'settled',
            paid_at: new Date().toISOString()
          })
          .eq('invoice_id', payload.invoiceId)
      }

      if (payload.type === 'InvoiceExpired') {
        await supabase
          .from('payments')
          .update({ status: 'expired' })
          .eq('invoice_id', payload.invoiceId)
      }

      return new Response(JSON.stringify({ ok: true }))
    }

    return new Response(JSON.stringify({ ok: true }))

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 })
  }
})
