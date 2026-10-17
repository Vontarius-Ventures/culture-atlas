import { redirect } from 'next/navigation';

/** SCREEN-CONTRACT names /library/:id; PRODUCT-AND-ARCHITECTURE names /library/media/{id}. Both work. */
export default async function LibraryItemRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/library/media/${encodeURIComponent(id)}`);
}
