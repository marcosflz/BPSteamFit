export const MEDIA_SCHEME = 'bps-media'

export function buildMediaUrl(assetId: string, variant = 'preview'): string {
  return `${MEDIA_SCHEME}://asset/${encodeURIComponent(assetId)}?variant=${encodeURIComponent(variant)}`
}
