/** The public URL of a plaintext upload (avatar, guild icon, banner) by its key (contract §4 Files). No imports: client components use it too. */
export function fileUrl(key: string | null | undefined): string | null {
  return key ? `/api/v1/files/${key}` : null
}
