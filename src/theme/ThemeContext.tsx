import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import { themes } from './themes';
import type { Theme } from './themes';

interface ThemeContextType {
  currentTheme: string;
  theme: Theme;
  setTheme: (themeName: string) => void;
  availableThemes: typeof themes;
  lowFx: boolean;
  setLowFx: (v: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
};

interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [currentTheme, setCurrentTheme] = useState<string>(() => {
    return localStorage.getItem('app-theme') || 'red';
  });
  // 低特效模式（兼容低配/远程桌面/老 WebView2 环境）：关毛玻璃 + 关动画，根治"界面发灰卡住/弹窗打不开"
  const [lowFx, setLowFxState] = useState<boolean>(() => localStorage.getItem('app-lowfx') === '1');

  const theme = themes[currentTheme] || themes.red;

  useEffect(() => {
    // 应用CSS变量到文档根元素
    const root = document.documentElement;

    // 写入 data-theme 属性，供主题专属 CSS 使用
    root.setAttribute('data-theme', currentTheme);
    // 低特效模式属性（CSS 见 index.css §14 低特效模式）
    root.setAttribute('data-lowfx', lowFx ? 'on' : 'off');

    // 颜色变量
    Object.entries(theme.colors).forEach(([key, value]) => {
      const cssVarName = `--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
      root.style.setProperty(cssVarName, value);
    });

    // 字体变量
    root.style.setProperty('--font-sans', theme.typography.fontSans);
    root.style.setProperty('--font-serif', theme.typography.fontSerif);
    root.style.setProperty('--font-mono', theme.typography.fontMono);

    // 应用body背景色（macOS主题用CSS渐变，其余用背景色）
    if (currentTheme === 'macos') {
      document.body.style.backgroundColor = 'transparent';
    } else {
      document.body.style.backgroundColor = theme.colors.canvas;
    }
    document.body.style.color = theme.colors.textPrimary;
    document.body.style.fontFamily = theme.typography.fontSans;

    // 保存到localStorage
    localStorage.setItem('app-theme', currentTheme);
  }, [currentTheme, theme]);

  const setTheme = (themeName: string) => {
    if (themes[themeName]) {
      setCurrentTheme(themeName);
    }
  };
  const setLowFx = (v: boolean) => {
    setLowFxState(v);
    localStorage.setItem('app-lowfx', v ? '1' : '0');
  };

  // Ant Design 主题配置（适配minimalist设计）
  const antdThemeConfig = {
    token: {
      colorPrimary: theme.colors.primary,
      colorSuccess: theme.colors.success,
      colorWarning: theme.colors.warning,
      colorError: theme.colors.error,
      colorInfo: theme.colors.info,

      colorBgBase: theme.colors.surface,
      colorBgContainer: theme.colors.surface,
      colorBgElevated: theme.colors.elevated,
      colorBgLayout: theme.colors.canvas,

      colorText: theme.colors.textPrimary,
      colorTextSecondary: theme.colors.textSecondary,
      colorTextTertiary: theme.colors.textTertiary,
      colorTextDisabled: theme.colors.textTertiary,

      colorBorder: theme.colors.border,
      colorBorderSecondary: theme.colors.border,

      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,

      boxShadow: theme.colors.shadowCard,
      boxShadowSecondary: theme.colors.shadowHover,

      fontFamily: theme.typography.fontSans,
      fontFamilyCode: theme.typography.fontMono,

      // Ultra-flat design
      lineWidth: 1,
      lineType: 'solid',

      // 增加行高提升可读性
      lineHeight: 1.6,
      lineHeightHeading1: 1.2,
      lineHeightHeading2: 1.3,
    },
    algorithm: currentTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    components: {
      Button: {
        primaryShadow: 'none',
        dangerShadow: 'none',
        defaultShadow: 'none',
      },
      Card: {
        boxShadow: theme.colors.shadowCard,
        boxShadowHover: theme.colors.shadowHover,
      },
      Table: {
        headerBg: theme.colors.surface,
        rowHoverBg: currentTheme === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
      },
    },
  };

  return (
    <ThemeContext.Provider value={{ currentTheme, theme, setTheme, availableThemes: themes, lowFx, setLowFx }}>
      <ConfigProvider theme={antdThemeConfig}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
};
