/** 一些与业务无关的小工具。 */

/** 1536 -> "1.5 KB" */
export function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Unix 秒 -> "3 分钟前" / "昨天" / "2026-09-19" */
export function formatRelative(unixSecs: number | null): string {
  if (!unixSecs) return '从未打开';
  const diff = Date.now() / 1000 - unixSecs;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 2) return '昨天';
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(unixSecs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 0.42 -> "42%" */
export function formatPercent(pct: number): string {
  return `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`;
}
