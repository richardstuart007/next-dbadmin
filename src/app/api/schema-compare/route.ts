import { NextRequest, NextResponse } from 'next/server'
import { compareSchemasFromUrls } from '@/src/actions/schemaSyncActions'

//----------------------------------------------------------------------------------
//  GET — compare schemas between two databases identified by URL strings
//  Query params: url1, url2, label1?, label2?, exclude?
//----------------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const url1    = searchParams.get('url1')
  const url2    = searchParams.get('url2')
  const label1  = searchParams.get('label1') ?? 'Source'
  const label2  = searchParams.get('label2') ?? 'Target'
  const exclude = searchParams.get('exclude') ?? 'bk_,local_,prod_,dev_'

  if (!url1 || !url2) {
    return NextResponse.json({ error: 'url1 and url2 query params are required' }, { status: 400 })
  }

  try {
    const result = await compareSchemasFromUrls({ url1, url2, label1, label2, excludePrefixes: exclude })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
