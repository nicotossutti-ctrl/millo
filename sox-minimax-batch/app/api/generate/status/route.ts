import { NextResponse } from 'next/server';
import { queryVideo } from '@/lib/minimax';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { taskIds } = (await req.json()) as { taskIds: string[] };
    const tasks = await Promise.all((taskIds || []).map((id) => queryVideo(id)));
    return NextResponse.json({ tasks });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
