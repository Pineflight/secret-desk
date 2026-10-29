/** Beim Serverstart das Portal anlegen, damit die Startadresse sofort im Log steht (nicht erst beim ersten API-Aufruf). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDesk } = await import("./server/desk");
  await getDesk();
}
