export async function requireCurrentUser(): Promise<
  { ok: true; user: { id?: string } } | { ok: false; status: number }
> {
  const response = await fetch("https://fnf.internal/user");
  if (!response.ok) return { ok: false, status: response.status };
  const user = (await response.json().catch(() => ({}))) as { id?: string };
  return { ok: true, user };
}
