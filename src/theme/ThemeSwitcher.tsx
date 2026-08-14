import React from 'react';
import { Dropdown, Button, Space } from 'antd';
import { BgColorsOutlined, CheckOutlined } from '@ant-design/icons';
import { useTheme } from './ThemeContext';
import type { MenuProps } from 'antd';

export const ThemeSwitcher: React.FC = () => {
  const { currentTheme, setTheme, availableThemes } = useTheme();

  const items: MenuProps['items'] = Object.values(availableThemes).map((theme) => ({
    key: theme.name,
    label: (
      <Space>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: theme.colors.primary,
            border: '2px solid #fff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          }}
        />
        <span>{theme.label}</span>
        {currentTheme === theme.name && <CheckOutlined style={{ color: theme.colors.primary }} />}
      </Space>
    ),
    onClick: () => setTheme(theme.name),
  }));

  return (
    <Dropdown menu={{ items }} placement="bottomRight" trigger={['click']}>
      <Button icon={<BgColorsOutlined />} type="text">
        主题
      </Button>
    </Dropdown>
  );
};
