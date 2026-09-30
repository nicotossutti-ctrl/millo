import { NextResponse } from 'next/server';
import { queryVideo } from '@/lib/minimax';
import { guard } from '@/lib/guard';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  try {
    const { taskIds } = (await req.json()) as { taskIds: string[] };
    const tasks = await Promise.all((taskIds || []).map((id) => queryVideo(id)));
    return NextResponse.json({ tasks });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
