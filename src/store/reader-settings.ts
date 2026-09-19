/**
 * 阅读外观设置，持久化在本地。
 *
 * 用 localStorage 而不是后端 settings 表：这些是纯展示偏好，
 * 丢了也只是回到默认值，不值得为它多一次 IPC 往返。
 * （注意：**密钥类**信息绝不能放这里，见 AGENTS.md 铁律 5。）
 */
import { create } from 'zustand';

import { DEFAULT_SETTINGS, type RendererSettings } from '@/features/reader/engine/types';

const STORAGE_KEY = 'inkwell.reader.settings.v1';

function load(): RendererSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<RendererSettings>;
    // 与默认值合并：将来新增字段时旧数据也不会缺项
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(s: RendererSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 无痕模式等场景写不进去，忽略即可
  }
}

interface ReaderSettingsState {
  settings: RendererSettings;
  update: (patch: Partial<RendererSettings>) => void;
  reset: () => void;
}

export const useReaderSettings = create<ReaderSettingsState>((set, get) => ({
  settings: load(),
  update: (patch) => {
    const next = { ...get().settings, ...patch };
    persist(next);
    set({ settings: next });
  },
  reset: () => {
    persist(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
  },
}));
