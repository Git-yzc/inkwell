/**
 * 图片小工具。
 *
 * 目前只服务一件事：PDF 首次打开时把内核渲出的第 1 页缩成封面，
 * 交给 Rust 落盘（REQ-2026-10-05-04 的 Q9）。
 *
 * 为什么在前端缩：整页 PNG 动辄几百 KB，直接过 IPC 太浪费；
 * 缩到 480px 再编码成 JPEG，只有几十 KB，且与 EPUB 封面的规格一致。
 */

/** 送 IPC 的字节数上限：超过它就放弃写封面，免得一次 invoke 传几 MB JSON。 */
const MAX_COVER_BYTES = 120_000;

/**
 * 把图片缩到最长边 `maxEdge` 并编码为 JPEG，返回字节数组（JSON 数组形态，可直接过 IPC）。
 *
 * 带透明通道的图先合成到白底再编码 —— JPEG 没有 alpha，不合成会变黑
 * （与 Rust 侧 `make_thumbnail` 的处理一致）。
 */
export async function toJpegBytes(blob: Blob, maxEdge = 480, quality = 0.85): Promise<number[]> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!out || out.size > MAX_COVER_BYTES) return [];
    return Array.from(new Uint8Array(await out.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}
