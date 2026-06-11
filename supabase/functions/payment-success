import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const payload = await req.json()
    console.log('[INFO] Webhook received:', payload.type, payload.invoiceId)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    if (payload.type === 'InvoiceSettled') {
      // Update existing
      const { data: existing } = await supabase
        .from('payments')
        .select('id')
        .eq('invoice_id', payload.invoiceId)
        .single()

      if (existing) {
        const { error } = await supabase
          .from('payments')
          .update({ status: 'settled' })
          .eq('invoice_id', payload.invoiceId)
        if (error) console.error('[DB UPDATE ERROR]:', error)
        else console.log('[INFO] Payment updated to settled:', payload.invoiceId)
      } else {
        // Insert if not found
        const { error } = await supabase
          .from('payments')
          .insert({
            invoice_id: payload.invoiceId,
            amount: payload.payment?.value || 0,
            currency: 'USD',
            status: 'settled',
            customer_email: payload.metadata?.buyerEmail || null
          })
        if (error) console.error('[DB INSERT ERROR]:', error)
        else console.log('[INFO] Payment inserted as settled:', payload.invoiceId)
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('[ERROR]:', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
