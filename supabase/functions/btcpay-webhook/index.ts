import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, btcpay-sig",
}

const BTCPAY_URL = 'https://btcpay805858.lndyn.com'
const BTCPAY_STORE_ID = '7tUk4vx8Ej74ETGsbujMPiSKTkisZZawFYfHwkEUqyUj'
const EXOLIX_API = 'https://exolix.com/api/v2'

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
      const amount = parseFloat(payload.amount)
      const source = payload.source
      const email = payload.email || ''
      const paymentType = payload.paymentType || 'lightning'
      
      const cfCity = req.headers.get('CF-IPCity') || payload.city || ''
      const cfCountry = req.headers.get('CF-IPCountry') || payload.country || ''

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

      let paymentMethods: string[]
      if (paymentType === 'lightning' || paymentType === 'usdc') {
        // BTCPay v2.0+ এর জন্য 'BTC-LN', পুরোনো সংস্করণের জন্য 'BTC-LightningNetwork'
        paymentMethods = ['BTC-LN', 'BTC-LightningNetwork'] 
      } else if (paymentType === 'onchain') {
        // BTCPay v2.0+ এর জন্য 'BTC-CHAIN', পুরোনো সংস্করণের জন্য 'BTC'
        paymentMethods = ['BTC-CHAIN', 'BTC'] 
      } else {
        paymentMethods = ['BTC-LN', 'BTC-LightningNetwork', 'BTC-CHAIN', 'BTC']
      }

      // Create BTCPay Invoice
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
            redirectUrl: 'https://cpay-cash.app',
            checkout: {
              paymentMethods,
              expirationMinutes: 60,
            }
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
      const invoiceId = invoiceData.id
      console.log('[Invoice created]', invoiceId, 'type:', paymentType)

      // Get payment methods from BTCPay
      let lightningCode = ''
      let btcAddress = ''
      let btcDue = 0

      try {
        const pmRes = await fetch(
          `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoiceId}/payment-methods`,
          { headers: { 'Authorization': `token ${btcpayApiKey}` } }
        )
        if (pmRes.ok) {
          const pmData = await pmRes.json()
          for (const pm of pmData) {
            const dest = (pm.destination || '').trim()
            if (dest.startsWith('lnbc') || dest.startsWith('lntb')) {
              lightningCode = dest
              btcDue = parseFloat(pm.due || pm.amount || '0')
            } else if (dest.length >= 26 && dest.length <= 62) {
              btcAddress = dest
              if (!btcDue) btcDue = parseFloat(pm.due || pm.amount || '0')
            }
          }
        }
      } catch (pmErr) {
        console.error('[PM error]', pmErr)
      }

      // USDC: Call Exolix API directly
      let usdcAddress = ''
      let exolixSwapId = ''
      let usdcAmountNeeded = '0'

      if (paymentType === 'usdc') {
        if (!lightningCode || !btcDue) {
          return new Response(JSON.stringify({ error: 'Lightning invoice not available. Please try again.' }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
          })
        }

        try {
          const exolixRes = await fetch(`${EXOLIX_API}/transactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              coinFrom: 'USDC',
              networkFrom: 'SOL',
              coinTo: 'BTC',
              networkTo: 'LIGHTNING',
              amountTo: btcDue,
              withdrawalAddress: lightningCode,
              rateType: 'float',
            })
          })

          if (exolixRes.ok) {
            const exolixData = await exolixRes.json()
            usdcAddress = exolixData.depositAddress || ''
            exolixSwapId = exolixData.id || ''
            usdcAmountNeeded = String(exolixData.amount || '0')
          } else {
  
const
 errBody = 
await
 exolixRes.text().catch(
() =>
 
''
)
  
console
.error(
'[Exolix failed]'
, exolixRes.status, errBody)
  
return
 
new
 Response(
JSON
.stringify({
    
error
: 
'Exolix swap failed'
,
    
status
: exolixRes.status,
    
details
: errBody,
  }), {
    
status
: 
502
,
    
headers
: { ...corsHeaders, 
"Content-Type"
: 
"application/json"
 }
  })
}

      // Save to DB
      const { error: dbErr } = await supabase
        .from('payments')
        .insert({
          invoice_id: invoiceId,
          amount,
          currency: 'USD',
          status: 'new',
          payment_type: paymentType,
          source,
          email,
          city: cfCity,
          country: cfCountry,
          swap_id: exolixSwapId || null,
        })
      
      if (dbErr) {
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
        usdcAmountNeeded,
        exolixSwapId,
        checkoutLink: invoiceData.checkoutLink,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // ══════════════════════════════════════════
    // 3. BTCPAY WEBHOOK (Secured with Signature)
    // ══════════════════════════════════════════
    if (payload.type) {
      console.log('[Webhook Processing]', payload.type, payload.invoiceId)
      
      const webhookSecret = Deno.env.get('BTCPAY_WEBHOOK_SECRET')
      
      // শুধুমাত্র যদি secret দেওয়া থাকে তবেই ভেরিফাই করবে (না হলে স্কিপ করে যাবে)
      if (webhookSecret) {
        const sigHeader = req.headers.get('btcpay-sig')
        
        if (!sigHeader || !sigHeader.startsWith('sha256=')) {
          console.error('[Webhook Error] Missing or invalid btcpay-sig header')
          return new Response(JSON.stringify({ error: 'Unauthorized webhook' }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
          })
        }

        // HMAC-SHA256 ক্যালকুলেট করা
        const encoder = new TextEncoder()
        const signKey = await crypto.subtle.importKey(
          "raw",
          encoder.encode(webhookSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        )
        
        // রিকুয়েস্টের অরিজিনাল rawBody থেকে সিগনেচার তৈরি 
        const macBuffer = await crypto.subtle.sign("HMAC", signKey, encoder.encode(rawBody))
        const macHex = Array.from(new Uint8Array(macBuffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
        
        // সিগনেচার ম্যাচ না করলে ব্লক করে দেবে
        if (`sha256=${macHex}` !== sigHeader) {
          console.error('[Webhook Error] Signature mismatch')
          return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
          })
        }
        
        console.log('[Webhook Signature] Verified Successfully')
      } else {
        console.warn('[Webhook Warning] BTCPAY_WEBHOOK_SECRET is not set. Skipping signature verification.')
      }

      // ── Process Webhook Event ──
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
            payment_type: payload.payment?.paymentMethodId?.includes('LN') ? 'lightning' : 'onchain',
            source: 'webhook',
          })
        }
      }

      if (payload.type === 'InvoiceExpired') {
        await supabase.from('payments')
          .update({ status: 'expired' })
          .eq('invoice_id', payload.invoiceId)
          .eq('status', 'new')
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
