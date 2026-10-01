import { NextResponse } from 'next/server';
import { scanProducts } from '@/lib/scan';
import { clipSeconds, pricePerSecond, secondsPerVariant } from '@/lib/minimax';
import { guard } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    const root = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!root) throw new Error('Falta DRIVE_ROOT_FOLDER_ID');
    const products = await scanProducts(root, process.env.DRIVE_OUTPUT_FOLDER_ID);
    // La tabla de segundos por cantidad de variantes la usa la página para estimar el costo.
    const counts = Array.from({ length: 15 }, (_, i) => i + 1);
    const clipTable = Object.fromEntries(counts.map((n) => [n, clipSeconds(n)]));
    const perVariantTable = Object.fromEntries(counts.map((n) => [n, secondsPerVariant(n)]));
    return NextResponse.json({ products, pricePerSecond: pricePerSecond(), clipTable, perVariantTable });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
