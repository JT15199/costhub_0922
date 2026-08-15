// Premium Utilitarian Minimalist 主题系统
export interface Theme {
  name: string;
  label: string;
  colors: {
    // 主色（用于CTA和强调）
    primary: string;
    primaryHover: string;
    primaryActive: string;

    // 背景色（warm monochrome）
    canvas: string;          // 画布背景
    surface: string;         // 卡片表面
    elevated: string;        // 悬浮层

    // 文字色（高对比度）
    textPrimary: string;     // 主要文字 off-black
    textSecondary: string;   // 次要文字 muted gray
    textTertiary: string;    // 三级文字

    // 结构色（ultra-light）
    border: string;          // 边框 #EAEAEA
    divider: string;         // 分隔线

    // Muted Pastels（语义色）
    accentRed: string;
    accentRedBg: string;
    accentBlue: string;
    accentBlueBg: string;
    accentGreen: string;
    accentGreenBg: string;
    accentYellow: string;
    accentYellowBg: string;

    // 状态色
    success: string;
    error: string;
    warning: string;
    info: string;

    // 阴影（ultra-subtle）
    shadowCard: string;
    shadowHover: string;
  };
  typography: {
    fontSans: string;
    fontSerif: string;
    fontMono: string;
  };
}

export const themes: Record<string, Theme> = {
  red: {
    name: 'red',
    label: '经典红',
    colors: {
      primary: '#CF0A2C',
      primaryHover: '#A50823',
      primaryActive: '#8A0620',

      canvas: '#FBFBFA',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#111111',
      textSecondary: '#787774',
      textTertiary: '#A8A8A5',

      border: '#EAEAEA',
      divider: 'rgba(0,0,0,0.06)',

      accentRed: '#9F2F2D',
      accentRedBg: '#FDEBEC',
      accentBlue: '#1F6C9F',
      accentBlueBg: '#E1F3FE',
      accentGreen: '#346538',
      accentGreenBg: '#EDF3EC',
      accentYellow: '#956400',
      accentYellowBg: '#FBF3DB',

      success: '#346538',
      error: '#CF0A2C',
      warning: '#956400',
      info: '#1F6C9F',

      shadowCard: '0 0 0 rgba(0,0,0,0)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.04)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  blue: {
    name: 'blue',
    label: '科技蓝',
    colors: {
      primary: '#1F6C9F',
      primaryHover: '#175782',
      primaryActive: '#0F4366',

      canvas: '#FBFBFA',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#111111',
      textSecondary: '#787774',
      textTertiary: '#A8A8A5',

      border: '#EAEAEA',
      divider: 'rgba(0,0,0,0.06)',

      accentRed: '#9F2F2D',
      accentRedBg: '#FDEBEC',
      accentBlue: '#1F6C9F',
      accentBlueBg: '#E1F3FE',
      accentGreen: '#346538',
      accentGreenBg: '#EDF3EC',
      accentYellow: '#956400',
      accentYellowBg: '#FBF3DB',

      success: '#346538',
      error: '#9F2F2D',
      warning: '#956400',
      info: '#1F6C9F',

      shadowCard: '0 0 0 rgba(0,0,0,0)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.04)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  purple: {
    name: 'purple',
    label: '优雅紫',
    colors: {
      primary: '#6B3FA0',
      primaryHover: '#563280',
      primaryActive: '#412660',

      canvas: '#FBFBFA',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#111111',
      textSecondary: '#787774',
      textTertiary: '#A8A8A5',

      border: '#EAEAEA',
      divider: 'rgba(0,0,0,0.06)',

      accentRed: '#9F2F2D',
      accentRedBg: '#FDEBEC',
      accentBlue: '#1F6C9F',
      accentBlueBg: '#E1F3FE',
      accentGreen: '#346538',
      accentGreenBg: '#EDF3EC',
      accentYellow: '#956400',
      accentYellowBg: '#FBF3DB',

      success: '#346538',
      error: '#9F2F2D',
      warning: '#956400',
      info: '#6B3FA0',

      shadowCard: '0 0 0 rgba(0,0,0,0)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.04)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  green: {
    name: 'green',
    label: '清新绿',
    colors: {
      primary: '#346538',
      primaryHover: '#2A522D',
      primaryActive: '#1F3E22',

      canvas: '#FBFBFA',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#111111',
      textSecondary: '#787774',
      textTertiary: '#A8A8A5',

      border: '#EAEAEA',
      divider: 'rgba(0,0,0,0.06)',

      accentRed: '#9F2F2D',
      accentRedBg: '#FDEBEC',
      accentBlue: '#1F6C9F',
      accentBlueBg: '#E1F3FE',
      accentGreen: '#346538',
      accentGreenBg: '#EDF3EC',
      accentYellow: '#956400',
      accentYellowBg: '#FBF3DB',

      success: '#346538',
      error: '#9F2F2D',
      warning: '#956400',
      info: '#1F6C9F',

      shadowCard: '0 0 0 rgba(0,0,0,0)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.04)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  dark: {
    name: 'dark',
    label: '暗黑',
    colors: {
      primary: '#4A9EFF',
      primaryHover: '#6BB0FF',
      primaryActive: '#2E8AFF',

      canvas: '#0A0A0A',
      surface: '#141414',
      elevated: '#1F1F1F',

      textPrimary: '#FFFFFF',
      textSecondary: '#A8A8A5',
      textTertiary: '#6B6B68',

      border: '#2A2A2A',
      divider: 'rgba(255,255,255,0.08)',

      accentRed: '#FF6B6B',
      accentRedBg: '#2A1A1A',
      accentBlue: '#4A9EFF',
      accentBlueBg: '#1A2A3A',
      accentGreen: '#6BCF7E',
      accentGreenBg: '#1A2A1A',
      accentYellow: '#FFB84A',
      accentYellowBg: '#2A2A1A',

      success: '#6BCF7E',
      error: '#FF6B6B',
      warning: '#FFB84A',
      info: '#4A9EFF',

      shadowCard: '0 0 0 rgba(0,0,0,0)',
      shadowHover: '0 4px 16px rgba(0,0,0,0.3)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  frost: {
    name: 'frost',
    label: '冰蓝',
    colors: {
      primary: '#4B7CF3',
      primaryHover: '#3B6CE3',
      primaryActive: '#2B5CD3',

      // 标志性冰蓝底色 —— 区别于所有其他主题的纯白底
      canvas: '#EBF0F8',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#1E2A4A',
      textSecondary: '#64748B',
      textTertiary: '#94A3B8',

      border: '#DDE5F0',
      divider: 'rgba(75,124,243,0.08)',

      // accentRedBg 被 .nav-item.active 用作背景色，冰蓝主题复用为蓝色激活态
      accentRed: '#DC2626',
      accentRedBg: '#EEF2FF',
      accentBlue: '#4B7CF3',
      accentBlueBg: '#EEF2FF',
      accentGreen: '#16A34A',
      accentGreenBg: '#DCFCE7',
      accentYellow: '#D97706',
      accentYellowBg: '#FEF3C7',

      success: '#16A34A',
      error: '#DC2626',
      warning: '#D97706',
      info: '#4B7CF3',

      shadowCard: '0 1px 4px rgba(75,124,243,0.08)',
      shadowHover: '0 4px 16px rgba(75,124,243,0.16)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  macos: {
    name: 'macos',
    label: 'macOS 玻璃',
    colors: {
      primary: '#0A84FF',
      primaryHover: '#0071E3',
      primaryActive: '#005AC1',

      canvas: '#E8EBF0',
      surface: 'rgba(255,255,255,0.62)',
      elevated: 'rgba(255,255,255,0.85)',

      textPrimary: '#1D1D1F',
      textSecondary: '#6E6E73',
      textTertiary: '#86868B',

      border: 'rgba(0,0,0,0.08)',
      divider: 'rgba(0,0,0,0.06)',

      accentRed: '#FF3B30',
      accentRedBg: 'rgba(255,59,48,0.12)',
      accentBlue: '#0A84FF',
      accentBlueBg: 'rgba(10,132,255,0.12)',
      accentGreen: '#34C759',
      accentGreenBg: 'rgba(52,199,89,0.12)',
      accentYellow: '#FF9F0A',
      accentYellowBg: 'rgba(255,159,10,0.14)',

      success: '#34C759',
      error: '#FF3B30',
      warning: '#FF9F0A',
      info: '#0A84FF',

      shadowCard: '0 8px 30px rgba(0,0,0,0.10)',
      shadowHover: '0 16px 40px rgba(0,0,0,0.16)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },

  elegant: {
    name: 'elegant',
    label: '精致现代',
    colors: {
      primary: '#6366F1',
      primaryHover: '#4F46E5',
      primaryActive: '#4338CA',

      // 暖白画布 + 纯白卡片，柔和层次
      canvas: '#F6F5F4',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#201F1D',
      textSecondary: '#6E6A64',
      textTertiary: '#A8A39B',

      border: '#E8E4DE',
      divider: 'rgba(99,102,241,0.08)',

      accentRed: '#E5484D',
      accentRedBg: '#FDECEC',
      accentBlue: '#3E63DD',
      accentBlueBg: '#EEF2FE',
      accentGreen: '#30A46C',
      accentGreenBg: '#E9F9F1',
      accentYellow: '#F5A524',
      accentYellowBg: '#FEF6E6',

      success: '#30A46C',
      error: '#E5484D',
      warning: '#F5A524',
      info: '#3E63DD',

      shadowCard: '0 1px 2px rgba(32,31,29,0.04), 0 4px 16px rgba(32,31,29,0.06)',
      shadowHover: '0 2px 4px rgba(32,31,29,0.05), 0 12px 32px rgba(99,102,241,0.14)',
    },
    typography: {
      fontSans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'JetBrains Mono', 'SF Mono', 'Consolas', monospace",
    },
  },

  glass: {
    name: 'glass',
    label: '玻璃拟态',
    colors: {
      primary: '#0EA5E9',
      primaryHover: '#0284C7',
      primaryActive: '#0369A1',

      // 深色渐变底 + 半透明白卡片（毛玻璃）
      canvas: '#0F172A',
      surface: 'rgba(255,255,255,0.07)',
      elevated: 'rgba(255,255,255,0.12)',

      textPrimary: '#F1F5F9',
      textSecondary: '#CBD5E1',
      textTertiary: '#94A3B8',

      border: 'rgba(255,255,255,0.12)',
      divider: 'rgba(255,255,255,0.08)',

      accentRed: '#F87171',
      accentRedBg: 'rgba(248,113,113,0.14)',
      accentBlue: '#38BDF8',
      accentBlueBg: 'rgba(56,189,248,0.14)',
      accentGreen: '#4ADE80',
      accentGreenBg: 'rgba(74,222,128,0.14)',
      accentYellow: '#FBBF24',
      accentYellowBg: 'rgba(251,191,36,0.14)',

      success: '#4ADE80',
      error: '#F87171',
      warning: '#FBBF24',
      info: '#38BDF8',

      shadowCard: '0 8px 32px rgba(0,0,0,0.35)',
      shadowHover: '0 16px 48px rgba(14,165,233,0.28)',
    },
    typography: {
      fontSans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'JetBrains Mono', 'SF Mono', 'Consolas', monospace",
    },
  }, 
  minimal: {
    name: 'minimal',
    label: '极简白',
    colors: {
      primary: '#007AFF',
      primaryHover: '#0A84FF',
      primaryActive: '#0062CC',

      canvas: '#F5F5F7',
      surface: '#FFFFFF',
      elevated: '#FFFFFF',

      textPrimary: '#1D1D1F',
      textSecondary: '#6E6E73',
      textTertiary: '#86868B',

      border: 'rgba(0,0,0,0.08)',
      divider: 'rgba(0,0,0,0.06)',

      accentRed: '#FF3B30',
      accentRedBg: 'rgba(255,59,48,0.10)',
      accentBlue: '#007AFF',
      accentBlueBg: 'rgba(0,122,255,0.10)',
      accentGreen: '#34C759',
      accentGreenBg: 'rgba(52,199,89,0.12)',
      accentYellow: '#FF9500',
      accentYellowBg: 'rgba(255,149,0,0.12)',

      success: '#34C759',
      error: '#FF3B30',
      warning: '#FF9500',
      info: '#007AFF',

      shadowCard: '0 1px 3px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.04)',
      shadowHover: '0 2px 6px rgba(0,0,0,0.07), 0 12px 32px rgba(0,0,0,0.08)',
    },
    typography: {
      fontSans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
      fontSerif: "'Newsreader', 'Georgia', serif",
      fontMono: "'SF Mono', 'Consolas', monospace",
    },
  },
};