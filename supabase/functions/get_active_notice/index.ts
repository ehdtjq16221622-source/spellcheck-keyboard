import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const noticeBody =
  '앱스토어 리뷰는 킹보드에 큰 힘이 됩니다.\n\n' +
  '사용 중 불편한 점이나 개선 의견을 개발자 인스타그램 DM으로 보내주시면 최대한 빠른 시일 내로 수정하겠습니다.\n\n' +
  '앱스토어에 별점과 함께 리뷰를 작성한 뒤 개발자 인스타그램으로 DM주시면 크레딧 1,000개를 무료 지급하고 있습니다.'

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
    return Response.json(
      notice
        ? { active: true, id: notice.id, title: notice.title, body: noticeBody }
        : { active: false },
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
