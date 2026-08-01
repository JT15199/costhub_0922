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
};
