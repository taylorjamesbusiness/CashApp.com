import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

serve(async (req: Request) => {
  // CORS preflight — body নেই, তাই আগেই handle করো
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    // ✅ FIX: req.text() দিয়ে আগে নাও, তারপর parse করো
    const rawBody = await req.text()

    if (!rawBody || rawBody.trim() === "") {
      // BTCPay ping/test webhook — empty body, gracefully handle
      console.warn("Empty body received")
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const payload = JSON.parse(rawBody) // ✅ safe parse

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // ─── Frontend থেকে Invoice Create Request ───
    if (payload.amount && payload.source && !payload.type) {
      const amount = parseFloat(payload.amount)
      const source = payload.source
      const email = payload.email || ''

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
        console.error('BTCPay API error:', errorData)
        return new Response(JSON.stringify({ error: 'Failed to create invoice' }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const invoiceData = await invoiceResponse.json()
      const invoiceId = invoiceData.id

      // ✅ FIX: paymentMethods সঠিকভাবে parse করো
      const lightningMethod = invoiceData.paymentMethods?.find(
        (pm: any) => pm.paymentMethod?.toLowerCase().includes('lightning')
      )
      const lightningCode = lightningMethod?.destination || invoiceData.checkoutLink || ''

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
          city: payload.city || '',
          country: payload.country || ''
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

    // ─── BTCPay Webhook: Payment Settled ───
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

    // BTCPay অন্য event types (InvoiceCreated, InvoiceExpired etc.)
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
