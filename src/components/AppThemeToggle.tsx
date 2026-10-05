import { type AppThemePreference, useAppTheme } from '@/store/app-theme';

const CHOICES: { value: AppThemePreference; label: string; icon: string }[] = [
  { value: 'light', label: '白天', icon: '☀' },
  { value: 'dark', label: '夜间', icon: '☾' },
  { value: 'system', label: '跟随系统', icon: '◐' },
];

/**
 * App 级外观模式切换（REQ-2026-10-05-08）：白天 → 夜间 → 跟随系统循环。
 *
 * 做成单个循环按钮而不是三个并排：阅读页顶栏本来就有五个按钮，
 * 手机上再塞三个会把书名挤没。`compact` 时只留图标（用于阅读页顶栏）。
 */
export default function AppThemeToggle({ compact = false }: { compact?: boolean }) {
  const preference = useAppTheme((s) => s.preference);
  const setPreference = useAppTheme((s) => s.setPreference);

  const index = CHOICES.findIndex((c) => c.value === preference);
  const current = CHOICES[index] ?? CHOICES[0];
  const next = CHOICES[(index + 1) % CHOICES.length] ?? CHOICES[0];
  if (!current || !next) return null;

  return (
    <button
      type="button"
      onClick={() => setPreference(next.value)}
      title={`当前：${current.label}，点击切换到${next.label}`}
      aria-label={`外观模式：${current.label}，点击切换到${next.label}`}
      className="shrink-0 cursor-pointer rounded px-2 py-1 text-sm text-app-muted transition select-none hover:bg-app-hover"
    >
      <span aria-hidden="true">{current.icon}</span>
      {!compact && <span className="ml-1">{current.label}</span>}
    </button>
  );
}
