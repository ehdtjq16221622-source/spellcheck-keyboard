import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: cors })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data, error } = await supabase
      .from('app_notices')
      .select('id, title, body, starts_at, ends_at')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })

    if (error) throw error
    const now = Date.now()
    const notice = (data ?? []).find((item) => {
      const startsAt = item.starts_at ? Date.parse(item.starts_at) : Number.NEGATIVE_INFINITY
      const endsAt = item.ends_at ? Date.parse(item.ends_at) : Number.POSITIVE_INFINITY
      return startsAt <= now && now < endsAt
    })
    // Optional feed: a campaign lookup failure must not hide operational notices.
    let subscriberBenefit: Record<string, unknown> | null = null
    try {
      const campaigns = await supabase.from('subscriber_benefit_campaigns')
        .select('id, app_name, title, body, app_url, starts_at, ends_at')
        .eq('is_active', true).order('updated_at', { ascending: false }).limit(20)
      if (!campaigns.error) {
        const campaign = (campaigns.data ?? []).find(item => {
          const starts = item.starts_at ? Date.parse(item.starts_at) : Number.NEGATIVE_INFINITY
          const ends = item.ends_at ? Date.parse(item.ends_at) : Number.POSITIVE_INFINITY
          try {
            const url = new URL(item.app_url)
            return starts <= now && now < ends && url.protocol === 'https:' &&
              url.hostname === 'apps.apple.com' && !url.username && !url.password && !url.port
          } catch { return false }
        })
        if (campaign) subscriberBenefit = {
          ...campaign,
          starts_at_ms: campaign.starts_at ? Date.parse(campaign.starts_at) : null,
          ends_at_ms: campaign.ends_at ? Date.parse(campaign.ends_at) : null,
        }
      }
    } catch {
      console.warn('subscriber_benefit_feed_unavailable')
    }
    return Response.json(
      notice
        ? { active: true, id: notice.id, title: notice.title, body: notice.body, subscriber_benefit: subscriberBenefit }
        : { active: false, subscriber_benefit: subscriberBenefit },
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load notice.'
    return Response.json(
      { error: message },
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})

