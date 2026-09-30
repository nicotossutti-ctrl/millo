export const metadata = { title: 'SOX · Entrar' };

export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  return (
    <main style={{ maxWidth: 380 }}>
      <h1>SOX · Videos 360°</h1>
      <form className="card" method="post" action="/api/login">
        <p>Contraseña de la app</p>
        <div className="row">
          <input type="password" name="password" autoFocus required autoComplete="current-password" />
          <button type="submit">Entrar</button>
        </div>
        {e && <p className="err">Contraseña incorrecta.</p>}
      </form>
    </main>
  );
}
