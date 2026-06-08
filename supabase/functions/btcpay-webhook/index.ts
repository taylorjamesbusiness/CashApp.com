import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req: Request) => {
  try {
    const payload = await req.json()
    
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Handle invoice creation request from frontend
    if (payload.amount && payload.source && !payload.type) {
      const amount = parseFloat(payload.amount)
      const source = payload.source
      const email = payload.email || ''

      if (!amount || amount < 2) {
        return new Response(JSON.stringify({ error: 'Invalid amount' }), { 
          status: 400, 
          headers: { "Content-Type": "application/json" } 
        })
      }

      // Create invoice via BTCPay API
      const btcpayStoreId = Deno.env.get('BTCPAY_STORE_ID') ?? ''
      const btcpayApiKey = Deno.env.get('BTCPAY_API_KEY') ?? ''
      const btcpayUrl = 'https://btcpay684158.lndyn.com' // Update this to your BTCPay server URL

      if (!btcpayStoreId || !btcpayApiKey) {
        return new Response(JSON.stringify({ error: 'BTCPay configuration missing' }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        })
      }

      try {
        // Create invoice in BTCPay
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
          return new Response(JSON.stringify({ error: 'Failed to create invoice at BTCPay' }), { 
            status: 500, 
            headers: { "Content-Type": "application/json" } 
          })
        }

        const invoiceData = await invoiceResponse.json()
        const invoiceId = invoiceData.id
        const lightningCode = invoiceData.paymentMethods?.find((pm: any) => pm.includes('lightning'))?.split(':')[1] || 
                             invoiceData.checkoutLink || 
                             `lightning:${invoiceData.id}`

        // Save payment record to Supabase
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
          console.error('Database insert error:', insertError)
          return new Response(JSON.stringify({ error: 'Failed to save payment record' }), { 
            status: 500, 
            headers: { "Content-Type": "application/json" } 
          })
        }

        return new Response(JSON.stringify({ 
          invoiceId: invoiceId,
          amount: amount,
          lightningCode: lightningCode,
          checkoutLink: invoiceData.checkoutLink
        }), { 
          status: 200, 
          headers: { "Content-Type": "application/json" } 
        })
      } catch (btcpayError) {
        console.error('BTCPay request error:', btcpayError)
        return new Response(JSON.stringify({ error: 'Failed to communicate with BTCPay' }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        })
      }
    }
    
    // Handle webhook from BTCPay for payment settlement
    if (payload.type === 'InvoiceSettled') {
      const invoiceId = payload.invoiceId

      const { error } = await supabase
        .from('payments')
        .update({ status: 'settled' })
        .eq('invoice_id', invoiceId)

      if (error) throw error
    }

    return new Response(JSON.stringify({ received: true }), { 
      status: 200, 
      headers: { "Content-Type": "application/json" } 
    })
  } catch (err) {
    console.error('btcpay-webhook error:', err)
    return new Response(JSON.stringify({ error: 'Invalid request' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }
})
